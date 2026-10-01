import type { StepOptions } from "../interfaces/step-options.interface.js";
import { DecoratedClassRegistry } from "./decorated-class-registry.js";
import type { Constructor } from "./constructor.js";

/**
 * Options accepted by the {@link Step} method decorator.
 */
export interface StepDecoratorOptions extends StepOptions {
    /**
     * Overrides the durable step key. Defaults to the method name.
     */
    id?: string;
}

/**
 * Marks a method as a durable step.
 *
 * When the workflow runs, calls to a decorated method from inside the lifecycle
 * method are transparently routed through `context.step`, so the method gains
 * memoization, leasing, retries, and probe-based recovery without any change to
 * how it is called. The step key defaults to the method name.
 *
 * @example
 *     ```ts
 *     @Step({ maxAttempts: 4 })
 *     async chargeCard(context: StepContext, input: OrderInput) { ... }
 *     ```;
 */
export function Step(options: StepDecoratorOptions = {}) {
    return function decorate(
        prototype: object,
        propertyKey: string,
        _descriptor: PropertyDescriptor,
    ): void {
        /*
         * A method decorator receives the prototype; the constructor is reached
         * via its `constructor` property. Recording the metadata against the
         * constructor keeps class-level and method-level metadata together.
         */
        const target = (prototype as { constructor: Constructor }).constructor;
        const metadata = DecoratedClassRegistry.getOrCreate(target);
        const { id, ...stepOptions } = options;
        metadata.stepsByMethodName.set(propertyKey, {
            stepKey: id ?? propertyKey,
            options: stepOptions,
        });
    };
}
