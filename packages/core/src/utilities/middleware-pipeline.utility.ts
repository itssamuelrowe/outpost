import type { StepContext } from "../interfaces/step-context.interface.js";
import type { StepMiddleware } from "../interfaces/middleware.interface.js";

/**
 * A parameterless async operation returning a result of type `TResult`.
 *
 * Used both for the terminal operation at the centre of the pipeline and for
 * the `next` callback handed to each middleware.
 */
export type TerminalOperation<TResult = unknown> = () => Promise<TResult>;

/**
 * Composes step middleware around a terminal operation.
 */
export class MiddlewarePipelineUtility {
    /**
     * Composes an ordered list of middleware around a terminal operation.
     *
     * The returned function invokes the middleware in the order supplied: the
     * first middleware in the array is the outermost wrapper and therefore runs
     * first on the way in and last on the way out. The terminal operation
     * (typically the user's step function) runs at the centre of the
     * composition.
     *
     * @typeParam TResult The result type produced by the terminal operation
     * and, in turn, by the composed pipeline.
     * @param middleware The ordered middleware to apply, outermost first.
     * @param context The step context passed to each middleware.
     * @param terminalOperation The innermost operation to execute.
     */
    public static run<TResult = unknown>(
        middleware: StepMiddleware[],
        context: StepContext,
        terminalOperation: TerminalOperation<TResult>,
    ): Promise<TResult> {
        /**
         * Builds the chain from the inside out. Index `position` returns a
         * function that, when called, runs the middleware at that position and
         * hands it a `next` callback pointing at the following position.
         */
        const invokeFromPosition = (position: number): Promise<TResult> => {
            if (position >= middleware.length) {
                return terminalOperation();
            }

            const currentMiddleware = middleware[position]!;
            return currentMiddleware(context, () => invokeFromPosition(position + 1)) as Promise<TResult>;
        };

        return invokeFromPosition(0);
    }
}
