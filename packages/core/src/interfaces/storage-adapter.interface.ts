import type { CronScheduleStatus } from "../enums/cron-schedule-status.enum.js";
import type { EventType } from "../enums/event-type.enum.js";
import type { ScheduleStatus } from "../enums/schedule-status.enum.js";
import type { StepStatus } from "../enums/step-status.enum.js";
import type { WorkflowStatus } from "../enums/workflow-status.enum.js";
import type { ClaimResult } from "../entities/claim-result.entity.js";
import type { CronSchedule } from "../entities/cron-schedule.entity.js";
import type { Workflow } from "../entities/workflow.entity.js";

/**
 * A filter for querying stored workflow executions via
 * {@link StorageAdapter.listWorkflows}. Every field is optional; an empty filter
 * matches all workflows (subject to the default limit).
 */
export interface WorkflowFilter {
    /**
     * Restrict to workflows in any of these states.
     */
    statuses?: WorkflowStatus[];
    /**
     * Restrict to executions of this workflow definition name.
     */
    workflowName?: string;
    /**
     * Restrict to the children of this parent workflow identifier.
     */
    parentWorkflowIdentifier?: string;
    /**
     * Only workflows created at or after this instant.
     */
    createdAfter?: Date;
    /**
     * Only workflows created at or before this instant.
     */
    createdBefore?: Date;
    /**
     * The maximum number of records to return. Defaults to a backend-chosen
     * cap.
     */
    limit?: number;
}

/**
 * The narrow persistence contract the core engine depends upon.
 *
 * Any backend that can provide atomic step claiming, fence-token-guarded
 * commits, durable timers, and an append-only audit log can implement this
 * interface. The MySQL adapter is the primary production implementation; the
 * in-memory adapter shipped with the core is intended for tests.
 *
 * Every operation must be safe to call concurrently from multiple worker
 * processes sharing the same backend.
 */
export interface StorageAdapter {
    /**
     * Creates the workflow execution record if it does not already exist.
     *
     * `parentWorkflowIdentifier` records the workflow that started this one as
     * a child, or `null` for a top-level execution. It is only meaningful on
     * first creation; a later call for an existing workflow leaves the stored
     * parent untouched.
     */
    ensureWorkflow(
        workflowIdentifier: string,
        workflowName: string,
        input: Buffer | null,
        parentWorkflowIdentifier?: string | null,
    ): Promise<void>;

    /**
     * Updates a workflow's status and, optionally, its binary output or error.
     */
    setWorkflowStatus(
        workflowIdentifier: string,
        status: WorkflowStatus,
        fields?: { output?: Buffer | null; error?: string | null },
    ): Promise<void>;

    /**
     * Retrieves a workflow execution record, or `null` when absent.
     */
    getWorkflow(workflowIdentifier: string): Promise<Workflow | null>;

    /**
     * Lists workflow execution records matching the given filter, most recently
     * updated first. This backs the operational management API (listing,
     * dashboards, reconciliation). A backend may cap the returned count with
     * its own sensible ceiling in addition to the caller's `limit`.
     */
    listWorkflows(filter: WorkflowFilter): Promise<Workflow[]>;

    /**
     * Atomically claims a runnable step. Returns the memoized result when the
     * step is already terminal, refuses the claim when another worker holds a
     * live lease, and otherwise grants a claim with a freshly incremented fence
     * token.
     */
    claimStep(
        workflowIdentifier: string,
        stepKey: string,
        maxAttempts: number,
        leaseMilliseconds: number,
    ): Promise<ClaimResult>;

    /**
     * Commits a step outcome. The write is rejected (returns `false`) when the
     * supplied fence token is stale, which prevents a stale worker from
     * overwriting a newer owner's result.
     */
    commitStep(
        workflowIdentifier: string,
        stepKey: string,
        fenceToken: number,
        output: Buffer | null,
        status: StepStatus,
    ): Promise<boolean>;

    /**
     * Records a step failure. When `retryAt` is provided the step returns to a
     * runnable state for a later attempt (preserving the ambiguous status when
     * applicable); otherwise the supplied terminal status is stored. Rejected
     * when the fence token is stale.
     */
    failStep(
        workflowIdentifier: string,
        stepKey: string,
        fenceToken: number,
        error: string,
        status: StepStatus,
        retryAt: Date | null,
    ): Promise<boolean>;

    /**
     * Releases the lease on a claimed step without recording an outcome, making
     * the step immediately claimable again. This is used for graceful shutdown
     * and for operator intervention, so a step held by a worker that is going
     * away is not stuck until its lease naturally expires.
     *
     * The release is guarded by the fence token: only the current lease holder
     * can release it, and the attempt count is left untouched so the next claim
     * simply resumes. Returns `false` if the token is stale (a newer claim
     * already exists).
     */
    releaseStep(workflowIdentifier: string, stepKey: string, fenceToken: number): Promise<boolean>;

    /**
     * Persists a durable timer that becomes due at `runAt`.
     */
    scheduleTimer(
        workflowIdentifier: string,
        stepKey: string | null,
        runAt: Date,
        payload: string | null,
    ): Promise<void>;

    /**
     * Ensures a durable sleep timer exists for the given key, creating it
     * exactly once. This is how {@link WorkflowContext.sleep} stays idempotent
     * across resumes: the first call records the timer with its due time, and
     * later calls for the same key return the existing timer instead of
     * creating another.
     *
     * @returns The due time of the sleep timer (the existing one if it was
     *   already created, otherwise the newly recorded `runAt`).
     */
    ensureSleepTimer(
        workflowIdentifier: string,
        timerKey: string,
        runAt: Date,
    ): Promise<{ runAt: Date }>;

