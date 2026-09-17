import { addMilliseconds, differenceInMilliseconds, isAfter, subMilliseconds } from "date-fns";

import { CronScheduleStatus } from "../enums/cron-schedule-status.enum.js";
import type { CronSchedule } from "../entities/cron-schedule.entity.js";
import type { StorageAdapter } from "../interfaces/storage-adapter.interface.js";
import {
    DEFAULT_CRON_JITTER_MILLISECONDS,
    applyCronJitter,
    assertValidCronExpression,
    computeNextCronRun,
    enumerateMissedCronRuns,
} from "../utilities/cron.utility.js";

/**
 * Handles a single due timer by resuming the workflow it belongs to.
 *
 * The application supplies this callback because only it knows how to map a
 * workflow identifier back to a runnable workflow (for example, by calling
 * `engine.run(name, workflowIdentifier, input)`). Keeping the resume logic
 * outside the scheduler preserves the engine's independence from any particular
 * dispatch mechanism.
 */
export type DueTimerHandler = (timer: {
    scheduleIdentifier: number;
    workflowIdentifier: string;
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
    workflowIdentifier: string;
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
    onHandlerError?: (workflowIdentifier: string, error: unknown) => void;
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
    onUnownedSchedulesDetected?: (count: number) => void;
}

/**
 * How many schedules a process will own. This is intentionally required and has
 * no default: whether a process picks up everything or only a bounded slice is
 * a deployment decision that should be made explicitly, not inferred.
 *
 * - `"all"` — own and evaluate every schedule. Correct for a single process or a
 *   monolith. If several processes all use `"all"`, they simply share the work
 *   through the atomic per-occurrence claim, exactly like the default
 *   (no-ownership) model, with the small extra cost of lease bookkeeping.
 * - a number — own at most this many schedules, so each process handles only a
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
 * An embedded scheduler that periodically claims due one-shot timers and fires
 * due recurring (cron) schedules, dispatching both to application handlers.
 *
 * The scheduler is designed to run inside ordinary application processes, with
 * no separate daemon required. Multiple instances may run concurrently against
 * the same storage backend: `claimDueTimers` and `claimDueCronSchedules` each
 * claim work atomically, so no timer or cron occurrence is dispatched twice
 * under normal locking semantics.
 *
 * Timer volume is expected to be moderate; database polling is intentionally
 * simple and may need a different backend at very high scale.
 */
export class Scheduler {
    private readonly storage: StorageAdapter;
    private readonly pollIntervalMilliseconds: number;
    private readonly batchSize: number;
    private readonly now: () => Date;
    private readonly onHandlerError: (workflowIdentifier: string, error: unknown) => void;
    private readonly maxCatchUpPerTick: number;
    private readonly cronJitterMilliseconds: number;
    private readonly randomNumberGenerator: () => number;

    /**
     * Resolved ownership configuration, or `null` when the ownership model is
     * off.
     */
    private readonly ownership: {
        processId: string;
        capacity: OwnershipCapacity;
        leaseTtlMilliseconds: number;
        releaseOnStop: boolean;
        fireUnownedAsSafetyNet: boolean;
    } | null;

    private readonly onUnownedSchedulesDetected: (count: number) => void;

    private running = false;
    private loopPromise: Promise<void> | null = null;
    private cronHandler: CronFireHandler | null = null;

    public constructor(storage: StorageAdapter, options: SchedulerOptions = {}) {
        this.storage = storage;
        this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 1_000;
        this.batchSize = options.batchSize ?? 50;
        this.now = options.now ?? (() => new Date());
        this.onHandlerError = options.onHandlerError ?? (() => undefined);
        this.maxCatchUpPerTick = options.maxCatchUpPerTick ?? 100;
        this.cronJitterMilliseconds =
            options.cronJitterMilliseconds ?? DEFAULT_CRON_JITTER_MILLISECONDS;
        this.randomNumberGenerator = options.randomNumberGenerator ?? Math.random;
        this.onUnownedSchedulesDetected = options.onUnownedSchedulesDetected ?? (() => undefined);

        if (options.ownership) {
            const { capacity } = options.ownership;
            if (capacity !== "all" && !(Number.isInteger(capacity) && capacity > 0)) {
                throw new Error(
                    `ownership.capacity must be "all" or a positive integer, received ${String(capacity)}.`,
                );
            }
        }

        this.ownership = options.ownership
            ? {
                  processId: options.ownership.processId ?? generateProcessId(),
                  capacity: options.ownership.capacity,
                  leaseTtlMilliseconds:
                      options.ownership.leaseTtlMilliseconds ?? this.pollIntervalMilliseconds * 3,
                  releaseOnStop: options.ownership.releaseOnStop ?? true,
                  fireUnownedAsSafetyNet: options.ownership.fireUnownedAsSafetyNet ?? true,
              }
            : null;
    }

    /**
     * The id this process uses for ownership leases, or `null` when ownership
     * is off.
     */
    public get processId(): string | null {
        return this.ownership?.processId ?? null;
    }

    // ---------------------------------------------------------------------------
    // Recurring (cron) schedule management
    // ---------------------------------------------------------------------------

    /**
     * Registers a recurring schedule, or updates it if one with the same name
     * already exists. Registration is idempotent by name, so calling this on
     * every boot is safe: an unchanged schedule keeps its firing history rather
     * than resetting.
     *
     * The cron expression and time zone are validated immediately, so a
     * malformed schedule throws here rather than failing quietly on a later
     * tick.
     *
     * @returns The resulting stored schedule.
     */
    public async registerCron(options: CronScheduleOptions): Promise<CronSchedule> {
        assertValidCronExpression(options.cronExpression, options.timeZone);

        const timestamp = this.now();
        const timeZone = options.timeZone ?? null;
        const schedule: CronSchedule = {
            name: options.name,
            cronExpression: options.cronExpression,
            timeZone,
            workflowName: options.workflowName,
            payload: options.payload ?? null,
            catchUp: options.catchUp ?? false,
            status: CronScheduleStatus.ACTIVE,
            // First occurrence is the next one strictly after "now".
            nextRunAt: computeNextCronRun(options.cronExpression, timestamp, timeZone),
            lastRunAt: null,
            leaseOwner: null,
            leaseExpiresAt: null,
            createdAt: timestamp,
            updatedAt: timestamp,
        };

        await this.storage.upsertCronSchedule(schedule);
        return (await this.storage.getCronSchedule(options.name)) ?? schedule;
    }

    /**
     * Updates an existing schedule's definition in place, preserving its
     * identity and firing history. Any subset of the mutable fields may be
     * changed; omitted fields keep their current value.
     *
     * When the cron expression or time zone changes, `nextRunAt` is recomputed
     * from now so the new cadence takes effect immediately rather than waiting
     * for the old `nextRunAt` to pass. The expression and zone are validated up
     * front, so an invalid update throws here and leaves the stored schedule
     * untouched.
     *
     * @returns The updated schedule, or `null` when no schedule with `name`
     *   exists.
     */
    public async updateCron(
        name: string,
        changes: {
            cronExpression?: string;
            timeZone?: string | null;
            payload?: string | null;
            catchUp?: boolean;
            workflowName?: string;
        },
    ): Promise<CronSchedule | null> {
        const existing = await this.storage.getCronSchedule(name);
        if (!existing) {
            return null;
        }

        const cronExpression = changes.cronExpression ?? existing.cronExpression;
        const timeZone = changes.timeZone !== undefined ? changes.timeZone : existing.timeZone;

        // Validate the resulting cadence before persisting anything.
        const cadenceChanged =
            changes.cronExpression !== undefined || changes.timeZone !== undefined;
        if (cadenceChanged) {
            assertValidCronExpression(cronExpression, timeZone);
        }

        const timestamp = this.now();
        const updated: CronSchedule = {
            ...existing,
            cronExpression,
            timeZone,
            payload: changes.payload !== undefined ? changes.payload : existing.payload,
            catchUp: changes.catchUp !== undefined ? changes.catchUp : existing.catchUp,
            workflowName: changes.workflowName ?? existing.workflowName,
            // Recompute the next fire only when the cadence itself changed; otherwise
            // preserve the schedule's place in its cycle.
            nextRunAt: cadenceChanged
                ? computeNextCronRun(cronExpression, timestamp, timeZone)
                : existing.nextRunAt,
            updatedAt: timestamp,
        };

        // upsertCronSchedule preserves history for an existing name, so set the
        // fields it does not overwrite (nextRunAt) via a direct replace path: we
        // remove and re-add so the new nextRunAt takes effect. Because upsert keeps
        // running nextRunAt for existing schedules, replacing is the reliable way to
        // change cadence.
        await this.storage.removeCronSchedule(name);
        await this.storage.upsertCronSchedule(updated);
        return (await this.storage.getCronSchedule(name)) ?? updated;
    }

    /**
     * Replays every occurrence of a schedule within a historical `[start, end]`
     * window through the fire handler, without disturbing the schedule's live
     * cadence. This is how you run a schedule "as if" it had been firing over a
     * past period — for example to backfill a nightly report for a week the
     * process was down, or to reprocess a range after fixing a bug.
     *
     * Each occurrence is dispatched with a distinct, deterministic workflow
     * identifier that includes the instant, so a backfill is idempotent:
     * running it twice resolves each occurrence to the same workflow execution,
     * which the engine memoises rather than double-running. The schedule's own
     * `nextRunAt` is never touched.
     *
     * @param name The schedule to backfill.
     * @param start The inclusive start of the window.
     * @param end The inclusive end of the window.
     * @returns The workflow identifiers dispatched, in chronological order, or
     *   an empty array when the schedule does not exist or no handler is set.
     */
    public async backfillCron(name: string, start: Date, end: Date): Promise<string[]> {
        const handler = this.cronHandler;
        if (!handler) {
            return [];
        }
        const schedule = await this.storage.getCronSchedule(name);
        if (!schedule) {
            return [];
        }
        if (isAfter(start, end)) {
            throw new Error(
                `backfillCron start (${start.toISOString()}) must not be after end (${end.toISOString()}).`,
            );
        }

        // Enumerate occurrences in (start - 1ms, end], i.e. inclusive of start, so a
        // window that begins exactly on an occurrence includes it. The count is
        // bounded per call by maxCatchUpPerTick to prevent an unbounded burst.
        const from = subMilliseconds(start, 1);
        const occurrences = enumerateMissedCronRuns(
            schedule.cronExpression,
            from,
            end,
            schedule.timeZone,
            this.maxCatchUpPerTick,
        );

        const dispatched: string[] = [];
        for (const scheduledFor of occurrences) {
            const workflowIdentifier = composeCronWorkflowIdentifier(
                name,
                scheduledFor,
                "backfill",
            );
            try {
                await handler({
                    schedule,
                    scheduledFor,
                    workflowIdentifier,
                    payload: schedule.payload,
                });
                dispatched.push(workflowIdentifier);
            } catch (error) {
                // Report and continue so one failed occurrence does not abort the range.
                this.onHandlerError(name, error);
            }
        }
        return dispatched;
    }

    /**
     * Pauses a schedule so it stops firing. Returns `false` when it does not
     * exist.
     */
    public pauseCron(name: string): Promise<boolean> {
        return this.storage.setCronScheduleStatus(name, CronScheduleStatus.PAUSED);
    }

    /**
     * Resumes a paused schedule. Returns `false` when it does not exist.
     */
    public resumeCron(name: string): Promise<boolean> {
        return this.storage.setCronScheduleStatus(name, CronScheduleStatus.ACTIVE);
    }

    /**
     * Permanently removes a schedule. Returns `false` when it did not exist.
     */
    public removeCron(name: string): Promise<boolean> {
        return this.storage.removeCronSchedule(name);
    }

    /**
     * Lists all registered cron schedules.
     */
    public listCronSchedules(): Promise<CronSchedule[]> {
        return this.storage.listCronSchedules();
    }

    /**
     * Fires a schedule immediately, out of band, in addition to its normal
     * cadence. Useful for "run it now" buttons and for testing a schedule's
     * workflow without waiting for its next occurrence. The schedule's own
     * `nextRunAt` is left untouched.
     *
     * @returns The deterministic workflow identifier used for the manual fire,
     *   or `null` when no cron handler is set or the schedule does not exist.
     */
    public async triggerCron(name: string): Promise<string | null> {
        if (!this.cronHandler) {
            return null;
        }
        const schedule = await this.storage.getCronSchedule(name);
        if (!schedule) {
            return null;
        }
        const firedAt = this.now();
        const workflowIdentifier = composeCronWorkflowIdentifier(name, firedAt, "manual");
        await this.cronHandler({
            schedule,
            scheduledFor: firedAt,
            workflowIdentifier,
            payload: schedule.payload,
        });
        return workflowIdentifier;
    }

    /**
     * Registers the handler invoked for each due cron fire. Call this once,
     * before or after {@link Scheduler.start}; the polling loop dispatches cron
     * fires only while a handler is set.
     */
    public onCronFire(handler: CronFireHandler): void {
        this.cronHandler = handler;
    }

    // ---------------------------------------------------------------------------
    // Polling loop
    // ---------------------------------------------------------------------------

    /**
     * Starts the polling loop in the background. The loop continues until
     * {@link Scheduler.stop} is called. Calling `start` while already running is
     * a no-op.
     */
    public start(handler: DueTimerHandler): void {
        if (this.running) {
            return;
        }
        this.running = true;
        this.loopPromise = this.runLoop(handler);
    }

    /**
     * Stops the polling loop and waits for the current cycle to finish, so
     * callers can shut down cleanly.
     */
    public async stop(): Promise<void> {
        this.running = false;
        if (this.loopPromise) {
            await this.loopPromise;
            this.loopPromise = null;
        }
        // Hand our owned schedules back promptly so peers do not wait for expiry.
        if (this.ownership && this.ownership.releaseOnStop) {
            await this.storage.releaseCronLeases(this.ownership.processId);
        }
    }

    /**
     * Runs poll cycles separated by the configured interval until stopped.
     */
    private async runLoop(handler: DueTimerHandler): Promise<void> {
        while (this.running) {
            await this.tick(handler);
            if (this.running) {
                await this.sleep(this.pollIntervalMilliseconds);
            }
        }
    }

    /**
     * Performs a single scheduler tick: claim a batch of due one-shot timers
     * and dispatch each, then fire any due cron schedules. This is exposed
     * publicly so tests can drive one tick deterministically without running
     * the unbounded loop.
     *
     * @returns The number of one-shot timers dispatched during this tick.
     */
    public async tick(handler: DueTimerHandler): Promise<number> {
        const dueTimers = await this.storage.claimDueTimers(this.now(), this.batchSize);

        for (const timer of dueTimers) {
            try {
                await handler(timer);
            } catch (error) {
                // The timer has already been marked processed by claimDueTimers. We
                // report the failure rather than rethrow it so that one failing timer
                // cannot stall the loop or block sibling timers in the same batch.
                this.onHandlerError(timer.workflowIdentifier, error);
            }
        }

        await this.tickCron();

        return dueTimers.length;
    }

    /**
     * Fires every cron schedule that is due. Each claim atomically advances the
     * schedule to its next occurrence, so this is safe to run from several
     * instances at once. Exposed for deterministic testing.
     *
     * @returns The number of cron occurrences dispatched during this tick.
     */
    public async tickCron(): Promise<number> {
        const handler = this.cronHandler;
        if (!handler) {
            return 0;
        }

        const now = this.now();

        // Under the ownership model, first renew the leases we hold and top up
        // toward our target from the free/expired pool, then fire only what we own.
        // Without it, we consider every due schedule.
        let owner: string | undefined;
        if (this.ownership) {
            owner = this.ownership.processId;
            await this.maintainOwnership(now);
        }

        const advance = (schedule: CronSchedule): Date =>
            // Advance the schedule to its first occurrence strictly after "now", not
            // merely after the occurrence that came due. This collapses every window
            // missed during an outage into a single claim, so the schedule is never
            // left pointing at an already-past occurrence and cannot be double-fired.
            computeNextCronRun(schedule.cronExpression, now, schedule.timeZone);

        const claimed = await this.storage.claimDueCronSchedules(
            now,
            this.batchSize,
            advance,
            owner,
        );
        let dispatched = await this.dispatchClaimed(handler, claimed, now);

        // Safety net: if this process owns a bounded slice, some due schedules may
        // be unowned because the fleet's total capacity is below the schedule count
        // (for example two processes of 50 covering 101 schedules leave one over).
        // Rather than let that schedule starve, a process with the net enabled also
        // fires due-but-unowned schedules. Their count is reported so the shortfall
        // is observable. A process that owns everything ("all") needs no net.
        if (
            this.ownership &&
            this.ownership.fireUnownedAsSafetyNet &&
            this.ownership.capacity !== "all"
        ) {
            const orphans = await this.storage.claimDueUnownedCronSchedules(
                now,
                this.batchSize,
                advance,
            );
            if (orphans.length > 0) {
                this.onUnownedSchedulesDetected(orphans.length);
                dispatched += await this.dispatchClaimed(handler, orphans, now);
            }
        }

        return dispatched;
    }

    /**
     * Dispatches a batch of claimed cron occurrences through the fire handler,
     * expanding catch-up occurrences and applying jitter to each. Handler
     * failures are reported and swallowed so one bad fire cannot stall the
     * batch.
     *
     * @returns The number of occurrences dispatched.
     */
    private async dispatchClaimed(
        handler: CronFireHandler,
        claimed: Array<{ schedule: CronSchedule; firedAt: Date }>,
        now: Date,
    ): Promise<number> {
        let dispatched = 0;
        for (const { schedule, firedAt } of claimed) {
            // Without catch-up we fire only the occurrence that just came due. With
            // catch-up we replay each occurrence missed since the schedule last fired
            // (or was created), up to "now".
            const occurrences = this.resolveOccurrences(schedule, firedAt, now);

            for (const scheduledFor of occurrences) {
                const dispatchAt = applyCronJitter(
                    scheduledFor,
                    this.cronJitterMilliseconds,
                    this.randomNumberGenerator,
                );
                const delayMilliseconds = differenceInMilliseconds(dispatchAt, this.now());
                if (delayMilliseconds > 0) {
                    await this.sleep(delayMilliseconds);
                }

                try {
                    await handler({
                        schedule,
                        scheduledFor,
                        workflowIdentifier: composeCronWorkflowIdentifier(
                            schedule.name,
                            scheduledFor,
                        ),
                        payload: schedule.payload,
                    });
                    dispatched += 1;
                } catch (error) {
                    // Report and continue: a single failing fire must not stall the loop.
                    this.onHandlerError(schedule.name, error);
                }
            }
        }
        return dispatched;
    }

    /**
     * Renews this process's ownership leases (the heartbeat that keeps our
     * slice) and, if we hold fewer than our target, acquires more from the free
     * or expired pool. Runs once per cron tick before firing. Called only when
     * the ownership model is enabled.
     */
    private async maintainOwnership(now: Date): Promise<void> {
        const ownership = this.ownership;
        if (!ownership) {
            return;
        }
        const expiresAt = addMilliseconds(now, ownership.leaseTtlMilliseconds);

        // 1. Renew what we already hold so a live process keeps its schedules.
        await this.storage.renewCronLeases(ownership.processId, expiresAt);

        // 2. Top up from schedules that are free or whose lease has expired. The
        //    atomic acquire prevents two processes taking the same schedule; we only
        //    size the request. For "all", request the whole batch each tick so this
        //    process sweeps up everything free; for a numeric capacity, request just
        //    the deficit below the target so the process stays bounded.
        if (ownership.capacity === "all") {
            await this.storage.acquireCronSchedules(
                ownership.processId,
                now,
                expiresAt,
                this.batchSize,
            );
            return;
        }
        const owned = await this.storage.countOwnedCronSchedules(ownership.processId, now);
        const deficit = ownership.capacity - owned;
        if (deficit > 0) {
            await this.storage.acquireCronSchedules(ownership.processId, now, expiresAt, deficit);
        }
    }

    /**
     * Computes the set of occurrences to dispatch for a claimed schedule. The
     * claim already advanced the schedule past `firedAt`; here we optionally
     * fold in the earlier occurrences that were missed while the process was
     * down.
     */
    private resolveOccurrences(schedule: CronSchedule, firedAt: Date, now: Date): Date[] {
        if (!schedule.catchUp) {
            // Fire only the occurrence that was due (the schedule's former nextRunAt).
            return [firedAt];
        }
        // Replay every occurrence in (lastFire, now], where lastFire is the last
        // successful fire or, failing that, the schedule's creation time. This
        // includes the occurrence that came due and any windows missed during an
        // outage, in chronological order and capped to bound the recovery burst.
        const from = schedule.lastRunAt ?? schedule.createdAt;
        const missed = enumerateMissedCronRuns(
            schedule.cronExpression,
            from,
            now,
            schedule.timeZone,
            this.maxCatchUpPerTick,
        );
        return missed.length > 0 ? missed : [firedAt];
    }

    /**
     * Pauses for the given number of milliseconds.
     */
    private sleep(milliseconds: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, milliseconds));
    }
}

/**
 * Builds a deterministic workflow identifier for a cron fire from the schedule
 * name and the exact scheduled instant. Because the instant is part of the key,
 * dispatching the same occurrence twice resolves to the same workflow
 * execution, which the engine then memoises rather than running again, giving
 * exactly-once semantics per occurrence even across concurrent schedulers.
 */
function composeCronWorkflowIdentifier(name: string, scheduledFor: Date, suffix?: string): string {
    const base = `cron-${name}-${scheduledFor.toISOString()}`;
    return suffix ? `${base}-${suffix}` : base;
}

/**
 * Generates a per-process ownership id. Uses `crypto.randomUUID` when available
 * and falls back to a timestamp-plus-random string otherwise, which is enough
 * to distinguish processes for lease ownership.
 */
function generateProcessId(): string {
    const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
    if (cryptoObject?.randomUUID) {
        return `scheduler-${cryptoObject.randomUUID()}`;
    }
    return `scheduler-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
