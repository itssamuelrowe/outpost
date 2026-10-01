import { addMilliseconds, differenceInMilliseconds, isAfter, subMilliseconds } from "date-fns";

import { CronScheduleStatus } from "../enums/cron-schedule-status.enum.js";
import type { CronSchedule } from "../entities/cron-schedule.entity.js";
import type { StorageAdapter } from "../interfaces/storage-adapter.interface.js";
import { CronUtility } from "../utilities/cron.utility.js";
import { SchedulerIdentifier } from "../utilities/scheduler-identifier.utility.js";
import type { DueCronSchedule } from "../entities/due-cron-schedule.entity.js";
import type {
    CronFireHandler,
    CronScheduleOptions,
    CronScheduleUpdate,
    DueTimerHandler,
    HandlerErrorReporter,
    ResolvedOwnership,
    SchedulerOptions,
    UnownedSchedulesReporter,
} from "./scheduler-options.js";

/*
 * Re-export the scheduler's public option and handler types so consumers can
 * import them alongside the class from this module. The resolved-ownership and
 * reporter shapes stay internal and are intentionally omitted.
 */
export type {
    CronFireHandler,
    CronScheduleOptions,
    CronScheduleUpdate,
    DueTimerHandler,
    OwnershipCapacity,
    OwnershipOptions,
    SchedulerOptions,
} from "./scheduler-options.js";

export interface TickResult {
    dispatchedTimers: number;
    dispatchedCrons: number;
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
    /**
     * The storage backend that persists timers and cron schedules.
     */
    private readonly storage: StorageAdapter;

    /**
     * Milliseconds the polling loop waits between successive ticks.
     */
    private readonly pollIntervalMilliseconds: number;

    /**
     * The maximum number of due timers (and cron schedules) claimed per tick,
     * bounding the work a single cycle takes on.
     */
    private readonly batchSize: number;

    /**
     * The clock used for every time comparison and computation. Injectable so
     * tests can advance time deterministically rather than relying on the wall
     * clock.
     */
    private readonly now: () => Date;

    /**
     * Invoked when a timer or cron handler throws. Failures are reported here
     * rather than rethrown so one bad dispatch cannot stall the loop or block
     * sibling work in the same batch.
     */
    private readonly onHandlerError: HandlerErrorReporter;

    /**
     * The upper bound on occurrences replayed in a single tick (catch-up) or
     * backfill call, so a schedule paused for a long time cannot produce an
     * unbounded burst of fires on recovery.
     */
    private readonly maxCatchUpPerTick: number;

    /**
     * The ceiling of the random delay added to each cron fire to spread
     * simultaneous occurrences and avoid a thundering herd. Zero fires at the
     * exact instant.
     */
    private readonly cronJitterMilliseconds: number;

    /**
     * The source of randomness for jitter. Injectable so tests can make jitter
     * deterministic.
     */
    private readonly randomNumberGenerator: () => number;

    /**
     * Reports how many due-but-unowned schedules the safety net fired, so a
     * fleet whose total capacity is below the schedule count stays observable.
     */
    private readonly onUnownedSchedulesDetected: UnownedSchedulesReporter;

    /**
     * Resolved ownership configuration, or `null` when the ownership model is
     * off.
     */
    private readonly ownership: ResolvedOwnership | null;

    /**
     * Whether the polling loop is currently running.
     */
    private running = false;

    /**
     * The promise for the active polling loop, retained so
     * {@link Scheduler.stop} can await the current cycle before returning.
     * `null` while stopped.
     */
    private loopPromise: Promise<void> | null = null;

    /**
     * The handler invoked for each due cron fire, or `null` when none is set.
     * Cron fires are dispatched only while a handler is registered.
     */
    private cronHandler: CronFireHandler | null = null;

