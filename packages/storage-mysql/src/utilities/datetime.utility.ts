import { formatInTimeZone } from "date-fns-tz";

/**
 * Formats an instant as a UTC MySQL `DATETIME(3)` literal.
 *
 * All timestamps are stored and compared in UTC to eliminate any skew between
 * the application's clock and the database session's timezone. `date-fns-tz`
 * performs the timezone-aware formatting so the produced literal is
 * unambiguous.
 *
 * @param instant The moment to format.
 * @returns A string of the form `YYYY-MM-DD HH:mm:ss.SSS` in UTC.
 */
export function formatUtcDateTime(instant: Date): string {
    return formatInTimeZone(instant, "UTC", "yyyy-MM-dd HH:mm:ss.SSS");
}
