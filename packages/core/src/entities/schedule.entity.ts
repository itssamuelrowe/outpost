import type { ScheduleStatus } from "../enums/schedule-status.enum.js";

/**
 * Describes a persisted durable timer.
 *
 * Timers are created by durable sleeps and by retry scheduling. The embedded
 * scheduler periodically claims timers whose `runAt` has passed and dispatches
 * them so the associated workflow or step can be resumed.
 */
export interface Schedule {
    /**
     * The database-assigned identifier for this timer.
     */
    scheduleIdentifier: number;
    /**
     * The identifier of the workflow this timer will resume.
     */
    workflowIdentifier: string;
    /**
     * The step key this timer targets, or `null` for a workflow-level timer.
     */
    stepKey: string | null;
    /**
     * The instant at which the timer becomes due for dispatch.
     */
    runAt: Date;
    /**
     * The current state of the timer.
     */
    status: ScheduleStatus;
    /**
     * An optional serialized payload delivered to the resume handler.
     */
    payload: string | null;
    /**
     * The moment the timer record was created.
     */
    createdAt: Date;
}