    public constructor(storage: StorageAdapter, options: SchedulerOptions = {}) {
        this.storage = storage;
        this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 1_000;
        this.batchSize = options.batchSize ?? 50;
        this.now = options.now ?? (() => new Date());
        this.onHandlerError = options.onHandlerError ?? (() => undefined);
        this.maxCatchUpPerTick = options.maxCatchUpPerTick ?? 100;
        this.cronJitterMilliseconds =
            options.cronJitterMilliseconds ?? CronUtility.DEFAULT_JITTER_MILLISECONDS;
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
                  processId: options.ownership.processId ?? SchedulerIdentifier.generateProcessId(),
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

    /*
     * ---------------------------------------------------------------------------
     * Recurring (cron) schedule management
     * ---------------------------------------------------------------------------
     */

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
        CronUtility.assertValidCronExpression(options.cronExpression, options.timeZone);

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
            /* First occurrence is the next one strictly after "now". */
            nextRunAt: CronUtility.computeNextCronRun(options.cronExpression, timestamp, timeZone),
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
        changes: CronScheduleUpdate,
    ): Promise<CronSchedule | null> {
        const existing = await this.storage.getCronSchedule(name);
        if (!existing) {
            return null;
        }

        const cronExpression = changes.cronExpression ?? existing.cronExpression;
        let timeZone = existing.timeZone;
        if (changes.timeZone !== undefined) {
            timeZone = changes.timeZone;
        }

        /* Validate the resulting cadence before persisting anything. */
        const cadenceChanged =
            changes.cronExpression !== undefined || changes.timeZone !== undefined;
        if (cadenceChanged) {
            CronUtility.assertValidCronExpression(cronExpression, timeZone);
        }

        const timestamp = this.now();
        const updated: CronSchedule = {
            ...existing,
            cronExpression,
            timeZone,
            payload: changes.payload !== undefined ? changes.payload : existing.payload,
            catchUp: changes.catchUp !== undefined ? changes.catchUp : existing.catchUp,
            workflowName: changes.workflowName ?? existing.workflowName,
            /*
             * Recompute the next fire only when the cadence itself changed;
             * otherwise preserve the schedule's place in its cycle.
             */
            nextRunAt: cadenceChanged
                ? CronUtility.computeNextCronRun(cronExpression, timestamp, timeZone)
                : existing.nextRunAt,
            updatedAt: timestamp,
        };

        /*
         * upsertCronSchedule preserves history for an existing name, so set the
         * fields it does not overwrite (nextRunAt) via a direct replace path: we
         * remove and re-add so the new nextRunAt takes effect. Because upsert
         * keeps running nextRunAt for existing schedules, replacing is the
         * reliable way to change cadence.
         */
        await this.storage.removeCronSchedule(name);
        await this.storage.upsertCronSchedule(updated);
        return (await this.storage.getCronSchedule(name)) ?? updated;
    }

    /**
     * Replays every occurrence of a schedule within a historical `[start, end]`
     * window through the fire handler, without disturbing the schedule's live
     * cadence. This is how you run a schedule "as if" it had been firing over a
     * past period, for example to backfill a nightly report for a week the
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

        /*
         * Enumerate occurrences in (start - 1ms, end], i.e. inclusive of start,
         * so a window that begins exactly on an occurrence includes it. The count
         * is bounded per call by maxCatchUpPerTick to prevent an unbounded burst.
         */
        const from = subMilliseconds(start, 1);
        const occurrences = CronUtility.enumerateMissedCronRuns(
            schedule.cronExpression,
            from,
            end,
            schedule.timeZone,
            this.maxCatchUpPerTick,
        );

