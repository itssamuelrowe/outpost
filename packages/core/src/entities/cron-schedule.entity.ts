import type { CronScheduleStatus } from "../enums/cron-schedule-status.enum.js";

/**
 * A persisted recurring schedule (a "durable cron job").
 *
 * A cron schedule is a long-lived definition, not a one-shot timer. The
 * scheduler evaluates it on each tick: when `nextRunAt` is due it invokes the
 * handler and advances `nextRunAt` to the following occurrence, so the schedule
 * keeps firing across process restarts. This is the durable analogue of a
 * classic crontab line.
 */
export interface CronSchedule {
    /**
     * A stable, unique name for the schedule (used to pause/resume/remove it).
     */
    name: string;
    /**
     * The cron expression that defines the recurrence (five or six fields).
     */
    cronExpression: string;
    /**
     * The IANA time zone the expression is evaluated in (for example
     * `"America/New_York"`). Defaults to UTC when omitted. Storing the zone
     * with the schedule keeps `"0 9 * * *"` meaning nine in the morning
     * locally, including across daylight-saving transitions.
     */
    timeZone: string | null;
    /**
     * The workflow name to run when the schedule fires. The scheduler passes
     * this to the application-supplied handler, which maps it to a runnable
     * workflow.
     */
    workflowName: string;
    /**
     * An optional serialized payload delivered to the handler on each fire.
     */
    payload: string | null;
    /**
     * When `true`, fires missed while the process was down are replayed on
     * recovery, one per missed occurrence. When `false`, missed windows are
     * skipped and the schedule simply resumes at the next future occurrence.
     */
    catchUp: boolean;
    /**
     * Whether the schedule is currently firing.
     */
    status: CronScheduleStatus;
    /**
     * The next instant at which the schedule is due to fire.
     */
    nextRunAt: Date;
    /**
     * The last instant the schedule actually fired, or `null` if it never has.
     */
    lastRunAt: Date | null;
    /**
     * The id of the process that currently owns (is responsible for evaluating)
     * this schedule, or `null` when unowned. Ownership is an optional
     * load-distribution lease: when several processes run the scheduler, each
     * owns a slice of the schedules and evaluates only those. It never affects
     * correctness, which rests on the atomic `nextRunAt` advance at fire time.
     */
    leaseOwner: string | null;
    /**
     * The instant this ownership lease goes stale if the owner does not renew
     * it. A crashed owner stops renewing, so its schedules become claimable by
     * other processes once this time passes. `null` when the schedule is
     * unowned.
     */
    leaseExpiresAt: Date | null;
    /**
     * The moment the schedule record was created.
     */
    createdAt: Date;
    /**
     * The moment the schedule was last updated.
     */
    updatedAt: Date;
}
