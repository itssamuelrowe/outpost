import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { addMilliseconds, compareDesc, isAfter } from "date-fns";

import { compareLeaseFreedom } from "../utilities/cron.utility.js";
import type { CronScheduleStatus } from "../enums/cron-schedule-status.enum.js";
import type { EventType } from "../enums/event-type.enum.js";
import { ScheduleStatus } from "../enums/schedule-status.enum.js";
import { StepStatus } from "../enums/step-status.enum.js";
import { WorkflowStatus } from "../enums/workflow-status.enum.js";
import type { AuditEvent } from "../entities/audit-event.entity.js";
import type { ClaimResult } from "../entities/claim-result.entity.js";
import type { CronSchedule } from "../entities/cron-schedule.entity.js";
import type { Schedule } from "../entities/schedule.entity.js";
import type { Step } from "../entities/step.entity.js";
import type { Workflow } from "../entities/workflow.entity.js";
import type { StorageAdapter, WorkflowFilter } from "../interfaces/storage-adapter.interface.js";

/**
 * A file-backed implementation of {@link StorageAdapter}, shipped as part of the
 * core library for tests and examples that must survive a process restart.
 *
 * It is the durable sibling of {@link MemoryStorage}: it models the identical
 * lease and fence-token semantics, but persists the whole store to a single
 * JSON file instead of holding it in process memory. That difference is what
 * lets a workflow suspend at a durable sleep in one process and resume in
 * another, so it is the natural adapter for demonstrating and testing crash
 * recovery without provisioning a database.
 *
 * It is deliberately simple: every operation reads and rewrites the entire
 * file, and there is no cross-process locking, so it assumes a single writer at
 * a time. It is emphatically not for production; a real deployment uses the
 * MySQL adapter. Dates are stored as ISO strings and binary buffers as base64.
 */
export class JsonFileStorage implements StorageAdapter {
    private readonly filePath: string;
    private readonly now: () => Date;

    public constructor(filePath: string, now: () => Date = () => new Date()) {
        this.filePath = filePath;
        this.now = now;
    }

    /**
     * Composes the composite primary key used to index steps and sleep timers.
     */
    private composeStepKey(workflowIdentifier: string, stepKey: string): string {
        return `${workflowIdentifier}\u0000${stepKey}`;
    }

    /**
     * Reads and deserializes the whole store, returning an empty store if
     * absent.
     */
    private read(): PersistedState {
        if (!existsSync(this.filePath)) {
            return {
                workflows: {},
                steps: {},
                schedules: [],
                cronSchedules: {},
                sleepTimers: {},
                events: [],
                nextScheduleIdentifier: 1,
                nextEventIdentifier: 1,
            };
        }
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedState;
        // Tolerate stores written before cron support existed.
        parsed.cronSchedules ??= {};
        return parsed;
    }

    /**
     * Serializes and writes the whole store back to disk.
     */
    private write(state: PersistedState): void {
        writeFileSync(this.filePath, JSON.stringify(state, null, 2), "utf8");
    }

