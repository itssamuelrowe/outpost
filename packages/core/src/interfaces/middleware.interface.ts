import type { StepContext } from "./step-context.interface.js";

/**
 * A middleware wraps the execution of a step, forming a composable pipeline.
 *
 * Each middleware receives the step context and a `next` callback that invokes
 * the remainder of the pipeline (ending with the user's step function).
 *
 * A middleware may execute logic before and after calling `next`, may short
 * circuit by not calling `next`, and may transform the returned value.
 *
 * Circuit breakers, chaos fault injection, metrics, and logging are all
 * implemented as middleware so the core execution engine stays free of any
 * vendor-specific concerns.
 *
 * @typeParam TResult The result type flowing through the pipeline. It defaults
 * to `unknown` so a middleware can be written once and applied to steps of any
 * result type; supply a concrete type when a middleware needs to inspect or
 * transform a specific result shape.
 */
export type StepMiddleware<TResult = unknown> = (
    context: StepContext,
    next: () => Promise<TResult>,
) => Promise<TResult>;
