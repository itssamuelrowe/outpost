import type { Serializable } from "./serializable.interface.js";
import type { StepContext } from "./step-context.interface.js";

/**
 * A probe determines whether a step's downstream side effect has already
 * occurred, so an ambiguous step can be recovered without duplicating work.
 *
 * The probe should query the downstream system (for example, by searching for a
 * resource created with a correlation attribute the caller controls). Returning
 * a non-null value means the effect already happened and that value becomes the
 * memoized step output; returning `null` means the effect did not happen and
 * the step function should be executed.
 *
 * The resolved value must be {@link Serializable}, because it is persisted as
 * the step's result exactly like a normal successful outcome.
 */
export type ProbeFunction<TResult extends Serializable> = (
    context: StepContext,
) => Promise<TResult | null>;
