/**
 * Represents the lifecycle state of a single durable step within a workflow.
 */
export enum StepStatus {
    /**
     * The step has been registered but has not yet been claimed for execution.
     */
    PENDING = "PENDING",
    /**
     * The step is currently claimed and executing under a live lease.
     */
    RUNNING = "RUNNING",
    /**
     * The step finished successfully and its output has been memoized.
     */
    COMPLETED = "COMPLETED",
    /**
     * The step failed permanently and the failure is propagated to the
     * workflow.
     */
    FAILED = "FAILED",
    /**
     * An optional step failed permanently; the workflow continues with a
     * fallback.
     */
    FAILED_OPTIONAL = "FAILED_OPTIONAL",
    /**
     * A prior attempt failed with an ambiguous outcome (timeout or 5xx), so the
     * downstream side effect may or may not have occurred. Recovery must probe
     * before executing again.
     */
    AMBIGUOUS = "AMBIGUOUS",
    /**
     * The step is ambiguous but cannot be resolved automatically (no probe was
     * provided), so it has been parked for manual review rather than guessed.
     */
    NEEDS_REVIEW = "NEEDS_REVIEW",
}
