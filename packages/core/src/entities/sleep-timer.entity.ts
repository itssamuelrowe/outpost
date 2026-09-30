/**
 * The outcome of ensuring a durable sleep timer exists.
 *
 * Returned by {@link StorageAdapter.ensureSleepTimer}. It carries the timer's
 * due time: the existing one when the timer was already created on an earlier
 * resume, or the newly recorded value otherwise. This is what lets a durable
 * sleep observe the same wake instant across resumes.
 */
export interface SleepTimer {
    /**
     * The instant at which the sleep timer becomes due.
     */
    runAt: Date;
}
