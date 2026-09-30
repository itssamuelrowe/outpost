import { existsSync, readFileSync, writeFileSync } from "node:fs";

import { addMilliseconds, compareDesc, isAfter } from "date-fns";

import { CronUtility } from "../utilities/cron.utility.js";
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

/*
 * The on-disk representation lives at the top of the file so the persisted
 * shape is the first thing a reader encounters. Everything below, both the
 * public adapter methods and the private serialization helpers, is written in
 * terms of these interfaces. Two conventions hold throughout: dates are stored
 * as ISO 8601 strings and binary buffers are stored as base64. Deserialization
 * reverses both at read time.
 */

/**
 * The complete shape of the JSON document written to disk.
 *
 * Every field is a plain, JSON-friendly value: dates are ISO strings and
 * buffers are base64. The `nextScheduleId` and `nextEventId` counters give the
 * file a self-contained source of monotonically increasing identifiers, so no
 * external sequence is required.
 */
interface PersistedState {
    workflows: Record<string, RawWorkflow>;
    steps: Record<string, RawStep>;
    schedules: RawSchedule[];
    cronSchedules: Record<string, RawCronSchedule>;
    sleepTimers: Record<string, string>;
    events: RawEvent[];
    nextScheduleId: number;
    nextEventId: number;
}

/**
 * The persisted form of a {@link Workflow}: identical in structure, but with
 * the input and output buffers encoded as base64 and the timestamps stored as
 * ISO strings.
 */
interface RawWorkflow {
    workflowId: string;
    workflowName: string;
    parentWorkflowId?: string | null;
    status: WorkflowStatus;
    input: string | null;
    output: string | null;
    error: string | null;
    createdAt: string;
    updatedAt: string;
}

/**
 * The persisted form of a {@link Step}. The output buffer is base64 and the
 * `lockedUntil`, `completedAt`, `createdAt`, and `updatedAt` timestamps are ISO
 * strings. The `fenceToken` is what makes commits and failures safe against a
 * stale worker that lost its lease.
 */
