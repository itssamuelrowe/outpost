import { WorkflowMetadataRegistry } from "./workflow-metadata-registry.js";
import type { Constructor } from "./constructor.js";
import { StepNaming } from "../utilities/step-naming.utility.js";

/**
 * Marks a method as the probe for a step.
 *
 * A probe resolves an ambiguous step on recovery by checking whether the step's
 * side effect already happened. Because it lives on the class, it can use the
 * same injected dependencies and instance state as the step it serves.
 *
 * A method named `probe<StepMethod>` (for example `probeCreateOrder` for a step
 * method `createOrder`) is discovered automatically even without this
 * decorator. You may still add `@Probe()` to such a method as an explicit
 * marker that it is part of the workflow; with no argument, the target step is
 * inferred from the method name. Pass a step name to associate a differently
 * named method.
 *
 * @example
 *     ```ts
 *     // Explicit marker on a convention-named method (target inferred).
 *     @Probe()
 *     async probeCreateOrder(): Promise<{ orderId: string } | null> { ... }
 *
 *     // Differently named method, target given explicitly.
 *     @Probe("createOrder")
 *     async lookUpExistingOrder(): Promise<{ orderId: string } | null> { ... }
 *     ```;
 *
 * @param stepMethodName The step method this probes. When omitted, it is
 *   inferred from this method's name, which must follow the `probe<Step>`
 *   form.
 */
export function Probe(stepMethodName?: string) {
    return function decorate(
        prototype: object,
        propertyKey: string,
        _descriptor: PropertyDescriptor,
    ): void {
        const target = (prototype as { constructor: Constructor }).constructor;
        const metadata = WorkflowMetadataRegistry.getOrCreate(target);
        /*
         * When no step name is given, infer it from the method name using the
         * `probe<Step>` convention. This lets you keep a convention-named method
         * and still mark it with @Probe() as documentation, without repeating
         * the name.
         */
        const resolvedStepName = stepMethodName ?? StepNaming.inferStepFromProbeName(propertyKey);
        metadata.probeByStepMethodName.set(resolvedStepName, propertyKey);
    };
}
