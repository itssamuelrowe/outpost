import { formatInTimeZone } from "date-fns-tz";

/**
 * Date and time helpers for the MySQL adapter.
 *
 * Grouped as static members so the formatting rules the adapter relies on live
 * in one place and read as `DateTimeUtility.formatUtcDateTime(...)` at the call
 * site.
 */
export class DateTimeUtility {
    /**
     * The MySQL `DATETIME(3)` format string, in UTC. The three-digit fractional
     * seconds match the `DATETIME(3)` columns in the schema.
     */
    private static readonly UTC_DATETIME_FORMAT = "yyyy-MM-dd HH:mm:ss.SSS";

    /**
     * Formats an instant as a UTC MySQL `DATETIME(3)` literal.
     *
     * All timestamps are stored and compared in UTC to eliminate any skew
     * between the application's clock and the database session's timezone.
     * `date-fns-tz` performs the timezone-aware formatting so the produced
     * literal is unambiguous.
     *
     * @param instant The moment to format.
     * @returns A string of the form `YYYY-MM-DD HH:mm:ss.SSS` in UTC.
     */
    public static formatUtcDateTime(instant: Date): string {
        return formatInTimeZone(instant, "UTC", DateTimeUtility.UTC_DATETIME_FORMAT);
    }
}
