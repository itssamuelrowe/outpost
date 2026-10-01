import type { StepOptions } from "../interfaces/step-options.interface.js";
import type { CronMetadata } from "./cron-metadata.js";

/**
 * The resolved configuration for a single decorated step method.
 */
export interface ResolvedStepMetadata {
    /**
     * The durable step key, defaulting to the method name when not overridden.
     */
    stepKey: string;
    /**
     * The step options forwarded to `context.step`.
     */
    options: StepOptions;
}

/**
 * The metadata recorded for a class annotated with {@link Workflow}.
 *
 * This metadata is the bridge between the decorator authoring style and the
 * existing functional engine: at run time the engine reads it to discover the
 * workflow name, the lifecycle method to invoke, and the per-method step
 * options to apply.
 */
export interface WorkflowClassMetadata {
    /**
     * The workflow name, defaulting to the class name when not overridden.
     */
    name: string;
    /**
     * The name of the lifecycle method that orchestrates the steps.
     */
    lifecycleMethodName: string;
    /**
     * The step configuration keyed by the step's method name. Every method
     * annotated with {@link Step} contributes an entry.
     */
    stepsByMethodName: Map<string, ResolvedStepMetadata>;
    /**
     * Explicit probe associations recorded by the {@link Probe} decorator,
     * mapping a step's method name to the name of the method that probes it.
     * These take precedence over the naming convention.
     */
    probeByStepMethodName: Map<string, string>;
    /**
     * Explicit error-classifier associations recorded by the
     * {@link ClassifyError} decorator, mapping a step's method name to the name
     * of the method that classifies its errors. These take precedence over the
     * naming convention.
     */
    classifierByStepMethodName: Map<string, string>;
    /**
     * The recurring schedule recorded by the {@link Cron} decorator, when
     * present. A workflow class carries at most one cron schedule; it is
     * registered with a {@link Scheduler} by {@link CronWorkflowAdapter.registerCronWorkflows}, which
     * drives the same functional scheduling API used everywhere else.
     */
    cron?: CronMetadata;
    /**
     * The set of class-level decorators already applied to this class, used to
     * reject accidentally applying the same one twice (for example two
     * `@Workflow` or two `@Cron` decorators on one class), which would otherwise
     * silently overwrite the earlier configuration.
     */
    appliedClassDecorators: Set<string>;
}