interface RawStep {
    workflowId: string;
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

/**
 * The persisted form of a {@link Schedule}: a timer row the embedded scheduler
 * polls to dispatch retries and durable-sleep resumes when they come due.
 */
interface RawSchedule {
    scheduleId: number;
    workflowId: string;
    stepKey: string | null;
    runAt: string;
    status: ScheduleStatus;
    payload: string | null;
    createdAt: string;
}

/**
 * The persisted form of an {@link AuditEvent}. The `details` field is a JSON
 * string so arbitrary structured metadata survives a round trip through the
 * file without a fixed schema.
 */
interface RawEvent {
    id: number;
    workflowId: string;
    stepKey: string | null;
    eventType: EventType;
    details: string;
    createdAt: string;
}

/**
 * The persisted form of a {@link CronSchedule}. Alongside the schedule
 * definition it carries the ownership lease (`leaseOwner`, `leaseExpiresAt`)
 * that lets a single process claim a schedule and fire it exclusively, plus the
 * `nextRunAt` and `lastRunAt` firing history.
 */
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
    private composeStepKey(workflowId: string, stepKey: string): string {
        return `${workflowId}\u0000${stepKey}`;
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
                nextScheduleId: 1,
                nextEventId: 1,
            };
        }
        const parsed = JSON.parse(readFileSync(this.filePath, "utf8")) as PersistedState;
        /*
         * Tolerate stores written before cron support existed: an older file
         * has no `cronSchedules` key, so default it to an empty map rather than
         * letting later reads dereference `undefined`.
         */
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
        workflowId: string,
        workflowName: string,
        input: Buffer | null,
        parentWorkflowId: string | null = null,
    ): Promise<void> {
        const state = this.read();
        if (!state.workflows[workflowId]) {
            const timestamp = this.now().toISOString();
            state.workflows[workflowId] = {
                workflowId,
                workflowName,
                parentWorkflowId,
                status: WorkflowStatus.RUNNING,
                input: JsonFileStorage.encodeBuffer(input),
                output: null,
                error: null,
                createdAt: timestamp,
                updatedAt: timestamp,
            };
            this.write(state);
        }
    }

    public async setWorkflowStatus(
        workflowId: string,
        status: WorkflowStatus,
        fields?: { output?: Buffer | null; error?: string | null },
    ): Promise<void> {
        const state = this.read();
        const workflow = state.workflows[workflowId];
        if (!workflow) {
            return;
        }
        workflow.status = status;
        if (fields && "output" in fields) {
            workflow.output = JsonFileStorage.encodeBuffer(fields.output ?? null);
        }
        if (fields && "error" in fields) {
            workflow.error = fields.error ?? null;
        }
        workflow.updatedAt = this.now().toISOString();
        this.write(state);
    }

    public async getWorkflow(workflowId: string): Promise<Workflow | null> {
        const state = this.read();
        const raw = state.workflows[workflowId];
        return raw ? JsonFileStorage.deserializeWorkflow(raw) : null;
    }

    public async listWorkflows(filter: WorkflowFilter): Promise<Workflow[]> {
        const state = this.read();
        const limit = filter.limit ?? 100;
        const matches = Object.values(state.workflows)
            .map((raw) => JsonFileStorage.deserializeWorkflow(raw))
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
                    filter.parentWorkflowId !== undefined &&
                    workflow.parentWorkflowId !== filter.parentWorkflowId
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
        /* Most recently updated first, matching the documented ordering. */
        matches.sort((a, b) => compareDesc(a.updatedAt, b.updatedAt));
        return matches.slice(0, limit);
    }

    public async claimStep(
        workflowId: string,
        stepKey: string,
        maxAttempts: number,
        leaseMilliseconds: number,
    ): Promise<ClaimResult> {
        const state = this.read();
        const mapKey = this.composeStepKey(workflowId, stepKey);
        const currentInstant = this.now();
        let step = state.steps[mapKey];

        if (!step) {
            const iso = currentInstant.toISOString();
            step = {
                workflowId,
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
                    output: JsonFileStorage.decodeBuffer(step.output),
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
        workflowId: string,
        stepKey: string,
        fenceToken: number,
        output: Buffer | null,
        status: StepStatus,
    ): Promise<boolean> {
        const state = this.read();
        const step = state.steps[this.composeStepKey(workflowId, stepKey)];
        if (!step || step.fenceToken !== fenceToken) {
            return false;
        }
        const iso = this.now().toISOString();
        step.status = status;
        step.output = JsonFileStorage.encodeBuffer(output);
        step.lockedUntil = null;
        step.completedAt = iso;
        step.updatedAt = iso;
        this.write(state);
        return true;
    }

    public async failStep(
        workflowId: string,
        stepKey: string,
        fenceToken: number,
        error: string,
        status: StepStatus,
        retryAt: Date | null,
    ): Promise<boolean> {
        const state = this.read();
        const step = state.steps[this.composeStepKey(workflowId, stepKey)];
        if (!step || step.fenceToken !== fenceToken) {
            return false;
        }
        step.lastError = error;
        step.lockedUntil = null;
        step.updatedAt = this.now().toISOString();
        if (retryAt) {
            /*
             * Preserve the ambiguous status across a retry so recovery probes
             * for a definite outcome; a plainly retryable failure returns to
             * the pending state instead.
             */
            step.status =
                status === StepStatus.AMBIGUOUS ? StepStatus.AMBIGUOUS : StepStatus.PENDING;
            state.schedules.push({
                scheduleId: state.nextScheduleId++,
                workflowId,
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
        workflowId: string,
        stepKey: string,
        fenceToken: number,
    ): Promise<boolean> {
        const state = this.read();
        const step = state.steps[this.composeStepKey(workflowId, stepKey)];
        if (!step || step.fenceToken !== fenceToken) {
            return false;
        }
        /* Only a step that is currently running under this lease can be released. */
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
        workflowId: string,
        timerKey: string,
        runAt: Date,
    ): Promise<{ runAt: Date }> {
        const state = this.read();
        const mapKey = this.composeStepKey(workflowId, timerKey);
        const existing = state.sleepTimers[mapKey];
        if (existing) {
            return { runAt: new Date(existing) };
        }
        state.sleepTimers[mapKey] = runAt.toISOString();
        /*
         * Also record a schedule so the embedded scheduler can dispatch a
         * resume when the sleep becomes due.
         */
        state.schedules.push({
            scheduleId: state.nextScheduleId++,
            workflowId,
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
        workflowId: string,
        stepKey: string | null,
        runAt: Date,
        payload: string | null,
    ): Promise<void> {
        const state = this.read();
        state.schedules.push({
            scheduleId: state.nextScheduleId++,
            workflowId,
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
            scheduleId: number;
            workflowId: string;
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
            scheduleId: timer.scheduleId,
            workflowId: timer.workflowId,
            stepKey: timer.stepKey,
            payload: timer.payload,
        }));
    }

    public async setTimerStatus(scheduleId: number, status: ScheduleStatus): Promise<void> {
        const state = this.read();
        const timer = state.schedules.find(
            (schedule) => schedule.scheduleId === scheduleId,
        );
        if (timer) {
            timer.status = status;
            this.write(state);
        }
    }

    public async logEvent(
        workflowId: string,
        stepKey: string | null,
        eventType: EventType,
        details: Record<string, unknown>,
    ): Promise<void> {
        const state = this.read();
        state.events.push({
            id: state.nextEventId++,
            workflowId,
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
            /*
             * Update the definition in place while preserving the firing
             * history and lease, so re-registering the same schedule on boot is
             * an idempotent no-op rather than a reset.
             */
            existing.cronExpression = schedule.cronExpression;
            existing.timeZone = schedule.timeZone;
            existing.workflowName = schedule.workflowName;
            existing.payload = schedule.payload;
            existing.catchUp = schedule.catchUp;
            existing.updatedAt = this.now().toISOString();
        } else {
            state.cronSchedules[schedule.name] = JsonFileStorage.serializeCronSchedule(schedule);
        }
        this.write(state);
    }

    public async getCronSchedule(name: string): Promise<CronSchedule | null> {
        const raw = this.read().cronSchedules[name];
        return raw ? JsonFileStorage.deserializeCronSchedule(raw) : null;
    }

    public async listCronSchedules(): Promise<CronSchedule[]> {
        return Object.values(this.read().cronSchedules).map((raw) =>
            JsonFileStorage.deserializeCronSchedule(raw),
        );
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
            /* Under the ownership model, only fire schedules this process owns live. */
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

            const snapshot = JsonFileStorage.deserializeCronSchedule(raw);
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
            /* Never-owned (null lease) sorts first, then by oldest expiry. */
            .sort((a, b) =>
                CronUtility.compareLeaseFreedom(
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
        return candidates.map((raw) => JsonFileStorage.deserializeCronSchedule(raw));
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

            const snapshot = JsonFileStorage.deserializeCronSchedule(raw);
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
    public getStep(workflowId: string, stepKey: string): Step | undefined {
        const state = this.read();
        const raw = state.steps[this.composeStepKey(workflowId, stepKey)];
        return raw ? JsonFileStorage.deserializeStep(raw) : undefined;
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
            workflows: Object.values(state.workflows).map((raw) =>
                JsonFileStorage.deserializeWorkflow(raw),
            ),
            steps: Object.values(state.steps).map((raw) => JsonFileStorage.deserializeStep(raw)),
            schedules: state.schedules.map((raw) => JsonFileStorage.deserializeSchedule(raw)),
            cronSchedules: Object.values(state.cronSchedules).map((raw) =>
                JsonFileStorage.deserializeCronSchedule(raw),
            ),
            events: state.events.map((raw) => JsonFileStorage.deserializeEvent(raw)),
        };
    }

    /*
     * The helpers below translate between the persisted, JSON-friendly shapes
     * above and the rich in-memory entities the rest of the library works with.
     * They are private static because they depend only on their arguments, not
     * on any instance state, and keeping them with the type namespaces the
     * concern and hides it from the public surface.
     */

    /**
     * Encodes a binary buffer as base64 for JSON storage, mapping a null buffer
     * straight through to null.
     */
    private static encodeBuffer(buffer: Buffer | null): string | null {
        return buffer === null ? null : buffer.toString("base64");
    }

    /**
     * Decodes a base64 string back into a binary buffer, mapping a null string
     * straight through to null.
     */
    private static decodeBuffer(raw: string | null): Buffer | null {
        return raw === null ? null : Buffer.from(raw, "base64");
    }

    /**
     * Rehydrates a persisted workflow row into a {@link Workflow}, decoding its
     * buffers and parsing its ISO timestamps back into `Date` instances.
     */
    private static deserializeWorkflow(raw: RawWorkflow): Workflow {
        return {
            workflowId: raw.workflowId,
            workflowName: raw.workflowName,
            parentWorkflowId: raw.parentWorkflowId ?? null,
            status: raw.status,
            input: JsonFileStorage.decodeBuffer(raw.input),
            output: JsonFileStorage.decodeBuffer(raw.output),
            error: raw.error,
            createdAt: new Date(raw.createdAt),
            updatedAt: new Date(raw.updatedAt),
        };
    }

    /**
     * Rehydrates a persisted step row into a {@link Step}, decoding its output
     * buffer and parsing its nullable and required timestamps into `Date`
     * instances.
     */
    private static deserializeStep(raw: RawStep): Step {
        return {
            workflowId: raw.workflowId,
            stepKey: raw.stepKey,
            status: raw.status,
            attempts: raw.attempts,
            maxAttempts: raw.maxAttempts,
            output: JsonFileStorage.decodeBuffer(raw.output),
            lastError: raw.lastError,
            fenceToken: raw.fenceToken,
            lockedUntil: raw.lockedUntil ? new Date(raw.lockedUntil) : null,
            completedAt: raw.completedAt ? new Date(raw.completedAt) : null,
            createdAt: new Date(raw.createdAt),
            updatedAt: new Date(raw.updatedAt),
        };
    }

    /**
     * Rehydrates a persisted schedule row into a {@link Schedule}, parsing its
     * ISO timestamps back into `Date` instances.
     */
    private static deserializeSchedule(raw: RawSchedule): Schedule {
        return {
            scheduleId: raw.scheduleId,
            workflowId: raw.workflowId,
            stepKey: raw.stepKey,
            runAt: new Date(raw.runAt),
            status: raw.status,
            payload: raw.payload,
            createdAt: new Date(raw.createdAt),
        };
    }

    /**
     * Rehydrates a persisted event row into an {@link AuditEvent}. The `details`
     * field is left as its JSON string, matching the entity's shape.
     */
    private static deserializeEvent(raw: RawEvent): AuditEvent {
        return {
            id: raw.id,
            workflowId: raw.workflowId,
            stepKey: raw.stepKey,
            eventType: raw.eventType,
            details: raw.details,
            createdAt: new Date(raw.createdAt),
        };
    }

    /**
     * Flattens a {@link CronSchedule} into its persisted form, converting every
     * `Date` (including the nullable ones) into an ISO string.
     */
    private static serializeCronSchedule(schedule: CronSchedule): RawCronSchedule {
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

    /**
     * Rehydrates a persisted cron row into a {@link CronSchedule}, parsing its
     * ISO timestamps into `Date` instances.
     */
    private static deserializeCronSchedule(raw: RawCronSchedule): CronSchedule {
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
            /* Tolerate stores written before ownership leases existed. */
            leaseOwner: raw.leaseOwner ?? null,
            leaseExpiresAt: raw.leaseExpiresAt ? new Date(raw.leaseExpiresAt) : null,
            createdAt: new Date(raw.createdAt),
            updatedAt: new Date(raw.updatedAt),
        };
    }
}
