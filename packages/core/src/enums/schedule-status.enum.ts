/**
 * Represents the state of a durable timer (schedule) record.
 *
 * Timers are created by durable sleeps and by retry scheduling. The embedded
 * scheduler claims due timers, dispatches them, and marks them processed.
 */
export enum ScheduleStatus {
  /** The timer is waiting for its due time to arrive. */
  PENDING = "PENDING",
  /** The timer has been claimed and dispatched by the scheduler. */
  PROCESSED = "PROCESSED",
  /** The timer was cancelled before it became due. */
  CANCELLED = "CANCELLED",
}
