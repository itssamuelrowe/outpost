import type { FailureKind } from "../enums/failure-kind.enum.js";
import type { Serializable, SerializableInput } from "../interfaces/serializable.interface.js";
import type { StepContext } from "../interfaces/step-context.interface.js";
import type { StepOptions } from "../interfaces/step-options.interface.js";
import type { WorkflowContext } from "../interfaces/workflow-context.interface.js";
import { WorkflowMetadataRegistry } from "../decorators/workflow-metadata-registry.js";
import type { Constructor } from "../decorators/constructor.js";
import type { WorkflowClassMetadata } from "../decorators/workflow-metadata.js";
import { StepNaming } from "../utilities/step-naming.utility.js";
import type { ResolvedWorkflow, WorkflowFunction } from "./workflow-function.type.js";

/**
 * Bridges the decorator authoring style to the functional engine.
 *
 * A class annotated with {@link Workflow} records metadata but does not change
 * how it runs. This adapter reads that metadata and produces the functional
 * workflow body the engine executes: it builds a per-run view of the instance
 * whose decorated step methods are routed through `context.step`, and resolves
 * each step's probe and error classifier from the class.
 *
 * The methods are grouped as static members so the reflection logic stays
 * together with the metadata contract it depends on.
 */
export class WorkflowClassAdapter {
    /**
     * Builds the functional workflow body for a decorated class or instance.
     *
     * A class is instantiated with no arguments; an already-constructed
     * instance is used as-is, which is convenient for dependency injection. The
     * returned body wraps the class's step methods per run so they execute
     * durably through `context.step`.
     *
     * @param classOrInstance A workflow constructor (instantiated with no
     *   arguments) or an already-constructed instance.
     * @throws Error when the class is not a workflow or has no lifecycle method.
     */
    static buildWorkflowFromClass<
        TInput extends SerializableInput,
        TOutput extends SerializableInput,
    >(
        classOrInstance: Constructor | object,
    ): ResolvedWorkflow<TInput, TOutput> {
        /* Determine the instance and its constructor, whichever form was supplied. */
        const receivedConstructor = typeof classOrInstance === "function";

        let constructor: Constructor;
        let instance: Record<string, unknown>;

        if (receivedConstructor) {
            constructor = classOrInstance as Constructor;
            instance = new (classOrInstance as Constructor)() as Record<string, unknown>;
        } else {
            constructor = classOrInstance.constructor as Constructor;
            instance = classOrInstance as Record<string, unknown>;
        }

        const metadata = WorkflowMetadataRegistry.read(constructor);
        if (!metadata) {
            throw new Error(
                `Class "${constructor.name}" is not a workflow. Did you forget the @Workflow() decorator?`,
            );
        }

        const lifecycleMethod = instance[metadata.lifecycleMethodName];
        if (typeof lifecycleMethod !== "function") {
            throw new Error(
                `Workflow "${metadata.name}" has no lifecycle method "${metadata.lifecycleMethodName}".`,
            );
        }

        const workflowFunction: WorkflowFunction<TInput, TOutput> = async (context, input) => {
            /*
             * Build an instance whose decorated step methods are replaced with
             * wrappers that run through `context.step`. The wrapper is bound per
             * run so it can capture this run's context. Non-step methods and
             * fields are left intact, so injected dependencies continue to work.
             */
            const runScopedInstance = WorkflowClassAdapter.wrapStepMethods(
                instance,
                metadata,
                context,
            );
            const boundLifecycle = (
                runScopedInstance[metadata.lifecycleMethodName] as WorkflowFunction<
                    TInput,
                    TOutput
                >
            ).bind(runScopedInstance);
            return boundLifecycle(context, input);
        };

        return { name: metadata.name, workflowFunction };
    }

