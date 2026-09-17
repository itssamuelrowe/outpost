import { addMilliseconds, compareDesc, isAfter } from "date-fns";

import { compareLeaseFreedom } from "../utilities/cron.utility.js";
import type { CronScheduleStatus } from "../enums/cron-schedule-status.enum.js";
import { CronScheduleStatus as CronScheduleStatusEnum } from "../enums/cron-schedule-status.enum.js";
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
 * An in-memory implementation of {@link StorageAdapter}, shipped as part of the
 * core library so consumers can unit-test their workflows without provisioning
 * a database.
 *
 * It faithfully models the lease and fence-token semantics that the production
 * MySQL adapter provides, which means correctness tests written against it
 * remain meaningful. It is emphatically not intended for production use: all
 * state is held in process memory and is lost when the process exits.
 */
export class MemoryStorage implements StorageAdapter {
    private readonly workflows = new Map<string, Workflow>();
    private readonly steps = new Map<string, Step>();
    private readonly schedules: Schedule[] = [];
    /**
     * Recurring cron schedules, keyed by their unique name.
     */
    private readonly cronSchedules = new Map<string, CronSchedule>();
    /**
     * Durable sleep due-times, keyed by workflowId + timerKey, created once
     * each.
     */
    private readonly sleepTimers = new Map<string, Date>();
    private nextScheduleIdentifier = 1;
    private nextEventIdentifier = 1;

    /**
     * The append-only audit log, exposed so tests can make assertions on it.
     */
    public readonly events: AuditEvent[] = [];

    private readonly now: () => Date;

    public constructor(now: () => Date = () => new Date()) {
        this.now = now;
    }

    /**
     * Composes the composite primary key for the step map.
     */
    private composeStepKey(workflowIdentifier: string, stepKey: string): string {
        return `${workflowIdentifier}\u0000${stepKey}`;
    }

    public async ensureWorkflow(
        workflowIdentifier: string,
        workflowName: string,
        input: Buffer | null,
        parentWorkflowIdentifier: string | null = null,
    ): Promise<void> {
        if (!this.workflows.has(workflowIdentifier)) {
            const timestamp = this.now();
            this.workflows.set(workflowIdentifier, {
                workflowIdentifier,
                workflowName,
                parentWorkflowIdentifier,
                status: WorkflowStatus.RUNNING,
                input,
                output: null,
                error: null,
                createdAt: timestamp,
                updatedAt: timestamp,
            });
        }
    }

