/**
 * The execution context passed to a step function, its probe, and any
 * middleware wrapping the step.
 *
 * It carries the identity of the step and the current attempt number so that
 * user code and middleware can make attempt-aware decisions (for example,
 * generating a deterministic idempotency key).
 */
export interface StepContext {
    /**
     * The identifier of the workflow that owns the step.
     */
    readonly workflowIdentifier: string;
    /**
     * The stable key that identifies the step within its workflow.
     */
    readonly stepKey: string;
    /**
     * The current execution attempt, counting from one.
     */
    readonly attempt: number;
}
