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
