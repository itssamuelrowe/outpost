import type { CronSchedule } from "../entities/cron-schedule.entity.js";

/**
 * Reports an error thrown while handling a due timer or cron fire. The first
 * argument identifies the affected work (a workflow id or schedule name). The
 * scheduler reports failures through this callback rather than rethrowing, so a
 * single bad dispatch cannot stall the loop.
 */
export type HandlerErrorReporter = (workflowId: string, error: unknown) => void;

/**
 * Reports how many due-but-unowned schedules the ownership safety net fired in
 * a tick. A persistently non-zero count means the fleet's total ownership
 * capacity is below the schedule count.
 */
export type UnownedSchedulesReporter = (count: number) => void;

/**
 * Handles a single due timer by resuming the workflow it belongs to.
 *
 * The application supplies this callback because only it knows how to map a
 * workflow identifier back to a runnable workflow (for example, by calling
 * `engine.run(name, workflowId, input)`). Keeping the resume logic
 * outside the scheduler preserves the engine's independence from any particular
 * dispatch mechanism.
 */
export type DueTimerHandler = (timer: {
    scheduleId: number;
    workflowId: string;
    stepKey: string | null;
    payload: string | null;
}) => Promise<void>;

/**
 * Handles a single cron fire. The scheduler passes the schedule that fired and
 * the exact instant it was scheduled for; the application decides how to run
 * the associated workflow. A stable per-fire workflow identifier is provided so
 * the handler can start the run idempotently (the same fire, if dispatched
 * twice, resolves to the same workflow execution).
 */
export type CronFireHandler = (fire: {
    /**
     * The schedule that fired.
     */
    schedule: CronSchedule;
    /**
     * The exact instant this occurrence was scheduled for.
     */
    scheduledFor: Date;
    /**
     * A deterministic workflow identifier derived from the schedule and
     * instant.
     */
    workflowId: string;
    /**
     * The schedule's serialized payload, if any.
     */
    payload: string | null;
}) => Promise<void>;

/**
 * Options accepted when registering a recurring (cron) schedule.
 */
export interface CronScheduleOptions {
    /**
     * A stable, unique name used to manage the schedule later.
     */
    name: string;
    /**
     * A five- or six-field cron expression.
     */
    cronExpression: string;
    /**
     * The workflow name to run on each fire.
     */
    workflowName: string;
    /**
     * The IANA time zone to evaluate the expression in. Defaults to UTC.
     */
    timeZone?: string;
    /**
     * An optional serialized payload delivered to the fire handler.
     */
    payload?: string | null;
    /**
     * Whether occurrences missed while the process was down are replayed on
     * recovery. Defaults to `false` (missed windows are skipped).
     */
    catchUp?: boolean;
}

/**
 * Configuration for a {@link Scheduler}.
 */
export interface SchedulerOptions {
    /**
     * How often, in milliseconds, to poll for due timers. Defaults to one
     * second.
     */
    pollIntervalMilliseconds?: number;
    /**
     * The maximum number of timers to claim per poll. Defaults to fifty.
     */
    batchSize?: number;
    /**
     * An injectable clock, provided so tests can control time.
     */
    now?: () => Date;
    /**
     * Invoked when handling a due timer throws. Because a timer is marked
     * processed when it is claimed, a handler failure is reported here rather
     * than propagated, so a single bad timer cannot halt the whole loop.
     * Defaults to a no-op.
     */
    onHandlerError?: HandlerErrorReporter;
    /**
     * The maximum number of missed occurrences to replay for a single catch-up
     * schedule in one tick. Bounds the recovery burst after a long outage.
     * Defaults to one hundred.
     */
    maxCatchUpPerTick?: number;
    /**
     * The ceiling, in milliseconds, of the random jitter added to each cron
     * fire to avoid a thundering herd. Defaults to ten seconds. Set to zero to
     * fire at the exact scheduled instant.
     */
    cronJitterMilliseconds?: number;
    /**
     * An injectable source of randomness in `[0, 1)` for jitter. Defaults to
     * `Math.random`.
     */
    randomNumberGenerator?: () => number;
    /**
     * Opts this scheduler into the schedule-ownership model, in which each
     * process leases a bounded slice of the cron schedules and evaluates only
     * those, rather than every process evaluating every due schedule. Omit it
     * to keep the default behavior. See the "Distributing schedules across
     * processes" guide.
     */
    ownership?: OwnershipOptions;
    /**
     * Invoked when the ownership safety net fires schedules that were due but
     * unowned, with the number caught this tick. A persistently non-zero value
     * means the fleet's total ownership capacity is below the schedule count
     * and should be increased. Defaults to a no-op. Only relevant under the
     * ownership model with the safety net enabled.
     */
    onUnownedSchedulesDetected?: UnownedSchedulesReporter;
}

