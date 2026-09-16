/**
 * Classifies the nature of a step failure so the engine can decide how to
 * recover.
 */
export enum FailureKind {
    /**
     * The downstream effect definitely did not happen; it is safe to retry.
     */
    DEFINITE = "DEFINITE",
    /**
     * The downstream effect may have happened; probe before retrying.
     */
    AMBIGUOUS = "AMBIGUOUS",
}
