import { DecoratedClassRegistry } from "./decorated-class-registry.js";
import type { Constructor } from "./constructor.js";

/**
 * Options accepted by the {@link Workflow} class decorator.
 */
export interface WorkflowDecoratorOptions {
    /**
     * Overrides the workflow name. Defaults to the class name.
     */
    name?: string;
    /**
     * Overrides the name of the lifecycle method that orchestrates the steps.
     * Defaults to `"run"`.
     */
    lifecycleMethod?: string;
}

/**
 * Marks a class as a workflow definition.
 *
 * The decorator only records metadata; it does not change the class at all. The
 * engine later reads this metadata to run the workflow through the same durable
 * machinery used by the functional style. The workflow name defaults to the
 * class name, which becomes part of the workflow's persisted identity, so
 * prefer an explicit name for long-lived workflows.
 *
 * @example
 *     ```ts
 *     @Workflow({ name: "process-order" })
 *     class ProcessOrder {
 *       async run(context: WorkflowContext, input: OrderInput) { ... }
 *     }
 *     ```;
 */
export function Workflow(options: WorkflowDecoratorOptions = {}) {
    return function decorate(target: Constructor): void {
        const metadata = DecoratedClassRegistry.registerClassDecorator(target, "Workflow");
        if (options.name !== undefined) {
            metadata.name = options.name;
        }
        if (options.lifecycleMethod !== undefined) {
            metadata.lifecycleMethodName = options.lifecycleMethod;
        }
    };
}