/**
 * How many schedules a process will own. This is intentionally required and has
 * no default: whether a process picks up everything or only a bounded slice is
 * a deployment decision that should be made explicitly, not inferred.
 *
 * - `"all"`: own and evaluate every schedule. Correct for a single process or a
 *   monolith. If several processes all use `"all"`, they simply share the work
 *   through the atomic per-occurrence claim, exactly like the default
 *   (no-ownership) model, with the small extra cost of lease bookkeeping.
 * - a number: own at most this many schedules, so each process handles only a
 *   slice. Use this to spread a large schedule set across a fleet.
 */
export type OwnershipCapacity = "all" | number;

/**
 * Configuration for the schedule-ownership model.
 */
export interface OwnershipOptions {
    /**
     * How much this process takes on: `"all"` or a maximum count. Required, so
     * the choice between "pick up everything" and "pick up only so much" is
     * always explicit in the deployment.
     */
    capacity: OwnershipCapacity;
    /**
     * A stable identifier for this process, unique across the fleet. Defaults
     * to a random id generated at construction, which is sufficient unless you
     * want ownership to survive a restart under the same identity.
     */
    processId?: string;
    /**
     * How long, in milliseconds, an ownership lease remains valid without
     * renewal. A crashed owner's schedules become claimable by peers after this
     * elapses, so it bounds failover time. Defaults to three poll intervals.
     */
    leaseTtlMilliseconds?: number;
    /**
     * Whether to release all owned leases on {@link Scheduler.stop}, so a
     * graceful shutdown hands the slice back immediately instead of making
     * peers wait for expiry. Defaults to `true`.
     */
    releaseOnStop?: boolean;
    /**
     * Whether a process should also fire schedules that are **due but
     * unowned**, as a safety net so nothing is stranded when the fleet's total
     * capacity is less than the number of schedules (for example three
     * processes of 50 for 200 schedules). Defaults to `true`.
     *
     * With the net on, an under-provisioned fleet still fires every schedule;
     * the leftovers are simply shared opportunistically rather than owned. With
     * it off, an unowned schedule will not fire until capacity frees up, which
     * is only ever what you want if you would rather a schedule be skipped than
     * run on an already-full process. When the net catches leftovers, their
     * count is reported through
     * {@link SchedulerOptions.onUnownedSchedulesDetected} so the situation is
     * observable rather than silent.
     */
    fireUnownedAsSafetyNet?: boolean;
}

/**
 * The ownership configuration after defaults are applied, held internally by a
 * {@link Scheduler} when the ownership model is enabled. Every field is
 * resolved to a concrete value, including a definite `processId`, so the
 * scheduler never has to re-apply defaults at use sites.
 */
export interface ResolvedOwnership {
    /**
     * The stable identifier this process uses for its ownership leases.
     */
    processId: string;
    /**
     * How many schedules this process will own.
     */
    capacity: OwnershipCapacity;
    /**
     * How long, in milliseconds, a lease remains valid without renewal.
     */
    leaseTtlMilliseconds: number;
    /**
     * Whether owned leases are released on {@link Scheduler.stop}.
     */
    releaseOnStop: boolean;
    /**
     * Whether this process also fires due-but-unowned schedules as a safety net.
     */
    fireUnownedAsSafetyNet: boolean;
}

/**
 * The mutable fields of a recurring schedule that {@link Scheduler.updateCron}
 * can change in place. Any subset may be supplied; omitted fields keep their
 * current value.
 */
export interface CronScheduleUpdate {
    /**
     * A new five- or six-field cron expression.
     */
    cronExpression?: string;
    /**
     * A new IANA time zone, or `null` to evaluate in UTC.
     */
    timeZone?: string | null;
    /**
     * A new serialized payload, or `null` to clear it.
     */
    payload?: string | null;
    /**
     * Whether missed occurrences are replayed on recovery.
     */
    catchUp?: boolean;
    /**
     * A new workflow name to run on each fire.
     */
    workflowName?: string;
}
