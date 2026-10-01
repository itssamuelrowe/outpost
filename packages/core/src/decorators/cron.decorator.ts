import { DecoratedClassRegistry } from "./decorated-class-registry.js";
import type { Constructor } from "./constructor.js";

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
 * {@link CronWorkflowAdapter.registerCronWorkflows}, which reads this metadata and registers the
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
 *     CronWorkflowAdapter.registerCronWorkflows(scheduler, engine, [NightlyReport]);
 *     ```;
 */
export function Cron(options: CronDecoratorOptions) {
    return function decorate(target: Constructor): void {
        const metadata = DecoratedClassRegistry.registerClassDecorator(target, "Cron");
        metadata.cron = {
            name: options.name,
            cronExpression: options.expression,
            timeZone: options.timeZone,
            catchUp: options.catchUp,
            payload: options.payload,
        };
    };
}
