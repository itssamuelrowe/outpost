import { WorkflowMetadataRegistry } from "./workflow-metadata-registry.js";
import type { Constructor } from "./constructor.js";
import { StepNaming } from "../utilities/step-naming.utility.js";

/**
 * Marks a method as the error classifier for a step.
 *
 * The classifier decides whether a thrown error is definite (safe to retry) or
 * ambiguous (the side effect may have happened, so a probe is needed).
 *
 * As with {@link Probe}, a method named `classifyErrorFor<StepMethod>` (for
 * example `classifyErrorForCreateOrder`) is discovered automatically. You may
 * still add `@ClassifyError()` as an explicit marker; with no argument the
 * target step is inferred from the method name. Pass a step name to associate a
 * differently named method.
 *
 * @example
 *     ```ts
 *     // Explicit marker on a convention-named method (target inferred).
 *     @ClassifyError()
 *     classifyErrorForCreateOrder(error: unknown): FailureKind { ... }
 *
 *     // Differently named method, target given explicitly.
 *     @ClassifyError("createOrder")
 *     classifyHttp(error: unknown): FailureKind { ... }
 *     ```;
 *
 * @param stepMethodName The step method whose errors this classifies. When
 *   omitted, it is inferred from this method's name, which must follow the
 *   `classifyErrorFor<Step>` form.
 */
export function ClassifyError(stepMethodName?: string) {
    return function decorate(
        prototype: object,
        propertyKey: string,
        _descriptor: PropertyDescriptor,
    ): void {
        const target = (prototype as { constructor: Constructor }).constructor;
        const metadata = WorkflowMetadataRegistry.getOrCreate(target);
        /*
         * When no step name is given, infer it from the method name using the
         * `classifyErrorFor<Step>` convention.
         */
        const resolvedStepName =
            stepMethodName ?? StepNaming.inferStepFromClassifierName(propertyKey);
        metadata.classifierByStepMethodName.set(resolvedStepName, propertyKey);
    };
}
