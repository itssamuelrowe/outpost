/**
 * Represents the lifecycle state of a recurring (cron) schedule.
 *
 * Unlike {@link ScheduleStatus}, which describes a single-fire durable timer, a
 * cron schedule is a long-lived definition that fires repeatedly. Its status
 * controls whether the scheduler is currently materialising fires from it.
 */
export enum CronScheduleStatus {
    /**
     * The schedule is active and its due fires are dispatched.
     */
    ACTIVE = "ACTIVE",
    /**
     * The schedule exists but is not firing; it can be resumed later.
     */
    PAUSED = "PAUSED",
}