        const dispatched: string[] = [];
        for (const scheduledFor of occurrences) {
            const workflowId = SchedulerIdentifier.composeCronWorkflowId(
                name,
                scheduledFor,
                "backfill",
            );
            try {
                await handler({
                    schedule,
                    scheduledFor,
                    workflowId,
                    payload: schedule.payload,
                });
                dispatched.push(workflowId);
            } catch (error) {
                /* Report and continue so one failed occurrence does not abort the range. */
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
        const workflowId = SchedulerIdentifier.composeCronWorkflowId(name, firedAt, "manual");
        await this.cronHandler({
            schedule,
            scheduledFor: firedAt,
            workflowId,
            payload: schedule.payload,
        });
        return workflowId;
    }

    /**
     * Registers the handler invoked for each due cron fire. Call this once,
     * before or after {@link Scheduler.start}; the polling loop dispatches cron
     * fires only while a handler is set.
     */
    public onCronFire(handler: CronFireHandler): void {
        this.cronHandler = handler;
    }

    /*
     * ---------------------------------------------------------------------------
     * Polling loop
     * ---------------------------------------------------------------------------
     */

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
        /* Hand our owned schedules back promptly so peers do not wait for expiry. */
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
     * Performs a single scheduler tick: dispatch any due one-shot timers, then
     * fire any due cron schedules. It delegates to {@link Scheduler.tickTimers}
     * and {@link Scheduler.tickCron} so each concern stays self-contained. This
     * is exposed publicly so tests can drive one tick deterministically without
     * running the unbounded loop.
     *
     * @returns The number of one-shot timers dispatched during this tick.
     */
    public async tick(handler: DueTimerHandler): Promise<TickResult> {
        const dispatchedTimers = await this.tickTimers(handler);
        const dispatchedCrons = await this.tickCron();
        return { dispatchedTimers, dispatchedCrons };
    }

    /**
     * Claims a batch of due one-shot timers and dispatches each through the
     * handler. A handler failure is reported rather than rethrown, so one bad
     * timer cannot stall the loop or block sibling timers in the same batch.
     * Exposed for deterministic testing.
     *
     * @returns The number of one-shot timers dispatched during this tick.
     */
    public async tickTimers(handler: DueTimerHandler): Promise<number> {
        const dueTimers = await this.storage.claimDueTimers(this.now(), this.batchSize);

        for (const timer of dueTimers) {
            try {
                await handler(timer);
            } catch (error) {
                /*
                 * The timer has already been marked processed by claimDueTimers.
                 * We report the failure rather than rethrow it so that one failing
                 * timer cannot stall the loop or block sibling timers in the same
                 * batch.
                 */
                this.onHandlerError(timer.workflowId, error);
            }
        }

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

        /*
         * Under the ownership model, first renew the leases we hold and top up
         * toward our target from the free/expired pool, then fire only what we
         * own. Without it, we consider every due schedule.
         */
        let owner: string | undefined;
        if (this.ownership) {
            owner = this.ownership.processId;
            await this.maintainOwnership(now);
        }

        const advance = (schedule: CronSchedule): Date =>
            /*
             * Advance the schedule to its first occurrence strictly after "now",
             * not merely after the occurrence that came due. This collapses every
             * window missed during an outage into a single claim, so the schedule
             * is never left pointing at an already-past occurrence and cannot be
             * double-fired.
             */
            CronUtility.computeNextCronRun(schedule.cronExpression, now, schedule.timeZone);

        const claimed = await this.storage.claimDueCronSchedules(
            now,
            this.batchSize,
            advance,
            owner,
        );
        let dispatched = await this.dispatchClaimed(handler, claimed, now);

        /*
         * Safety net: if this process owns a bounded slice, some due schedules
         * may be unowned because the fleet's total capacity is below the schedule
         * count (for example two processes of 50 covering 101 schedules leave one
         * over). Rather than let that schedule starve, a process with the net
         * enabled also fires due-but-unowned schedules. Their count is reported so
         * the shortfall is observable. A process that owns everything ("all")
         * needs no net.
         */
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
        claimed: DueCronSchedule[],
        now: Date,
    ): Promise<number> {
        let dispatched = 0;
        for (const { schedule, firedAt } of claimed) {
            /*
             * Without catch-up we fire only the occurrence that just came due.
             * With catch-up we replay each occurrence missed since the schedule
             * last fired (or was created), up to "now".
             */
            const occurrences = this.resolveOccurrences(schedule, firedAt, now);

            for (const scheduledFor of occurrences) {
                const dispatchAt = CronUtility.applyJitter(
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
                        workflowId: SchedulerIdentifier.composeCronWorkflowId(
                            schedule.name,
                            scheduledFor,
                        ),
                        payload: schedule.payload,
                    });
                    dispatched += 1;
                } catch (error) {
                    /* Report and continue: a single failing fire must not stall the loop. */
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

        /* 1. Renew what we already hold so a live process keeps its schedules. */
        await this.storage.renewCronLeases(ownership.processId, expiresAt);

        /*
         * 2. Top up from schedules that are free or whose lease has expired. The
         *    atomic acquire prevents two processes taking the same schedule; we
         *    only size the request. For "all", request the whole batch each tick
         *    so this process sweeps up everything free; for a numeric capacity,
         *    request just the deficit below the target so the process stays
         *    bounded.
         */
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
            /* Fire only the occurrence that was due (the schedule's former nextRunAt). */
            return [firedAt];
        }
        /*
         * Replay every occurrence in (lastFire, now], where lastFire is the last
         * successful fire or, failing that, the schedule's creation time. This
         * includes the occurrence that came due and any windows missed during an
         * outage, in chronological order and capped to bound the recovery burst.
         */
        const from = schedule.lastRunAt ?? schedule.createdAt;
        const missed = CronUtility.enumerateMissedCronRuns(
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
