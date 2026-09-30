import type { CronSchedule } from "./cron-schedule.entity.js";

/**
 * A cron schedule whose occurrence has come due and been atomically claimed for
 * firing.
 *
 * Returned by {@link StorageAdapter.claimDueCronSchedules} and
 * {@link StorageAdapter.claimDueUnownedCronSchedules}. It pairs the claimed
 * schedule with the instant the occurrence fired, which the caller uses to
 * dispatch the run and to record firing history.
 */
export interface DueCronSchedule {
    /**
     * The cron schedule that was claimed, with its `nextRunAt` already advanced
     * to the following occurrence.
     */
    schedule: CronSchedule;
    /**
     * The instant the claimed occurrence fired.
     */
    firedAt: Date;
}
