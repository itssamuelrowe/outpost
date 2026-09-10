import type { StepContext } from "./step-context.interface.js";

/**
 * A middleware wraps the execution of a step, forming a composable pipeline.
 *
 * Each middleware receives the step context and a `next` callback that invokes
 * the remainder of the pipeline (ending with the user's step function). A
 * middleware may execute logic before and after calling `next`, may short
 * circuit by not calling `next`, and may transform the returned value.
 *
 * Circuit breakers, chaos fault injection, metrics, and logging are all
 * implemented as middleware so the core execution engine stays free of any
 * vendor-specific concerns.
 */
export type StepMiddleware = (
  context: StepContext,
  next: () => Promise<unknown>,
) => Promise<unknown>;
