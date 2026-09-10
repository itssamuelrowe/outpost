import type { StepStatus } from "../enums/step-status.enum.js";

/**
 * Describes a persisted durable step within a workflow.
 *
 * A step is uniquely identified by the pair (`workflowIdentifier`, `stepKey`).
 * The `fenceToken` is a monotonically increasing number that is incremented
 * every time the step is claimed; it is used to reject writes from a stale
 * worker whose lease has expired and been taken over by a newer worker.
 */
export interface Step {
  /** The identifier of the workflow that owns this step. */
  workflowIdentifier: string;
  /** The stable key that identifies this step within its workflow. */
  stepKey: string;
  /** The current lifecycle state of the step. */
  status: StepStatus;
  /** The number of execution attempts made so far. */
  attempts: number;
  /** The maximum number of attempts permitted before terminal failure. */
  maxAttempts: number;
  /** The serialized memoized result of a successful or fallback outcome, stored as binary. */
  output: Buffer | null;
  /** A human-readable description of the most recent failure, if any. */
  lastError: string | null;
  /**
   * A fencing token that increases on every claim. Commits and failures must
   * present the token from their own claim; a mismatch indicates a stale worker
   * and the write is rejected.
   */
  fenceToken: number;
  /** The instant until which the current lease is valid, or `null` when unleased. */
  lockedUntil: Date | null;
  /** The instant the step's result was committed, or `null` if not yet completed. */
  completedAt: Date | null;
  /** The moment the step record was first created. */
  createdAt: Date;
  /** The moment the step record was last modified. */
  updatedAt: Date;
}
