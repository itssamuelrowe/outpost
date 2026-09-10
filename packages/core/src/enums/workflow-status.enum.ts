/**
 * Represents the lifecycle state of a workflow execution.
 *
 * A workflow begins in the {@link WorkflowStatus.RUNNING} state and eventually
 * transitions to one of the terminal states. The `SUSPENDED` state is used when
 * a workflow is durably waiting (for example, during a sleep) and expects to be
 * resumed by the scheduler at a later time.
 */
export enum WorkflowStatus {
  /** The workflow is actively executing or is eligible to be resumed. */
  RUNNING = "RUNNING",
  /** The workflow finished successfully and produced a final output. */
  COMPLETED = "COMPLETED",
  /** The workflow terminated because a mandatory step failed permanently. */
  FAILED = "FAILED",
  /** The workflow is durably waiting and will be resumed by the scheduler. */
  SUSPENDED = "SUSPENDED",
  /** The workflow was explicitly cancelled by the application. */
  CANCELLED = "CANCELLED",
}
