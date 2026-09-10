import type { StepOptions } from "../interfaces/step-options.interface.js";

/**
 * The metadata recorded for a class annotated with {@link Workflow}.
 *
 * This metadata is the bridge between the decorator authoring style and the
 * existing functional engine: at run time the engine reads it to discover the
 * workflow name, the lifecycle method to invoke, and the per-method step
 * options to apply.
 */
export interface WorkflowClassMetadata {
  /** The workflow name, defaulting to the class name when not overridden. */
  name: string;
  /** The name of the lifecycle method that orchestrates the steps. */
  lifecycleMethodName: string;
  /**
   * The step configuration keyed by the step's method name. Every method
   * annotated with {@link Step} contributes an entry.
   */
  stepsByMethodName: Map<string, ResolvedStepMetadata>;
  /**
   * Explicit probe associations recorded by the {@link Probe} decorator, mapping
   * a step's method name to the name of the method that probes it. These take
   * precedence over the naming convention.
   */
  probeByStepMethodName: Map<string, string>;
  /**
   * Explicit error-classifier associations recorded by the
   * {@link ClassifyError} decorator, mapping a step's method name to the name of
   * the method that classifies its errors. These take precedence over the
   * naming convention.
   */
  classifierByStepMethodName: Map<string, string>;
}

/** The resolved configuration for a single decorated step method. */
export interface ResolvedStepMetadata {
  /** The durable step key, defaulting to the method name when not overridden. */
  stepKey: string;
  /** The step options forwarded to `context.step`. */
  options: StepOptions;
}

/**
 * A generic class constructor type. Using `unknown[]` for the arguments keeps
 * the decorators usable with any constructor signature.
 */
export type Constructor<TInstance = unknown> = new (...args: never[]) => TInstance;

/**
 * The registry of workflow metadata, keyed by the class constructor.
 *
 * A `WeakMap` is used so that metadata is garbage-collected along with the class
 * and so we avoid any dependency on `reflect-metadata`. Because decorators run
 * once when the class is declared, the registry is populated before any workflow
 * is ever run.
 */
const workflowMetadataRegistry = new WeakMap<Constructor, WorkflowClassMetadata>();

/**
 * Returns the metadata record for a constructor, creating an empty one on first
 * access. Both the class and method decorators call this so they can contribute
 * their parts regardless of the order in which TypeScript applies them.
 */
export function getOrCreateWorkflowMetadata(target: Constructor): WorkflowClassMetadata {
  let metadata = workflowMetadataRegistry.get(target);
  if (!metadata) {
    metadata = {
      name: target.name,
      lifecycleMethodName: "run",
      stepsByMethodName: new Map(),
      probeByStepMethodName: new Map(),
      classifierByStepMethodName: new Map(),
    };
    workflowMetadataRegistry.set(target, metadata);
  }
  return metadata;
}

/** Returns the metadata for a constructor, or `undefined` when it is not a workflow. */
export function readWorkflowMetadata(target: Constructor): WorkflowClassMetadata | undefined {
  return workflowMetadataRegistry.get(target);
}
