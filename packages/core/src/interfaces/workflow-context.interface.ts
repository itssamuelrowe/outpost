import type { Serializable, SerializableInput } from "./serializable.interface.js";
import type { StepContext } from "./step-context.interface.js";
import type { StepOptions } from "./step-options.interface.js";
import type { Constructor } from "../decorators/workflow-metadata.js";

/**
 * Options accepted when starting a child workflow from within a parent.
 */
export interface ChildWorkflowOptions {
    /**
     * The identifier to give the child execution. When omitted, a deterministic
     * identifier is derived from the parent's identifier and the child key, so
     * a resume of the parent addresses the very same child rather than starting
     * a new one. Supply an explicit identifier only when you need to address
     * the child from outside the parent (for example to query its status by a
     * known id).
     */
    workflowIdentifier?: string;
}

/**
 * A handle to a child workflow that has been started but not yet awaited.
 *
 * Holding a handle lets a parent start several children, let them run, and
 * gather their results later, rather than awaiting each in turn.
 */
export interface ChildWorkflowHandle<TOutput extends SerializableInput> {
    /**
     * The identifier of the child workflow execution.
     */
    readonly workflowIdentifier: string;
    /**
     * Resolves with the child's output, running the child to completion durably
     * if it has not already completed. Calling this more than once returns the
     * same memoized result.
     */
    result(): Promise<TOutput>;
}

/**
 * The context passed to a workflow definition body.
 *
 * It exposes the durable primitives a workflow may use: executing a durable
 * step and performing a durable sleep. Additional primitives may be added over
 * time without breaking existing workflow definitions.
 */
export interface WorkflowContext {
    /**
     * The identifier of the workflow execution currently running.
     */
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

    /**
     * Returns the current time as epoch milliseconds, recorded durably the
     * first time it is called for a given key.
     *
     * Reading the wall clock directly inside a workflow is non-deterministic: a
     * resume after a crash would observe a different instant and could diverge
     * from the original run. This records the instant as a durable step, so
     * every resume observes the same value the first run did. Use it wherever a
     * workflow needs "now" in a way that must stay stable across resumes (for
     * example, stamping a created-at time or computing a deadline).
     *
     * @param key A stable key identifying this reading within the workflow.
     */
    now(key: string): Promise<number>;

    /**
     * Returns a random UUID (version 4), recorded durably the first time it is
     * called for a given key.
     *
     * Like {@link WorkflowContext.now}, generating randomness directly inside a
     * workflow is non-deterministic and would produce a different value on
     * resume. This records the generated id as a durable step so every resume
     * sees the same id. Use it for idempotency keys, correlation ids, and any
     * other value that must be random once but stable thereafter.
     *
     * @param key A stable key identifying this id within the workflow.
     */
    randomUUID(key: string): Promise<string>;

    /**
     * Starts a child workflow and returns a handle to it without waiting for
     * the child to finish. This lets a parent launch several children
     * concurrently and gather their results later with
     * {@link ChildWorkflowHandle.result}.
     *
     * The child is durable in its own right: it is recorded as a distinct
     * workflow execution, its steps are memoised, and it survives restarts. The
     * link back to the parent is recorded so the relationship is auditable.
     *
     * @param childKey A stable key identifying this child within the parent. It
     *   is also used to derive the child's identifier when one is not
     *   supplied.
     * @param nameOrClass The child workflow to run, by registered name or by an
     *   `@Workflow` class or instance.
     * @param input The input passed to the child.
     */
    startChild<TInput extends SerializableInput, TOutput extends SerializableInput>(
        childKey: string,
        nameOrClass: string | Constructor | object,
        input: TInput,
        options?: ChildWorkflowOptions,
    ): Promise<ChildWorkflowHandle<TOutput>>;

    /**
     * Starts a child workflow and awaits its output in one call. This is the
     * common case: a parent runs a child as a durable sub-routine and uses its
     * result immediately. It is exactly `startChild(...).then((h) =>
     * h.result())`.
     *
     * @param childKey A stable key identifying this child within the parent.
     * @param nameOrClass The child workflow to run, by registered name or
     *   class.
     * @param input The input passed to the child.
     */
    runChild<TInput extends SerializableInput, TOutput extends SerializableInput>(
        childKey: string,
        nameOrClass: string | Constructor | object,
        input: TInput,
        options?: ChildWorkflowOptions,
    ): Promise<TOutput>;
}