    public async listWorkflows(filter: WorkflowFilter): Promise<Workflow[]> {
        const limit = filter.limit ?? 100;
        const matches = [...this.workflows.values()].filter((workflow) => {
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
        return matches.slice(0, limit).map((workflow) => ({ ...workflow }));
    }

    public async setWorkflowStatus(
        workflowIdentifier: string,
        status: WorkflowStatus,
        fields?: { output?: Buffer | null; error?: string | null },
    ): Promise<void> {
        const workflow = this.workflows.get(workflowIdentifier);
        if (!workflow) {
            return;
        }
        workflow.status = status;
        if (fields && "output" in fields) {
            workflow.output = fields.output ?? null;
        }
        if (fields && "error" in fields) {
            workflow.error = fields.error ?? null;
        }
        workflow.updatedAt = this.now();
    }

    public async getWorkflow(workflowIdentifier: string): Promise<Workflow | null> {
        return this.workflows.get(workflowIdentifier) ?? null;
    }

    public async claimStep(
        workflowIdentifier: string,
        stepKey: string,
        maxAttempts: number,
        leaseMilliseconds: number,
    ): Promise<ClaimResult> {
        const mapKey = this.composeStepKey(workflowIdentifier, stepKey);
        const currentInstant = this.now();
        let step = this.steps.get(mapKey);

        if (!step) {
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
                createdAt: currentInstant,
                updatedAt: currentInstant,
            };
            this.steps.set(mapKey, step);
        }

        if (step.status === StepStatus.COMPLETED || step.status === StepStatus.FAILED_OPTIONAL) {
            return {
                claimed: false,
                cachedResult: { output: step.output, completedAt: step.completedAt },
                attempt: step.attempts,
                fenceToken: step.fenceToken,
                priorStatus: step.status,
            };
        }

        const leaseIsLive =
            step.status === StepStatus.RUNNING &&
            step.lockedUntil !== null &&
            isAfter(step.lockedUntil, currentInstant);
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
        step.lockedUntil = addMilliseconds(currentInstant, leaseMilliseconds);
        step.updatedAt = currentInstant;

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
        const step = this.steps.get(this.composeStepKey(workflowIdentifier, stepKey));
        if (!step || step.fenceToken !== fenceToken) {
            return false;
        }
        step.status = status;
        step.output = output;
        step.lockedUntil = null;
        step.completedAt = this.now();
        step.updatedAt = this.now();
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
        const step = this.steps.get(this.composeStepKey(workflowIdentifier, stepKey));
        if (!step || step.fenceToken !== fenceToken) {
            return false;
        }
        step.lastError = error;
        step.lockedUntil = null;
        step.updatedAt = this.now();
        if (retryAt) {
            // Preserve the ambiguous status across a retry so recovery probes; a
            // definite retryable failure returns to the pending state.
            step.status =
                status === StepStatus.AMBIGUOUS ? StepStatus.AMBIGUOUS : StepStatus.PENDING;
            this.schedules.push({
                scheduleIdentifier: this.nextScheduleIdentifier++,
                workflowIdentifier,
                stepKey,
                runAt: retryAt,
                status: ScheduleStatus.PENDING,
                payload: null,
                createdAt: this.now(),
            });
        } else {
            step.status = status;
        }
        return true;
    }

    public async releaseStep(
        workflowIdentifier: string,
        stepKey: string,
        fenceToken: number,
    ): Promise<boolean> {
        const step = this.steps.get(this.composeStepKey(workflowIdentifier, stepKey));
        if (!step || step.fenceToken !== fenceToken) {
            return false;
        }
        // Only a step that is currently running under this lease can be released.
        if (step.status !== StepStatus.RUNNING) {
            return false;
        }
        step.status = StepStatus.PENDING;
        step.lockedUntil = null;
        step.updatedAt = this.now();
        return true;
    }

    public async ensureSleepTimer(
        workflowIdentifier: string,
        timerKey: string,
        runAt: Date,
    ): Promise<{ runAt: Date }> {
        const mapKey = this.composeStepKey(workflowIdentifier, timerKey);
        const existing = this.sleepTimers.get(mapKey);
        if (existing) {
            return { runAt: existing };
        }
        this.sleepTimers.set(mapKey, runAt);
        // Also record a schedule so the embedded scheduler can dispatch a resume
        // when the sleep becomes due.
        this.schedules.push({
            scheduleIdentifier: this.nextScheduleIdentifier++,
            workflowIdentifier,
            stepKey: timerKey,
            runAt,
            status: ScheduleStatus.PENDING,
            payload: null,
            createdAt: this.now(),
        });
        return { runAt };
    }

    public async scheduleTimer(
        workflowIdentifier: string,
        stepKey: string | null,
        runAt: Date,
        payload: string | null,
    ): Promise<void> {
        this.schedules.push({
            scheduleIdentifier: this.nextScheduleIdentifier++,
            workflowIdentifier,
            stepKey,
            runAt,
            status: ScheduleStatus.PENDING,
            payload,
            createdAt: this.now(),
        });
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
        const dueTimers = this.schedules
            .filter(
                (schedule) =>
                    schedule.status === ScheduleStatus.PENDING && !isAfter(schedule.runAt, now),
            )
            .slice(0, limit);

        for (const timer of dueTimers) {
            timer.status = ScheduleStatus.PROCESSED;
        }

        return dueTimers.map((timer) => ({
            scheduleIdentifier: timer.scheduleIdentifier,
            workflowIdentifier: timer.workflowIdentifier,
            stepKey: timer.stepKey,
            payload: timer.payload,
        }));
    }

    public async setTimerStatus(scheduleIdentifier: number, status: ScheduleStatus): Promise<void> {
        const timer = this.schedules.find(
            (schedule) => schedule.scheduleIdentifier === scheduleIdentifier,
        );
        if (timer) {
            timer.status = status;
        }
    }

    public async logEvent(
        workflowIdentifier: string,
        stepKey: string | null,
        eventType: EventType,
        details: Record<string, unknown>,
    ): Promise<void> {
        this.events.push({
            identifier: this.nextEventIdentifier++,
            workflowIdentifier,
            stepKey,
            eventType,
            details: JSON.stringify(details),
            createdAt: this.now(),
        });
    }

    public async upsertCronSchedule(schedule: CronSchedule): Promise<void> {
        const existing = this.cronSchedules.get(schedule.name);
        if (existing) {
            // Preserve firing history so re-registering on boot is a no-op rather than
            // a reset: keep the running nextRunAt/lastRunAt and creation time.
            this.cronSchedules.set(schedule.name, {
                ...existing,
                cronExpression: schedule.cronExpression,
                timeZone: schedule.timeZone,
                workflowName: schedule.workflowName,
                payload: schedule.payload,
                catchUp: schedule.catchUp,
                updatedAt: this.now(),
            });
            return;
        }
        this.cronSchedules.set(schedule.name, {
            ...schedule,
            leaseOwner: schedule.leaseOwner ?? null,
            leaseExpiresAt: schedule.leaseExpiresAt ?? null,
        });
    }

    public async getCronSchedule(name: string): Promise<CronSchedule | null> {
        const schedule = this.cronSchedules.get(name);
        return schedule ? { ...schedule } : null;
    }

    public async listCronSchedules(): Promise<CronSchedule[]> {
        return [...this.cronSchedules.values()].map((schedule) => ({ ...schedule }));
    }

    public async claimDueCronSchedules(
        now: Date,
        limit: number,
        computeNextRunAt: (schedule: CronSchedule, firedAt: Date) => Date,
        owner?: string,
    ): Promise<Array<{ schedule: CronSchedule; firedAt: Date }>> {
        const claimed: Array<{ schedule: CronSchedule; firedAt: Date }> = [];

        for (const schedule of this.cronSchedules.values()) {
            if (claimed.length >= limit) {
                break;
            }
            if (schedule.status !== CronScheduleStatusEnum.ACTIVE) {
                continue;
            }
            // Under the ownership model, only fire schedules this process owns with a
            // live lease. Without an owner filter, any due schedule is fair game.
            if (owner !== undefined) {
                const ownedLive =
                    schedule.leaseOwner === owner &&
                    schedule.leaseExpiresAt !== null &&
                    isAfter(schedule.leaseExpiresAt, now);
                if (!ownedLive) {
                    continue;
                }
            }
            if (isAfter(schedule.nextRunAt, now)) {
                continue;
            }

            // Snapshot the occurrence being fired, then advance the schedule in place
            // so a concurrent claim cannot fire the same occurrence again.
            const firedAt = schedule.nextRunAt;
            const snapshot: CronSchedule = { ...schedule };
            schedule.lastRunAt = firedAt;
            schedule.nextRunAt = computeNextRunAt(snapshot, firedAt);
            schedule.updatedAt = this.now();

            claimed.push({ schedule: snapshot, firedAt });
        }

        return claimed;
    }

    public async setCronScheduleStatus(name: string, status: CronScheduleStatus): Promise<boolean> {
        const schedule = this.cronSchedules.get(name);
        if (!schedule) {
            return false;
        }
        schedule.status = status;
        schedule.updatedAt = this.now();
        return true;
    }

    public async removeCronSchedule(name: string): Promise<boolean> {
        return this.cronSchedules.delete(name);
    }

    public async renewCronLeases(owner: string, expiresAt: Date): Promise<number> {
        let renewed = 0;
        for (const schedule of this.cronSchedules.values()) {
            if (schedule.leaseOwner === owner) {
                schedule.leaseExpiresAt = expiresAt;
                schedule.updatedAt = this.now();
                renewed += 1;
            }
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
        // Candidates: free (never owned) or expired leases. Prefer the ones that
        // have been free longest (null lease first, then oldest expiry) so ownership
        // spreads rather than repeatedly landing on the same rows.
        const candidates = [...this.cronSchedules.values()]
            .filter(
                (schedule) =>
                    schedule.leaseOwner === null ||
                    schedule.leaseExpiresAt === null ||
                    !isAfter(schedule.leaseExpiresAt, now),
            )
            // Never-owned (null lease) sorts first, then by oldest expiry.
            .sort((a, b) => compareLeaseFreedom(a.leaseExpiresAt, b.leaseExpiresAt))
            .slice(0, limit);

        for (const schedule of candidates) {
            schedule.leaseOwner = owner;
            schedule.leaseExpiresAt = expiresAt;
            schedule.updatedAt = this.now();
        }
        return candidates.map((schedule) => ({ ...schedule }));
    }

    public async countOwnedCronSchedules(owner: string, now: Date): Promise<number> {
        let count = 0;
        for (const schedule of this.cronSchedules.values()) {
            if (
                schedule.leaseOwner === owner &&
                schedule.leaseExpiresAt !== null &&
                isAfter(schedule.leaseExpiresAt, now)
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
        const claimed: Array<{ schedule: CronSchedule; firedAt: Date }> = [];

        for (const schedule of this.cronSchedules.values()) {
            if (claimed.length >= limit) {
                break;
            }
            if (schedule.status !== CronScheduleStatusEnum.ACTIVE) {
                continue;
            }
            // Only unowned (or expired-lease) schedules; owned ones are fired by their
            // owner via claimDueCronSchedules.
            const isUnowned =
                schedule.leaseOwner === null ||
                schedule.leaseExpiresAt === null ||
                !isAfter(schedule.leaseExpiresAt, now);
            if (!isUnowned) {
                continue;
            }
            if (isAfter(schedule.nextRunAt, now)) {
                continue;
            }

            const firedAt = schedule.nextRunAt;
            const snapshot: CronSchedule = { ...schedule };
            schedule.lastRunAt = firedAt;
            schedule.nextRunAt = computeNextRunAt(snapshot, firedAt);
            schedule.updatedAt = this.now();

            claimed.push({ schedule: snapshot, firedAt });
        }

        return claimed;
    }

    public async releaseCronLeases(owner: string): Promise<number> {
        let released = 0;
        for (const schedule of this.cronSchedules.values()) {
            if (schedule.leaseOwner === owner) {
                schedule.leaseOwner = null;
                schedule.leaseExpiresAt = null;
                schedule.updatedAt = this.now();
                released += 1;
            }
        }
        return released;
    }

    /**
     * Returns the current state of a step, for use in tests.
     */
    public getStep(workflowIdentifier: string, stepKey: string): Step | undefined {
        return this.steps.get(this.composeStepKey(workflowIdentifier, stepKey));
    }

    /**
     * Returns a snapshot of everything currently held in memory: workflows,
     * steps, schedules, and audit events.
     *
     * This is intended for tests, examples, and debugging, where it is useful
     * to inspect or print the complete durable state after a run. The returned
     * arrays are shallow copies, so iterating over them will not be disturbed
     * by later writes, though the entity objects themselves are the live
     * records.
     */
    public dump(): {
        workflows: Workflow[];
        steps: Step[];
        schedules: Schedule[];
        cronSchedules: CronSchedule[];
        events: AuditEvent[];
    } {
        return {
            workflows: [...this.workflows.values()],
            steps: [...this.steps.values()],
            schedules: [...this.schedules],
            cronSchedules: [...this.cronSchedules.values()],
            events: [...this.events],
        };
    }
}
