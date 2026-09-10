/**
 * Classifies the nature of a step failure so the engine can decide how to
 * recover.
 *
 * A {@link FailureKind.DEFINITE} failure means the downstream side effect did
 * not occur, so the step can be retried or failed safely. A
 * {@link FailureKind.AMBIGUOUS} failure means the side effect may have occurred
 * (typically a network timeout or a 5xx response), so the step must be probed
 * before it is executed again to avoid duplicating the effect.
 */
export enum FailureKind {
  /** The downstream effect definitely did not happen; it is safe to retry. */
  DEFINITE = "DEFINITE",
  /** The downstream effect may have happened; probe before retrying. */
  AMBIGUOUS = "AMBIGUOUS",
}