    public async ensureWorkflow(
        workflowIdentifier: string,
        workflowName: string,
        input: Buffer | null,
        parentWorkflowIdentifier: string | null = null,
    ): Promise<void> {
        const state = this.read();
        if (!state.workflows[workflowIdentifier]) {
            const timestamp = this.now().toISOString();
            state.workflows[workflowIdentifier] = {
                workflowIdentifier,
                workflowName,
                parentWorkflowIdentifier,
                status: WorkflowStatus.RUNNING,
                input: encodeBuffer(input),
                output: null,
                error: null,
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            this.write(state);
        }
    }

    public async setWorkflowStatus(
        workflowIdentifier: string,
        status: WorkflowStatus,
        fields?: { output?: Buffer | null; error?: string | null },
    ): Promise<void> {
        const state = this.read();
        const workflow = state.workflows[workflowIdentifier];
        if (!workflow) {
            return;
        }
        workflow.status = status;
        if (fields && "output" in fields) {
            workflow.output = encodeBuffer(fields.output ?? null);
        }
        if (fields && "error" in fields) {
            workflow.error = fields.error ?? null;
        }
        workflow.updatedAt = this.now().toISOString();
        this.write(state);
    }

    public async getWorkflow(workflowIdentifier: string): Promise<Workflow | null> {
        const state = this.read();
        const raw = state.workflows[workflowIdentifier];
        return raw ? deserializeWorkflow(raw) : null;
    }

    public async listWorkflows(filter: WorkflowFilter): Promise<Workflow[]> {
        const state = this.read();
        const limit = filter.limit ?? 100;
        const matches = Object.values(state.workflows)
            .map((raw) => deserializeWorkflow(raw))
            .filter((workflow) => {
                if (filter.statuses && !filter.statuses.includes(workflow.status)) {
                    return false;
                }
                if (
                    filter.workflowName !== undefined &&
                    workflow.workflowName !== filter.workflowName
                ) {
                    return false;
                }
                if (
                    filter.parentWorkflowIdentifier !== undefined &&
                    workflow.parentWorkflowIdentifier !== filter.parentWorkflowIdentifier
                ) {
                    return false;
                }
                if (filter.createdAfter && isAfter(filter.createdAfter, workflow.createdAt)) {
                    return false;
                }
                if (filter.createdBefore && isAfter(workflow.createdAt, filter.createdBefore)) {
                    return false;
                }
                return true;
            });
        // Most recently updated first, matching the documented ordering.
        matches.sort((a, b) => compareDesc(a.updatedAt, b.updatedAt));
        return matches.slice(0, limit);
    }

    public async claimStep(
        workflowIdentifier: string,
        stepKey: string,
        maxAttempts: number,
        leaseMilliseconds: number,
    ): Promise<ClaimResult> {
        const state = this.read();
        const mapKey = this.composeStepKey(workflowIdentifier, stepKey);
        const currentInstant = this.now();
        let step = state.steps[mapKey];

        if (!step) {
            const iso = currentInstant.toISOString();
            step = {
                workflowIdentifier,
                stepKey,
                status: StepStatus.PENDING,
                attempts: 0,
                maxAttempts,
                output: null,
                lastError: null,
                fenceToken: 0,
                lockedUntil: null,
                completedAt: null,
                createdAt: iso,
                updatedAt: iso,
            };
            state.steps[mapKey] = step;
        }

        if (step.status === StepStatus.COMPLETED || step.status === StepStatus.FAILED_OPTIONAL) {
            return {
                claimed: false,
                cachedResult: {
                    output: decodeBuffer(step.output),
                    completedAt: step.completedAt ? new Date(step.completedAt) : null,
                },
                attempt: step.attempts,
                fenceToken: step.fenceToken,
                priorStatus: step.status,
            };
        }

        const leaseIsLive =
            step.status === StepStatus.RUNNING &&
            step.lockedUntil !== null &&
            isAfter(new Date(step.lockedUntil), currentInstant);
        if (leaseIsLive) {
            return {
                claimed: false,
                attempt: step.attempts,
                fenceToken: step.fenceToken,
                priorStatus: step.status,
            };
        }

        const priorStatus = step.status;
        step.attempts += 1;
        step.fenceToken += 1;
        step.status = StepStatus.RUNNING;
        step.lockedUntil = addMilliseconds(currentInstant, leaseMilliseconds).toISOString();
        step.updatedAt = currentInstant.toISOString();
        this.write(state);

        return {
            claimed: true,
            attempt: step.attempts,
            fenceToken: step.fenceToken,
            priorStatus,
        };
    }

    public async commitStep(
        workflowIdentifier: string,
        stepKey: string,
        fenceToken: number,
        output: Buffer | null,
        status: StepStatus,
    ): Promise<boolean> {
        const state = this.read();
        const step = state.steps[this.composeStepKey(workflowIdentifier, stepKey)];
        if (!step || step.fenceToken !== fenceToken) {
            return false;
        }
        const iso = this.now().toISOString();
        step.status = status;
        step.output = encodeBuffer(output);
        step.lockedUntil = null;
        step.completedAt = iso;
        step.updatedAt = iso;
        this.write(state);
        return true;
    }

    public async failStep(
        workflowIdentifier: string,
        stepKey: string,
        fenceToken: number,
        error: string,
        status: StepStatus,
        retryAt: Date | null,
    ): Promise<boolean> {
        const state = this.read();
        const step = state.steps[this.composeStepKey(workflowIdentifier, stepKey)];
        if (!step || step.fenceToken !== fenceToken) {
            return false;
        }
        step.lastError = error;
        step.lockedUntil = null;
        step.updatedAt = this.now().toISOString();
        if (retryAt) {
            // Preserve the ambiguous status across a retry so recovery probes; a
            // definite retryable failure returns to the pending state.
            step.status =
                status === StepStatus.AMBIGUOUS ? StepStatus.AMBIGUOUS : StepStatus.PENDING;
            state.schedules.push({
                scheduleIdentifier: state.nextScheduleIdentifier++,
                workflowIdentifier,
                stepKey,
                runAt: retryAt.toISOString(),
                status: ScheduleStatus.PENDING,
                payload: null,
                createdAt: this.now().toISOString(),
            });
        } else {
            step.status = status;
        }
        this.write(state);
        return true;
    }

    public async releaseStep(
        workflowIdentifier: string,
        stepKey: string,
        fenceToken: number,
    ): Promise<boolean> {
        const state = this.read();
        const step = state.steps[this.composeStepKey(workflowIdentifier, stepKey)];
        if (!step || step.fenceToken !== fenceToken) {
            return false;
        }
        // Only a step that is currently running under this lease can be released.
        if (step.status !== StepStatus.RUNNING) {
            return false;
        }
        step.status = StepStatus.PENDING;
        step.lockedUntil = null;
        step.updatedAt = this.now().toISOString();
        this.write(state);
        return true;
    }

    public async ensureSleepTimer(
        workflowIdentifier: string,
        timerKey: string,
        runAt: Date,
    ): Promise<{ runAt: Date }> {
        const state = this.read();
        const mapKey = this.composeStepKey(workflowIdentifier, timerKey);
        const existing = state.sleepTimers[mapKey];
        if (existing) {
            return { runAt: new Date(existing) };
        }
        state.sleepTimers[mapKey] = runAt.toISOString();
        // Also record a schedule so the embedded scheduler can dispatch a resume
        // when the sleep becomes due.
        state.schedules.push({
            scheduleIdentifier: state.nextScheduleIdentifier++,
            workflowIdentifier,
            stepKey: timerKey,
            runAt: runAt.toISOString(),
            status: ScheduleStatus.PENDING,
            payload: null,
            createdAt: this.now().toISOString(),
        });
        this.write(state);
        return { runAt };
    }

    public async scheduleTimer(
        workflowIdentifier: string,
        stepKey: string | null,
        runAt: Date,
        payload: string | null,
    ): Promise<void> {
        const state = this.read();
        state.schedules.push({
            scheduleIdentifier: state.nextScheduleIdentifier++,
            workflowIdentifier,
            stepKey,
            runAt: runAt.toISOString(),
            status: ScheduleStatus.PENDING,
            payload,
            createdAt: this.now().toISOString(),
        });
        this.write(state);
    }

    public async claimDueTimers(
        now: Date,
        limit: number,
    ): Promise<
        Array<{
            scheduleIdentifier: number;
            workflowIdentifier: string;
            stepKey: string | null;
            payload: string | null;
        }>
    > {
        const state = this.read();
        const dueTimers = state.schedules
            .filter(
                (schedule) =>
                    schedule.status === ScheduleStatus.PENDING &&
                    !isAfter(new Date(schedule.runAt), now),
            )
            .slice(0, limit);

        for (const timer of dueTimers) {
            timer.status = ScheduleStatus.PROCESSED;
        }
        if (dueTimers.length > 0) {
            this.write(state);
        }

        return dueTimers.map((timer) => ({
            scheduleIdentifier: timer.scheduleIdentifier,
            workflowIdentifier: timer.workflowIdentifier,
            stepKey: timer.stepKey,
            payload: timer.payload,
        }));
    }

    public async setTimerStatus(scheduleIdentifier: number, status: ScheduleStatus): Promise<void> {
        const state = this.read();
        const timer = state.schedules.find(
            (schedule) => schedule.scheduleIdentifier === scheduleIdentifier,
        );
        if (timer) {
            timer.status = status;
            this.write(state);
        }
    }

    public async logEvent(
        workflowIdentifier: string,
        stepKey: string | null,
        eventType: EventType,
        details: Record<string, unknown>,
    ): Promise<void> {
        const state = this.read();
        state.events.push({
            identifier: state.nextEventIdentifier++,
            workflowIdentifier,
            stepKey,
            eventType,
            details: JSON.stringify(details),
            createdAt: this.now().toISOString(),
        });
        this.write(state);
    }

    public async upsertCronSchedule(schedule: CronSchedule): Promise<void> {
        const state = this.read();
        const existing = state.cronSchedules[schedule.name];
        if (existing) {
            // Preserve firing history so re-registering on boot is a no-op.
            existing.cronExpression = schedule.cronExpression;
            existing.timeZone = schedule.timeZone;
            existing.workflowName = schedule.workflowName;
            existing.payload = schedule.payload;
            existing.catchUp = schedule.catchUp;
            existing.updatedAt = this.now().toISOString();
        } else {
            state.cronSchedules[schedule.name] = serializeCronSchedule(schedule);
        }
        this.write(state);
    }

    public async getCronSchedule(name: string): Promise<CronSchedule | null> {
        const raw = this.read().cronSchedules[name];
        return raw ? deserializeCronSchedule(raw) : null;
    }

    public async listCronSchedules(): Promise<CronSchedule[]> {
        return Object.values(this.read().cronSchedules).map(deserializeCronSchedule);
    }

    public async claimDueCronSchedules(
        now: Date,
        limit: number,
        computeNextRunAt: (schedule: CronSchedule, firedAt: Date) => Date,
        owner?: string,
    ): Promise<Array<{ schedule: CronSchedule; firedAt: Date }>> {
        const state = this.read();
        const claimed: Array<{ schedule: CronSchedule; firedAt: Date }> = [];
        let mutated = false;

        for (const raw of Object.values(state.cronSchedules)) {
            if (claimed.length >= limit) {
                break;
            }
            if (raw.status !== "ACTIVE") {
                continue;
            }
            // Under the ownership model, only fire schedules this process owns live.
            if (owner !== undefined) {
                const ownedLive =
                    raw.leaseOwner === owner &&
                    raw.leaseExpiresAt !== null &&
                    isAfter(new Date(raw.leaseExpiresAt), now);
                if (!ownedLive) {
                    continue;
                }
            }
            if (isAfter(new Date(raw.nextRunAt), now)) {
                continue;
            }

            const snapshot = deserializeCronSchedule(raw);
            const firedAt = snapshot.nextRunAt;
            raw.lastRunAt = firedAt.toISOString();
            raw.nextRunAt = computeNextRunAt(snapshot, firedAt).toISOString();
            raw.updatedAt = this.now().toISOString();
            mutated = true;

            claimed.push({ schedule: snapshot, firedAt });
        }

        if (mutated) {
            this.write(state);
        }
        return claimed;
    }

    public async setCronScheduleStatus(name: string, status: CronScheduleStatus): Promise<boolean> {
        const state = this.read();
        const raw = state.cronSchedules[name];
        if (!raw) {
            return false;
        }
        raw.status = status;
        raw.updatedAt = this.now().toISOString();
        this.write(state);
        return true;
    }

    public async removeCronSchedule(name: string): Promise<boolean> {
        const state = this.read();
        if (!state.cronSchedules[name]) {
            return false;
        }
        delete state.cronSchedules[name];
        this.write(state);
        return true;
    }

    public async renewCronLeases(owner: string, expiresAt: Date): Promise<number> {
        const state = this.read();
        let renewed = 0;
        for (const raw of Object.values(state.cronSchedules)) {
            if (raw.leaseOwner === owner) {
                raw.leaseExpiresAt = expiresAt.toISOString();
                raw.updatedAt = this.now().toISOString();
                renewed += 1;
            }
        }
        if (renewed > 0) {
            this.write(state);
        }
        return renewed;
    }

    public async acquireCronSchedules(
        owner: string,
        now: Date,
        expiresAt: Date,
        limit: number,
    ): Promise<CronSchedule[]> {
        if (limit <= 0) {
            return [];
        }
        const state = this.read();
        const candidates = Object.values(state.cronSchedules)
            .filter(
                (raw) =>
                    raw.leaseOwner === null ||
                    raw.leaseExpiresAt === null ||
                    !isAfter(new Date(raw.leaseExpiresAt), now),
            )
            // Never-owned (null lease) sorts first, then by oldest expiry.
            .sort((a, b) =>
                compareLeaseFreedom(
                    a.leaseExpiresAt ? new Date(a.leaseExpiresAt) : null,
                    b.leaseExpiresAt ? new Date(b.leaseExpiresAt) : null,
                ),
            )
            .slice(0, limit);

        for (const raw of candidates) {
            raw.leaseOwner = owner;
            raw.leaseExpiresAt = expiresAt.toISOString();
            raw.updatedAt = this.now().toISOString();
        }
        if (candidates.length > 0) {
            this.write(state);
        }
        return candidates.map(deserializeCronSchedule);
    }

    public async countOwnedCronSchedules(owner: string, now: Date): Promise<number> {
        const state = this.read();
        let count = 0;
        for (const raw of Object.values(state.cronSchedules)) {
            if (
                raw.leaseOwner === owner &&
                raw.leaseExpiresAt !== null &&
                isAfter(new Date(raw.leaseExpiresAt), now)
            ) {
                count += 1;
            }
        }
        return count;
    }

    public async claimDueUnownedCronSchedules(
        now: Date,
        limit: number,
        computeNextRunAt: (schedule: CronSchedule, firedAt: Date) => Date,
    ): Promise<Array<{ schedule: CronSchedule; firedAt: Date }>> {
        const state = this.read();
        const claimed: Array<{ schedule: CronSchedule; firedAt: Date }> = [];
        let mutated = false;

        for (const raw of Object.values(state.cronSchedules)) {
            if (claimed.length >= limit) {
                break;
            }
            if (raw.status !== "ACTIVE") {
                continue;
            }
            const isUnowned =
                raw.leaseOwner === null ||
                raw.leaseExpiresAt === null ||
                !isAfter(new Date(raw.leaseExpiresAt), now);
            if (!isUnowned) {
                continue;
            }
            if (isAfter(new Date(raw.nextRunAt), now)) {
                continue;
            }

            const snapshot = deserializeCronSchedule(raw);
            const firedAt = snapshot.nextRunAt;
            raw.lastRunAt = firedAt.toISOString();
            raw.nextRunAt = computeNextRunAt(snapshot, firedAt).toISOString();
            raw.updatedAt = this.now().toISOString();
            mutated = true;

            claimed.push({ schedule: snapshot, firedAt });
        }

        if (mutated) {
            this.write(state);
        }
        return claimed;
    }

    public async releaseCronLeases(owner: string): Promise<number> {
        const state = this.read();
        let released = 0;
        for (const raw of Object.values(state.cronSchedules)) {
            if (raw.leaseOwner === owner) {
                raw.leaseOwner = null;
                raw.leaseExpiresAt = null;
                raw.updatedAt = this.now().toISOString();
                released += 1;
            }
        }
        if (released > 0) {
            this.write(state);
        }
        return released;
    }

    /**
     * Returns the current state of a step, for use in tests.
     */
    public getStep(workflowIdentifier: string, stepKey: string): Step | undefined {
        const state = this.read();
        const raw = state.steps[this.composeStepKey(workflowIdentifier, stepKey)];
        return raw ? deserializeStep(raw) : undefined;
    }

    /**
     * Returns a snapshot of everything currently persisted: workflows, steps,
     * schedules, and audit events.
     *
     * This mirrors {@link MemoryStorage.dump} so the two adapters are
     * interchangeable in tests and examples that inspect or print the complete
     * durable state after a run.
     */
    public dump(): {
        workflows: Workflow[];
        steps: Step[];
        schedules: Schedule[];
        cronSchedules: CronSchedule[];
        events: AuditEvent[];
    } {
        const state = this.read();
        return {
            workflows: Object.values(state.workflows).map(deserializeWorkflow),
            steps: Object.values(state.steps).map(deserializeStep),
            schedules: state.schedules.map(deserializeSchedule),
            cronSchedules: Object.values(state.cronSchedules).map(deserializeCronSchedule),
            events: state.events.map(deserializeEvent),
        };
    }
}

/**
 * The complete on-disk shape. Dates are ISO strings; buffers are base64.
 */
interface PersistedState {
    workflows: Record<string, RawWorkflow>;
    steps: Record<string, RawStep>;
    schedules: RawSchedule[];
    cronSchedules: Record<string, RawCronSchedule>;
    sleepTimers: Record<string, string>;
    events: RawEvent[];
    nextScheduleIdentifier: number;
    nextEventIdentifier: number;
}

interface RawWorkflow {
    workflowIdentifier: string;
    workflowName: string;
    parentWorkflowIdentifier?: string | null;
    status: WorkflowStatus;
    input: string | null;
    output: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

interface RawStep {
    workflowIdentifier: string;
    stepKey: string;
    status: StepStatus;
    attempts: number;
    maxAttempts: number;
    output: string | null;
    lastError: string | null;
    fenceToken: number;
    lockedUntil: string | null;
    completedAt: string | null;
    createdAt: string;
    updatedAt: string;
}

interface RawSchedule {
    scheduleIdentifier: number;
    workflowIdentifier: string;
    stepKey: string | null;
    runAt: string;
    status: ScheduleStatus;
    payload: string | null;
    createdAt: string;
}

interface RawEvent {
    identifier: number;
    workflowIdentifier: string;
    stepKey: string | null;
    eventType: EventType;
    details: string;
    createdAt: string;
}

interface RawCronSchedule {
    name: string;
    cronExpression: string;
    timeZone: string | null;
    workflowName: string;
    payload: string | null;
    catchUp: boolean;
    status: CronScheduleStatus;
    nextRunAt: string;
    lastRunAt: string | null;
    leaseOwner: string | null;
    leaseExpiresAt: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * Encodes a binary buffer as base64 for JSON storage.
 */
function encodeBuffer(buffer: Buffer | null): string | null {
    return buffer === null ? null : buffer.toString("base64");
}

/**
 * Decodes a base64 string back into a binary buffer.
 */
function decodeBuffer(raw: string | null): Buffer | null {
    return raw === null ? null : Buffer.from(raw, "base64");
}

function deserializeWorkflow(raw: RawWorkflow): Workflow {
    return {
        workflowIdentifier: raw.workflowIdentifier,
        workflowName: raw.workflowName,
        parentWorkflowIdentifier: raw.parentWorkflowIdentifier ?? null,
        status: raw.status,
        input: decodeBuffer(raw.input),
        output: decodeBuffer(raw.output),
        error: raw.error,
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
    };
}

function deserializeStep(raw: RawStep): Step {
    return {
        workflowIdentifier: raw.workflowIdentifier,
        stepKey: raw.stepKey,
        status: raw.status,
        attempts: raw.attempts,
        maxAttempts: raw.maxAttempts,
        output: decodeBuffer(raw.output),
        lastError: raw.lastError,
        fenceToken: raw.fenceToken,
        lockedUntil: raw.lockedUntil ? new Date(raw.lockedUntil) : null,
        completedAt: raw.completedAt ? new Date(raw.completedAt) : null,
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
    };
}

function deserializeSchedule(raw: RawSchedule): Schedule {
    return {
        scheduleIdentifier: raw.scheduleIdentifier,
        workflowIdentifier: raw.workflowIdentifier,
        stepKey: raw.stepKey,
        runAt: new Date(raw.runAt),
        status: raw.status,
        payload: raw.payload,
        createdAt: new Date(raw.createdAt),
    };
}

function deserializeEvent(raw: RawEvent): AuditEvent {
    return {
        identifier: raw.identifier,
        workflowIdentifier: raw.workflowIdentifier,
        stepKey: raw.stepKey,
        eventType: raw.eventType,
        details: raw.details,
        createdAt: new Date(raw.createdAt),
    };
}

function serializeCronSchedule(schedule: CronSchedule): RawCronSchedule {
    return {
        name: schedule.name,
        cronExpression: schedule.cronExpression,
        timeZone: schedule.timeZone,
        workflowName: schedule.workflowName,
        payload: schedule.payload,
        catchUp: schedule.catchUp,
        status: schedule.status,
        nextRunAt: schedule.nextRunAt.toISOString(),
        lastRunAt: schedule.lastRunAt ? schedule.lastRunAt.toISOString() : null,
        leaseOwner: schedule.leaseOwner,
        leaseExpiresAt: schedule.leaseExpiresAt ? schedule.leaseExpiresAt.toISOString() : null,
        createdAt: schedule.createdAt.toISOString(),
        updatedAt: schedule.updatedAt.toISOString(),
    };
}

function deserializeCronSchedule(raw: RawCronSchedule): CronSchedule {
    return {
        name: raw.name,
        cronExpression: raw.cronExpression,
        timeZone: raw.timeZone,
        workflowName: raw.workflowName,
        payload: raw.payload,
        catchUp: raw.catchUp,
        status: raw.status,
        nextRunAt: new Date(raw.nextRunAt),
        lastRunAt: raw.lastRunAt ? new Date(raw.lastRunAt) : null,
        // Tolerate stores written before ownership leases existed.
        leaseOwner: raw.leaseOwner ?? null,
        leaseExpiresAt: raw.leaseExpiresAt ? new Date(raw.leaseExpiresAt) : null,
        createdAt: new Date(raw.createdAt),
        updatedAt: new Date(raw.updatedAt),
    };
}
