import type { StepOptions } from "../interfaces/step-options.interface.js";
import { getOrCreateWorkflowMetadata, type Constructor } from "./workflow-metadata.js";

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
        const metadata = getOrCreateWorkflowMetadata(target);
        if (options.name !== undefined) {
            metadata.name = options.name;
        }
        if (options.lifecycleMethod !== undefined) {
            metadata.lifecycleMethodName = options.lifecycleMethod;
        }
    };
}

/**
 * Options accepted by the {@link Cron} class decorator.
 */
export interface CronDecoratorOptions {
    /**
     * A five- or six-field cron expression, for example `"0 2 * * *"`.
     */
    expression: string;
    /**
     * The schedule name used to manage it later (pause, resume, remove,
     * trigger). Defaults to the workflow's name.
     */
    name?: string;
    /**
     * The IANA time zone the expression is evaluated in, for example
     * `"America/New_York"`. Defaults to UTC.
     */
    timeZone?: string;
    /**
     * When `true`, occurrences missed while the process was down are replayed
     * on recovery. Defaults to `false` (missed windows are skipped).
     */
    catchUp?: boolean;
    /**
     * An optional serialized payload delivered to the schedule's fire handler.
     */
    payload?: string | null;
}

/**
 * Marks a workflow class as running on a recurring schedule (a durable cron
 * job). Apply it alongside {@link Workflow}.
 *
 * The decorator only records metadata; it neither schedules anything nor
 * changes the class. Scheduling happens when you pass the class to
 * {@link registerCronWorkflows}, which reads this metadata and registers the
 * schedule through the ordinary functional scheduling API
 * (`scheduler.registerCron` plus `engine.run`). In other words, `@Cron` is pure
 * sugar over the functional path: anything it does, you could do by hand.
 *
 * @example
 *     ```ts
 *     @Workflow({ name: "nightly-report" })
 *     @Cron({ expression: "0 2 * * *", timeZone: "America/New_York" })
 *     class NightlyReport {
 *       async run(context: WorkflowContext, input: { scheduledFor: string }) { ... }
 *     }
 *
 *     // Wire every cron workflow to the scheduler in one call:
 *     registerCronWorkflows(scheduler, engine, [NightlyReport]);
 *     ```;
 */
export function Cron(options: CronDecoratorOptions) {
    return function decorate(target: Constructor): void {
        const metadata = getOrCreateWorkflowMetadata(target);
        metadata.cron = {
            name: options.name,
            cronExpression: options.expression,
            timeZone: options.timeZone,
            catchUp: options.catchUp,
            payload: options.payload,
        };
    };
}

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
        // A method decorator receives the prototype; the constructor is reached via
        // its `constructor` property. Recording the metadata against the constructor
        // keeps class-level and method-level metadata together.
        const target = (prototype as { constructor: Constructor }).constructor;
        const metadata = getOrCreateWorkflowMetadata(target);
        const { id, ...stepOptions } = options;
        metadata.stepsByMethodName.set(propertyKey, {
            stepKey: id ?? propertyKey,
            options: stepOptions,
        });
    };
}

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
        const metadata = getOrCreateWorkflowMetadata(target);
        // When no step name is given, infer it from the method name using the
        // `probe<Step>` convention. This lets you keep a convention-named method and
        // still mark it with @Probe() as documentation, without repeating the name.
        const resolvedStepName = stepMethodName ?? inferStepFromProbeName(propertyKey);
        metadata.probeByStepMethodName.set(resolvedStepName, propertyKey);
    };
}

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
        const metadata = getOrCreateWorkflowMetadata(target);
        // When no step name is given, infer it from the method name using the
        // `classifyErrorFor<Step>` convention.
        const resolvedStepName = stepMethodName ?? inferStepFromClassifierName(propertyKey);
        metadata.classifierByStepMethodName.set(resolvedStepName, propertyKey);
    };
}

/**
 * Derives the conventional probe method name for a step method: `probe`
 * followed by the capitalized step method name (for example, `createOrder` →
 * `probeCreateOrder`).
 */
export function conventionalProbeName(stepMethodName: string): string {
    return `probe${capitalize(stepMethodName)}`;
}

/**
 * Derives the conventional classifier method name for a step method:
 * `classifyErrorFor` followed by the capitalized step method name (for example,
 * `createOrder` → `classifyErrorForCreateOrder`).
 */
export function conventionalClassifierName(stepMethodName: string): string {
    return `classifyErrorFor${capitalize(stepMethodName)}`;
}

/**
 * Capitalizes the first character of a string.
 */
function capitalize(value: string): string {
    return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
}

/**
 * Lowercases the first character of a string.
 */
function lowercaseFirst(value: string): string {
    return value.length === 0 ? value : value.charAt(0).toLowerCase() + value.slice(1);
}

/**
 * Infers the step method name from a probe method that follows the
 * `probe<Step>` convention (for example, `probeCreateOrder` → `createOrder`).
 *
 * @throws Error when the method name does not start with `probe` followed by a
 *   capitalized character, because there is then no unambiguous step to infer.
 */
function inferStepFromProbeName(methodName: string): string {
    const remainder = stripPrefix(methodName, "probe");
    if (remainder === null) {
        throw new Error(
            `@Probe() was used on "${methodName}", whose name does not follow the "probe<Step>" convention. ` +
                `Rename it (for example "probeCreateOrder") or pass the step name explicitly, e.g. @Probe("createOrder").`,
        );
    }
    return lowercaseFirst(remainder);
}

/**
 * Infers the step method name from a classifier method that follows the
 * `classifyErrorFor<Step>` convention (for example,
 * `classifyErrorForCreateOrder` → `createOrder`).
 *
 * @throws Error when the method name does not start with `classifyErrorFor`
 *   followed by a capitalized character.
 */
function inferStepFromClassifierName(methodName: string): string {
    const remainder = stripPrefix(methodName, "classifyErrorFor");
    if (remainder === null) {
        throw new Error(
            `@ClassifyError() was used on "${methodName}", whose name does not follow the ` +
                `"classifyErrorFor<Step>" convention. Rename it (for example "classifyErrorForCreateOrder") ` +
                `or pass the step name explicitly, e.g. @ClassifyError("createOrder").`,
        );
    }
    return lowercaseFirst(remainder);
}

/**
 * Returns the remainder of `value` after `prefix` when `value` starts with the
 * prefix followed by an uppercase letter (so there is a distinct capitalized
 * step name to recover). Returns `null` otherwise.
 */
function stripPrefix(value: string, prefix: string): string | null {
    if (!value.startsWith(prefix) || value.length <= prefix.length) {
        return null;
    }
    const remainder = value.slice(prefix.length);
    const firstChar = remainder.charAt(0);
    if (firstChar !== firstChar.toUpperCase()) {
        return null;
    }
    return remainder;
}