    /**
     * Produces a per-run view of a workflow instance in which every decorated
     * step method is replaced by a wrapper that executes it as a durable step.
     *
     * The original instance is not mutated. Instead a lightweight object is
     * created that inherits from the instance (so its fields and non-step
     * methods remain available) and overrides only the decorated methods. For
     * each step, the probe and error classifier are resolved from the class
     * (see {@link WorkflowClassAdapter.resolveCompanionMethods}) and merged into
     * the step's options.
     */
    private static wrapStepMethods(
        instance: Record<string, unknown>,
        metadata: WorkflowClassMetadata,
        context: WorkflowContext,
    ): Record<string, unknown> {
        const runScopedInstance: Record<string, unknown> = Object.create(instance);

        for (const [methodName, stepMetadata] of metadata.stepsByMethodName) {
            const originalMethod = instance[methodName];
            if (typeof originalMethod !== "function") {
                continue;
            }

            const resolvedOptions = WorkflowClassAdapter.resolveCompanionMethods(
                instance,
                runScopedInstance,
                metadata,
                methodName,
                stepMetadata.options,
            );

            runScopedInstance[methodName] = (...callArguments: unknown[]) =>
                context.step(
                    stepMetadata.stepKey,
                    /*
                     * The step function calls the original method with the same
                     * arguments, preserving `this` so the method can still read
                     * the instance's fields. The reflective wrapper cannot know
                     * the concrete result type, so the return is treated as
                     * Serializable here; the actual serializability is enforced
                     * at the authoring site by the decorated method's own type.
                     */
                    async () =>
                        (await (originalMethod as (...args: unknown[]) => Promise<unknown>).apply(
                            runScopedInstance,
                            callArguments,
                        )) as Serializable,
                    resolvedOptions,
                );
        }

        return runScopedInstance;
    }

    /**
     * Resolves the probe and error classifier for a step and merges them into
     * its options.
     *
     * Resolution order for each companion, strongest first:
     *
     * 1. an inline value already present in the `@Step` options;
     * 2. an explicit association from `@Probe` / `@ClassifyError`;
     * 3. the naming convention (`probe<Method>`, `classifyErrorFor<Method>`).
     *
     * Companion methods are bound to the run-scoped instance so they see the
     * same `this` (and injected dependencies) as the step itself.
     */
    private static resolveCompanionMethods(
        instance: Record<string, unknown>,
        runScopedInstance: Record<string, unknown>,
        metadata: WorkflowClassMetadata,
        stepMethodName: string,
        baseOptions: StepOptions,
    ): StepOptions<Serializable> {
        const options: StepOptions<Serializable> = {
            ...(baseOptions as StepOptions<Serializable>),
        };

        if (options.probe === undefined) {
            const probeMethodName =
                metadata.probeByStepMethodName.get(stepMethodName) ??
                WorkflowClassAdapter.findMethodByName(
                    instance,
                    StepNaming.conventionalProbeName(stepMethodName),
                );
            if (probeMethodName) {
                const probeMethod = instance[probeMethodName] as (
                    context: StepContext,
                ) => Promise<Serializable | null>;
                options.probe = (stepContext: StepContext) =>
                    probeMethod.apply(runScopedInstance, [stepContext]);
            }
        }

        if (options.classifyError === undefined) {
            const classifierMethodName =
                metadata.classifierByStepMethodName.get(stepMethodName) ??
                WorkflowClassAdapter.findMethodByName(
                    instance,
                    StepNaming.conventionalClassifierName(stepMethodName),
                );
            if (classifierMethodName) {
                const classifierMethod = instance[classifierMethodName] as (
                    error: unknown,
                ) => FailureKind;
                options.classifyError = (error: unknown) =>
                    classifierMethod.apply(runScopedInstance, [error]);
            }
        }

        return options;
    }

    /**
     * Returns the method name when the instance has a callable method with it,
     * otherwise `undefined`.
     */
    private static findMethodByName(
        instance: Record<string, unknown>,
        methodName: string,
    ): string | undefined {
        if (typeof instance[methodName] === "function") {
            return methodName;
        }
        return undefined;
    }
}
