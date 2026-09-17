import { CronExpressionParser } from "cron-parser";
import { addMilliseconds, compareAsc, isAfter } from "date-fns";
import { getTimezoneOffset } from "date-fns-tz";

/**
 * The default jitter ceiling applied to a cron fire, in milliseconds.
 *
 * Jitter spreads the actual dispatch of a fire across a small random window
 * after its scheduled instant. See {@link applyCronJitter} for why this exists.
 */
export const DEFAULT_CRON_JITTER_MILLISECONDS = 10_000;

/**
 * Thrown when a cron expression or time zone cannot be parsed. Surfacing a
 * dedicated error lets callers give the user a precise message at the point
 * they register a schedule, rather than failing silently later on a tick.
 */
export class InvalidCronExpressionError extends Error {
    public constructor(cronExpression: string, cause: unknown) {
        const reason = cause instanceof Error ? cause.message : String(cause);
        super(`Invalid cron expression "${cronExpression}": ${reason}`);
        this.name = "InvalidCronExpressionError";
    }
}

/**
 * Thrown when a time zone identifier is not a recognised IANA zone.
 */
export class InvalidTimeZoneError extends Error {
    public constructor(timeZone: string) {
        super(`Unknown time zone "${timeZone}". Expected an IANA zone like "America/New_York".`);
        this.name = "InvalidTimeZoneError";
    }
}

/**
 * Validates an IANA time zone identifier using {@link date-fns-tz}. A valid zone
 * yields a finite offset; an unknown zone yields `NaN`, which we reject. UTC is
 * always accepted.
 */
export function assertValidTimeZone(timeZone: string): void {
    if (timeZone === "UTC") {
        return;
    }
    const offset = getTimezoneOffset(timeZone);
    if (Number.isNaN(offset)) {
        throw new InvalidTimeZoneError(timeZone);
    }
}

/**
 * Validates a cron expression (and optional time zone) by attempting to parse
 * it. Throws {@link InvalidCronExpressionError} or {@link InvalidTimeZoneError}
 * when either is malformed. Call this when a schedule is registered so mistakes
 * are caught immediately.
 */
export function assertValidCronExpression(cronExpression: string, timeZone?: string | null): void {
    if (timeZone) {
        assertValidTimeZone(timeZone);
    }
    try {
        CronExpressionParser.parse(cronExpression, {
            tz: timeZone ?? "UTC",
            currentDate: new Date(0),
        });
    } catch (error) {
        throw new InvalidCronExpressionError(cronExpression, error);
    }
}

/**
 * Computes the first occurrence of `cronExpression` strictly after `after`,
 * evaluated in `timeZone` (defaulting to UTC). Time-zone awareness means an
 * expression like `"0 9 * * *"` fires at nine in the morning local time even
 * across daylight-saving changes, rather than drifting with the UTC offset.
 *
 * @param cronExpression A standard five- or six-field cron expression.
 * @param after The exclusive lower bound; the returned time is strictly later.
 * @param timeZone An IANA zone the expression is evaluated in.
 * @returns The next fire instant as a UTC `Date`.
 */
export function computeNextCronRun(
    cronExpression: string,
    after: Date,
    timeZone?: string | null,
): Date {
    const interval = CronExpressionParser.parse(cronExpression, {
        tz: timeZone ?? "UTC",
        currentDate: after,
    });
    return interval.next().toDate();
}

/**
 * Enumerates every occurrence of `cronExpression` in the half-open interval
 * `(after, until]`, evaluated in `timeZone`. Used to replay fires that were
 * missed while the process was down when a schedule opts into catch-up.
 *
 * The result is capped by `limit` so a schedule that was paused for a very long
 * time cannot produce an unbounded burst of fires on recovery.
 *
 * @returns The missed occurrences in chronological order, at most `limit` of
 *   them.
 */
export function enumerateMissedCronRuns(
    cronExpression: string,
    after: Date,
    until: Date,
    timeZone: string | null | undefined,
    limit: number,
): Date[] {
    const runs: Date[] = [];
    if (limit <= 0) {
        return runs;
    }
    const interval = CronExpressionParser.parse(cronExpression, {
        tz: timeZone ?? "UTC",
        currentDate: after,
    });
    while (runs.length < limit) {
        const next = interval.next().toDate();
        if (isAfter(next, until)) {
            break;
        }
        runs.push(next);
    }
    return runs;
}

/**
 * Adds a small random delay, drawn uniformly from `[0, ceiling]`, to a fire's
 * scheduled instant.
 *
 * ## Why jitter exists
 *
 * Many cron schedules land on round times: the top of the hour, midnight, the
 * start of the week. When several schedules (or several application instances
 * sharing one schedule) all become due at the exact same instant, they would
 * otherwise stampede the database and any downstream systems in lockstep. This
 * is the classic _thundering herd_. Spreading each fire by a random fraction of
 * a small window smooths that spike into a short ramp, without meaningfully
 * delaying the work. The same reasoning drives the jitter in retry backoff.
 *
 * @param scheduledInstant The exact instant the schedule was due.
 * @param ceilingMilliseconds The maximum delay to add.
 * @param random A source of randomness in `[0, 1)`; injectable for tests.
 * @returns The (possibly) delayed dispatch instant.
 */
export function applyCronJitter(
    scheduledInstant: Date,
    ceilingMilliseconds: number = DEFAULT_CRON_JITTER_MILLISECONDS,
    random: () => number = Math.random,
): Date {
    if (ceilingMilliseconds <= 0) {
        return scheduledInstant;
    }
    const offset = Math.floor(random() * ceilingMilliseconds);
    return addMilliseconds(scheduledInstant, offset);
}

/**
 * Orders two lease expiry times by how long each has been free, so that
 * acquisition prefers the longest-free schedules and ownership spreads rather
 * than repeatedly landing on the same rows.
 *
 * A `null` expiry means the schedule has never been owned, which is "most free"
 * and therefore sorts first. Two non-null expiries are ordered oldest-first
 * with {@link date-fns#compareAsc}.
 */
export function compareLeaseFreedom(a: Date | null, b: Date | null): number {
    if (a === null && b === null) {
        return 0;
    }
    if (a === null) {
        return -1;
    }
    if (b === null) {
        return 1;
    }
    return compareAsc(a, b);
}
