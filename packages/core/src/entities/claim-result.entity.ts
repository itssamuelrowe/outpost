import type { StepStatus } from "../enums/step-status.enum.js";

/**
 * Describes the outcome of an attempt to atomically claim a durable step.
 *
 * There are three meaningful outcomes:
 *
 * - The step is already terminal, in which case `cachedResult` holds the memoized
 *   output and `claimed` is `false`.
 * - The claim was granted, in which case `claimed` is `true` and a fresh
 *   `fenceToken` is provided for the subsequent commit or failure.
 * - The claim was refused because another worker holds a live lease, in which
 *   case `claimed` is `false` and no `cachedResult` is present.
 */
export interface ClaimResult {
    /**
     * Whether this caller was granted an exclusive claim on the step.
     */
    claimed: boolean;
    /**
     * The memoized result when the step is already terminal (completed or an
     * optional failure). The output is stored as a binary buffer. `completedAt`
     * is the instant the result was committed, used to evaluate an optional
     * result time-to-live. Present only when the step should not be executed
     * again.
     */
    cachedResult?: { output: Buffer | null; completedAt: Date | null };
    /**
     * The attempt number represented by this claim, counting from one.
     */
    attempt: number;
    /**
     * The fencing token associated with this claim.
     */
    fenceToken: number;
    /**
     * The status the step held immediately before this claim, if it existed.
     */
    priorStatus: StepStatus | null;
}
