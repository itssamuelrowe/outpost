import { DecoratedClassRegistry } from "../decorators/decorated-class-registry.js";
import type { Constructor } from "../decorators/constructor.js";
import type { CronSchedule } from "../entities/cron-schedule.entity.js";
import type { Scheduler } from "./scheduler.js";

/**
 * The subset of the workflow engine that {@link CronWorkflowAdapter} needs to
 * turn a cron fire into a workflow run. Declaring it structurally keeps this
 * adapter free of a hard dependency on the concrete engine class and avoids an
 * import cycle between the scheduler and the engine.
 */
export interface CronWorkflowRunner {
    run(
        workflowClassOrInstance: Constructor | object,
        workflowId: string,
        input: unknown,
    ): Promise<unknown>;
}

/**
 * The payload delivered to a cron-scheduled workflow on each fire.
 */
export interface CronWorkflowInput {
    /**
     * The exact instant this occurrence was scheduled for, as an ISO string.
     */
    scheduledFor: string;
    /**
     * The schedule's serialized payload, if any.
     */
    payload: string | null;
}

/**
 * Bridges the decorator authoring style to the functional scheduling API.
 *
 * A class annotated with {@link Cron} records metadata but neither schedules
 * anything nor changes how it runs. This adapter reads that metadata and drives
 * the ordinary functional scheduling API on its behalf.
 * 
 * Everything this class does is expressible by hand with the functional scheduling
 * API; the decorator just removes the boilerplate.
 */
export class CronWorkflowAdapter {
    /**
     * Registers every `@Cron`-decorated workflow class with a {@link Scheduler},
     * wiring each schedule to run its class through the engine.
     *
     * Call it once during startup, after constructing the scheduler and engine
     * and before `scheduler.start(...)`. It is safe to call on every boot:
     * schedule registration is idempotent by name, so an unchanged schedule
     * keeps its firing history.
     *
     * @param scheduler The scheduler that will own the schedules and fire
     *   handler.
     * @param engine The workflow engine used to run a class when its schedule
     *   fires.
     * @param workflowClasses The `@Cron`-decorated workflow classes (or
     *   instances) to register. A class without cron metadata is rejected, so
     *   mistakes surface immediately rather than silently doing nothing.
     * @returns The stored {@link CronSchedule} records that were registered.
     */
    static async registerCronWorkflows(
        scheduler: Scheduler,
        engine: CronWorkflowRunner,
        workflowClasses: Array<Constructor | object>,
    ): Promise<CronSchedule[]> {
        /*
         * Map each schedule name back to the class to run when it fires. A
         * single shared fire handler then dispatches by name, so registering
         * more cron workflows later simply extends this map.
         */
        const runnableByScheduleName = new Map<string, Constructor | object>();

        const registered: CronSchedule[] = [];

        for (const workflowClass of workflowClasses) {
            const constructor = (
                typeof workflowClass === "function" ? workflowClass : workflowClass.constructor
            ) as Constructor;
            const metadata = DecoratedClassRegistry.read(constructor);

            if (!metadata) {
                throw new Error(
                    `Class "${constructor.name}" is not a workflow. Add the @Workflow() decorator (and @Cron()).`,
                );
            }
            if (!metadata.cron) {
                throw new Error(
                    `Workflow "${metadata.name}" has no @Cron() decorator, so it cannot be registered as a cron job.`,
                );
            }

            const scheduleName = metadata.cron.name ?? metadata.name;
            runnableByScheduleName.set(scheduleName, workflowClass);

            const schedule = await scheduler.registerCron({
                name: scheduleName,
                cronExpression: metadata.cron.cronExpression,
                workflowName: metadata.name,
                timeZone: metadata.cron.timeZone,
                catchUp: metadata.cron.catchUp,
                payload: metadata.cron.payload,
            });
            registered.push(schedule);
        }

        /*
         * Install one fire handler that runs the class mapped to the fired
         * schedule. The deterministic per-occurrence workflow identifier the
         * scheduler supplies gives exactly-once semantics per occurrence, and
         * the engine memoises a partially completed occurrence on a replay
         * rather than repeating it.
         */
        scheduler.onCronFire(async ({ schedule, workflowId, scheduledFor, payload }) => {
            const runnable = runnableByScheduleName.get(schedule.name);
            if (!runnable) {
                /*
                 * A fire arrived for a schedule this call did not register (for
                 * example, one registered elsewhere). Leave it for whichever
                 * handler owns it.
                 */
                return;
            }
            const input: CronWorkflowInput = {
                scheduledFor: scheduledFor.toISOString(),
                payload,
            };
            await engine.run(runnable, workflowId, input);
        });

        return registered;
    }
}
