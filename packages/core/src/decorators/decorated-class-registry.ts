import type { Constructor } from "./constructor.js";
import type { WorkflowClassMetadata } from "./workflow-metadata.js";

/**
 * The registry of decorated workflow classes, keyed by the class constructor.
 *
 * One record per class holds everything the class-level and method-level
 * decorators contribute:
 *      - the workflow name and lifecycle method from {@link Workflow}
 *      - the per-method step options from {@link Step}
 *      - the probe and error-classifier associations from {@link Probe} and {@link ClassifyError}
 *      - the recurring schedule from {@link Cron}
 * 
 * A cron workflow is just a decorated class that also carries {@link CronMetadata},
 * so it lives in the same registry rather than a separate one.
 *
 * Metadata is recorded and read through the static members of this class so the
 * registry logic stays discoverable with its owning type.
 */
export class DecoratedClassRegistry {
    /**
     * The backing store, keyed by the class constructor.
     *
     * A `WeakMap` is used so that metadata is garbage-collected along with the
     * class and so we avoid any dependency on `reflect-metadata`. Because
     * decorators run once when the class is declared, the registry is populated
     * before any workflow is ever run.
     */
    private static readonly registry = new WeakMap<Constructor, WorkflowClassMetadata>();

    /**
     * Returns the metadata record for a constructor, creating an empty one on
     * first access. Both the class and method decorators call this so they can
     * contribute their parts regardless of the order in which TypeScript
     * applies them.
     */
    static getOrCreate(target: Constructor): WorkflowClassMetadata {
        let metadata = DecoratedClassRegistry.registry.get(target);
        if (!metadata) {
            metadata = {
                name: target.name,
                lifecycleMethodName: "run",
                stepsByMethodName: new Map(),
                probeByStepMethodName: new Map(),
                classifierByStepMethodName: new Map(),
                appliedClassDecorators: new Set(),
            };
            DecoratedClassRegistry.registry.set(target, metadata);
        }
        return metadata;
    }

    /**
     * Returns the metadata for a constructor, or `undefined` when it is not a
     * workflow.
     */
    static read(target: Constructor): WorkflowClassMetadata | undefined {
        return DecoratedClassRegistry.registry.get(target);
    }

    /**
     * Records that the given class-level decorator was applied to `target`, and
     * throws when it has already been applied.
     *
     * A class-level decorator like {@link Workflow} or {@link Cron} configures
     * an at-most-one concern, so applying it twice can only be a mistake: the
     * second application would silently overwrite the first. Rejecting it turns
     * a confusing last-writer-wins merge into an explicit error.
     *
     * @throws Error when `decoratorName` was already applied to `target`.
     */
    static registerClassDecorator(target: Constructor, decoratorName: string): WorkflowClassMetadata {
        const metadata = DecoratedClassRegistry.getOrCreate(target);
        if (metadata.appliedClassDecorators.has(decoratorName)) {
            throw new Error(
                `@${decoratorName} was applied more than once to class "${target.name}". ` +
                    `Apply it a single time; a repeated application would silently overwrite the earlier configuration.`,
            );
        }
        metadata.appliedClassDecorators.add(decoratorName);
        return metadata;
    }
}
