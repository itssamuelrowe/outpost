/**
 * A durable timer whose due time has passed and which has been atomically
 * claimed for dispatch.
 *
 * Returned by {@link StorageAdapter.claimDueTimers}. It carries only the fields
 * the dispatcher needs to resume the associated workflow or step, not the full
 * {@link Schedule} record.
 */
export interface DueTimer {
    /**
     * The database-assigned identifier of the claimed timer.
     */
    scheduleId: number;
    /**
     * The id of the workflow this timer will resume.
     */
    workflowId: string;
    /**
     * The step key this timer targets, or `null` for a workflow-level timer.
     */
    stepKey: string | null;
    /**
     * An optional serialized payload delivered to the resume handler.
     */
    payload: string | null;
}
