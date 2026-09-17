/**
 * Durable cron in the functional style.
 *
 * The `cron-backfill-update.ts` example manages schedules; the class-style
 * `@Cron` decorator is shown in the docs. This file shows the functional way to
 * wire a recurring schedule to a workflow, with no decorators:
 *
 * 1. Define the workflow with `engine.defineWorkflow(name, fn)`.
 * 2. Install a fire handler with `scheduler.onCronFire(...)` that runs that
 *    workflow by name, using the deterministic per-occurrence identifier the
 *    scheduler supplies (so each occurrence runs at most once).
 * 3. Register the schedule with `scheduler.registerCron(...)`, pointing its
 *    `workflowName` at the function's name.
 *
 * It uses in-memory storage and a controlled clock so the output is
 * deterministic, and drives the scheduler with explicit `tickCron()` calls
 * instead of the background loop. Run it with:
 *
 * yarn tsx src/functional-cron.ts
 */

import { MemoryStorage, Scheduler, WorkflowEngine } from "@outpost/core";

/**
 * The input each scheduled run receives. `scheduledFor` is the exact instant the
 * occurrence was scheduled for; deriving the report's day from it (rather than
 * from the wall clock) keeps a delayed or replayed run correct.
 */
interface ReportInput {
    scheduledFor: string;
}

function log(message: string): void {
    console.log(message);
}

const main = async (): Promise<void> => {
    // A mutable clock so we can advance time deterministically and watch the
    // schedule fire on cue.
    let currentInstant = new Date("2026-03-08T01:30:00.000Z");
    const now = (): Date => currentInstant;

    const storage = new MemoryStorage(now);
    const engine = new WorkflowEngine(storage, { now });

    // Jitter off so a fire lands on its exact scheduled instant, keeping the demo
    // output clean. Production usually wants the default jitter.
    const scheduler = new Scheduler(storage, { now, cronJitterMilliseconds: 0 });

    // 1. Define the workflow as a plain function, registered by name. It "runs"
    //    the report as a durable step so a resume would not repeat it.
    const generatedFor: string[] = [];
    engine.defineWorkflow<ReportInput, { day: string }>("generate-report", async (context, input) => {
        const day = input.scheduledFor.slice(0, 10);
        await context.step("render", async () => {
            generatedFor.push(day);
            log(`    [generate-report] rendered the report for ${day}`);
            return { ok: true };
        });
        return { day };
    });

    // 2. Turn each due occurrence into a run of that workflow, by name. The
    //    scheduler hands us a deterministic workflow identifier per occurrence, so
    //    dispatching the same occurrence twice resolves to the same execution.
    scheduler.onCronFire(async ({ schedule, workflowIdentifier, scheduledFor }) => {
        log(`  fire "${schedule.name}" for ${scheduledFor.toISOString()} (id: ${workflowIdentifier})`);
        await engine.run(schedule.workflowName, workflowIdentifier, {
            scheduledFor: scheduledFor.toISOString(),
        });
    });

    // 3. Register the schedule. `workflowName` matches the defineWorkflow name.
    const schedule = await scheduler.registerCron({
        name: "nightly-report",
        cronExpression: "0 2 * * *", // 02:00 every day, UTC
        workflowName: "generate-report",
    });
    log(`Registered "${schedule.name}" (${schedule.cronExpression}).`);
    log(`  first fire due at: ${schedule.nextRunAt.toISOString()}`);

    // Before 02:00 nothing is due.
    log("\n=== Tick at 01:30 (nothing due yet) ===");
    log(`  dispatched: ${await scheduler.tickCron()}`);

    // Advance to 02:00 and tick: the schedule fires and runs the workflow.
    currentInstant = new Date("2026-03-08T02:00:00.000Z");
    log("\n=== Tick at 02:00 (due) ===");
    log(`  dispatched: ${await scheduler.tickCron()}`);

    // Advance a full day; the next day's occurrence fires.
    currentInstant = new Date("2026-03-09T02:00:00.000Z");
    log("\n=== Tick at 02:00 the next day ===");
    log(`  dispatched: ${await scheduler.tickCron()}`);

    log(`\nReport generated for days: ${generatedFor.join(", ")}`);
};

main().catch((error) => {
    console.error("functional-cron example failed:", error);
    process.exitCode = 1;
});
