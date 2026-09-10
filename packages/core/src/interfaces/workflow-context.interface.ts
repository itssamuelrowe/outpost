import type { Serializable } from "./serializable.interface.js";
import type { StepContext } from "./step-context.interface.js";
import type { StepOptions } from "./step-options.interface.js";

/**
 * The context passed to a workflow definition body.
 *
 * It exposes the durable primitives a workflow may use: executing a durable
 * step and performing a durable sleep. Additional primitives may be added over
 * time without breaking existing workflow definitions.
 */
export interface WorkflowContext {
  /** The identifier of the workflow execution currently running. */
  readonly workflowIdentifier: string;

  /**
   * Executes a durable step. If the step has already completed, its memoized
   * output is returned without executing the function again.
   *
   * The result type is constrained to {@link Serializable}: because the result
   * is persisted and read back on later runs, only values that survive that
   * round trip are permitted. Returning a `Date`, `Map`, class instance, or
   * function will not compile.
   */
  step<TResult extends Serializable>(
    stepKey: string,
    stepFunction: (context: StepContext) => Promise<TResult>,
    options?: StepOptions<TResult>,
  ): Promise<TResult>;

  /**
   * Suspends the workflow durably for the given duration. The workflow can be
   * resumed by the scheduler after the delay, even across process restarts.
   */
  sleep(timerKey: string, durationMilliseconds: number): Promise<void>;
}