    /**
     * Atomically claims up to `limit` timers whose due time has passed, marking
     * them processed so concurrent schedulers do not dispatch them twice.
     */
    claimDueTimers(
        now: Date,
        limit: number,
    ): Promise<
        Array<{
            scheduleIdentifier: number;
            workflowIdentifier: string;
            stepKey: string | null;
            payload: string | null;
        }>
    >;

    /**
     * Sets the status of a specific timer.
     */
    setTimerStatus(scheduleIdentifier: number, status: ScheduleStatus): Promise<void>;

    /**
     * Appends an immutable audit event.
     */
    logEvent(
        workflowIdentifier: string,
        stepKey: string | null,
        eventType: EventType,
        details: Record<string, unknown>,
    ): Promise<void>;

    // ---------------------------------------------------------------------------
    // Recurring (cron) schedules
    //
    // These operations manage long-lived recurring definitions, as opposed to the
    // one-shot durable timers above. A backend that cannot provide them may leave
    // them unimplemented, in which case durable cron is simply unavailable on that
    // backend; the one-shot timer machinery continues to work.
    // ---------------------------------------------------------------------------

    /**
     * Creates a cron schedule, or replaces the existing one with the same name.
     * Idempotent by name so that re-registering a schedule on every boot (the
     * common pattern) neither duplicates it nor resets its firing history.
     */
    upsertCronSchedule(schedule: CronSchedule): Promise<void>;

    /**
     * Returns a cron schedule by name, or `null` when it does not exist.
     */
    getCronSchedule(name: string): Promise<CronSchedule | null>;

    /**
     * Returns every cron schedule currently stored.
     */
    listCronSchedules(): Promise<CronSchedule[]>;

    /**
     * Atomically claims up to `limit` `ACTIVE` cron schedules whose `nextRunAt`
     * has passed, advancing each claimed schedule's `nextRunAt` to its
     * following occurrence and stamping `lastRunAt`. Returning the claimed
     * schedules with their fired instant lets the caller dispatch them, while
     * the advance-in- place makes the claim safe for concurrent schedulers: two
     * instances cannot both fire the same occurrence.
     *
     * The caller supplies the computed `nextRunAt` (and, for catch-up, the
     * intermediate fired instants) because next-occurrence computation lives in
     * the engine layer, not the storage layer.
     *
     * When `owner` is provided, only schedules currently leased to that owner
     * are considered. This scopes firing to the process's owned slice under the
     * optional ownership model; omitting it (the default) fires any due
     * schedule, which is the simple every-process-evaluates-everything model.
     */
    claimDueCronSchedules(
        now: Date,
        limit: number,
        computeNextRunAt: (schedule: CronSchedule, firedAt: Date) => Date,
        owner?: string,
    ): Promise<Array<{ schedule: CronSchedule; firedAt: Date }>>;

    /**
     * Sets a cron schedule's status (for pause/resume). Returns `false` if
     * absent.
     */
    setCronScheduleStatus(name: string, status: CronScheduleStatus): Promise<boolean>;

    /**
     * Deletes a cron schedule by name. Returns `false` when it did not exist.
     */
    removeCronSchedule(name: string): Promise<boolean>;

    // ---------------------------------------------------------------------------
    // Optional schedule-ownership leases (for distributing schedules across
    // processes). A backend that does not implement these simply cannot use the
    // ownership model; the per-occurrence firing above continues to work.
    // ---------------------------------------------------------------------------

    /**
     * Extends the lease on every schedule currently owned by `owner`, setting
     * each `leaseExpiresAt` to `expiresAt`. This is the heartbeat a live
     * process sends each tick to retain its slice; a process that stops
     * renewing loses its schedules once their leases pass.
     *
     * @returns The number of leases renewed.
     */
    renewCronLeases(owner: string, expiresAt: Date): Promise<number>;

    /**
     * Atomically leases up to `limit` schedules that are currently free (never
     * owned) or whose lease has expired at or before `now`, assigning them to
     * `owner` with the given `expiresAt`. The conditional, atomic nature of the
     * write is what prevents two processes from acquiring the same schedule:
     * the loser of a race finds the row no longer free and claims a different
     * one.
     *
     * Longest-free schedules are preferred so ownership spreads rather than
     * repeatedly landing on the same rows.
     *
     * @returns The schedules newly leased to `owner`.
     */
    acquireCronSchedules(
        owner: string,
        now: Date,
        expiresAt: Date,
        limit: number,
    ): Promise<CronSchedule[]>;

    /**
     * Counts the schedules currently leased to `owner` with a live lease at
     * `now`.
     */
    countOwnedCronSchedules(owner: string, now: Date): Promise<number>;

    /**
     * Atomically claims up to `limit` `ACTIVE`, **due**, and currently
     * **unowned** (never leased, or lease expired at or before `now`) cron
     * schedules, advancing each to its next occurrence exactly as
     * {@link StorageAdapter.claimDueCronSchedules} does. This is the safety net
     * that fires schedules stranded when the fleet's total ownership capacity
     * is smaller than the number of schedules, so none is ever left unfired.
     * Firing here does not take a lease; it just runs the due occurrence.
     */
    claimDueUnownedCronSchedules(
        now: Date,
        limit: number,
        computeNextRunAt: (schedule: CronSchedule, firedAt: Date) => Date,
    ): Promise<Array<{ schedule: CronSchedule; firedAt: Date }>>;

    /**
     * Releases every lease held by `owner`, setting `leaseOwner` and
     * `leaseExpiresAt` back to null. Called on graceful shutdown so a departing
     * process hands its slice back immediately rather than making peers wait
     * for the leases to expire.
     *
     * @returns The number of leases released.
     */
    releaseCronLeases(owner: string): Promise<number>;
}
