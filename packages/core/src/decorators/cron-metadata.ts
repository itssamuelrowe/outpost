/**
 * The recurrence configuration recorded by the {@link Cron} decorator.
 */
export interface CronMetadata {
    /**
     * The schedule name; defaults to the workflow name when not overridden.
     */
    name?: string;
    /**
     * A five- or six-field cron expression.
     */
    cronExpression: string;
    /**
     * The IANA time zone the expression is evaluated in. Defaults to UTC.
     */
    timeZone?: string;
    /**
     * Whether missed occurrences are replayed on recovery. Defaults to `false`.
     */
    catchUp?: boolean;
    /**
     * An optional serialized payload delivered to each fire.
     */
    payload?: string | null;
}
