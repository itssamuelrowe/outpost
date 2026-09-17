/**
 * Managing recurring schedules: backfill and in-place update.
 *
 * A durable cron schedule fires on its cadence, but two operational needs come
 * up constantly:
 *
 * - "Run this schedule as if it had fired across a past window." Maybe the
 *   process was down for a day, or you fixed a bug and want to reprocess a
 *   range. That is `backfillCron(name, start, end)`: it replays every
 *   occurrence in the window through the fire handler, with idempotent
 *   identifiers, without touching the live cadence.
 * - "Change the cadence (or payload) of an existing schedule without losing its
 *   history." That is `updateCron(name, changes)`: it edits the schedule in
 *   place, recomputing the next fire only when the cadence itself changed.
 *
 * This example registers a nightly report schedule, backfills a week of missed
 * runs, then updates it to run twice daily. It uses in-memory storage and a
 * controlled clock so the output is deterministic. Run it with:
 *
 * yarn tsx src/cron-backfill-update.ts
 */

import { MemoryStorage, Scheduler } from "@outpost/core";
import type { CronFireHandler } from "@outpost/core";

function log(message: string): void {
    console.log(message);
}

const main = async (): Promise<void> => {
    // A fixed "now" so the recomputed next-run times are predictable in output.
    const now = new Date("2026-03-08T12:00:00.000Z");
    const storage = new MemoryStorage(() => now);

    // Jitter off so fires land on the exact scheduled instant, which keeps the
    // demo output clean. Production usually wants the default jitter.
    const scheduler = new Scheduler(storage, {
        now: () => now,
        cronJitterMilliseconds: 0,
    });

    // The fire handler is where a schedule occurrence becomes real work. Here it
    // just logs; in a real app it would call engine.run(...) with the provided
    // deterministic workflow identifier so each occurrence runs at most once.
    const fired: string[] = [];
    const handler: CronFireHandler = async (fire) => {
        fired.push(fire.scheduledFor.toISOString());
        log(
            `    fired "${fire.schedule.name}" for ${fire.scheduledFor.toISOString()} ` +
                `(id: ${fire.workflowIdentifier})`,
        );
    };
    scheduler.onCronFire(handler);

    // Register a nightly report that runs at 02:00 UTC every day.
    const registered = await scheduler.registerCron({
        name: "nightly-report",
        cronExpression: "0 2 * * *",
        workflowName: "generate-report",
        payload: JSON.stringify({ format: "pdf" }),
    });
    log(`Registered "nightly-report" (${registered.cronExpression}).`);
    log(`  next fire: ${registered.nextRunAt.toISOString()}`);

    // --- Backfill a past week --------------------------------------------------
    // Suppose the reporter was offline for the first week of March. Replay each
    // nightly occurrence in that window without disturbing the live schedule.
    log(`\n=== Backfilling 2026-03-01 .. 2026-03-07 ===`);
    const dispatched = await scheduler.backfillCron(
        "nightly-report",
        new Date("2026-03-01T00:00:00.000Z"),
        new Date("2026-03-07T23:59:59.000Z"),
    );
    log(`  backfilled ${dispatched.length} occurrences`);

    // The live schedule's next fire is unchanged by the backfill.
    const afterBackfill = await storage.getCronSchedule("nightly-report");
    log(`  live next fire still: ${afterBackfill?.nextRunAt.toISOString()}`);

    // Backfill is idempotent: the identifiers are deterministic, so re-running the
    // same window resolves each occurrence to the same workflow execution, which
    // the engine would memoise rather than double-run.
    const again = await scheduler.backfillCron(
        "nightly-report",
        new Date("2026-03-01T00:00:00.000Z"),
        new Date("2026-03-07T23:59:59.000Z"),
    );
    log(
        `  re-running the same window yields the same identifiers: ` +
            `${JSON.stringify(again) === JSON.stringify(dispatched)}`,
    );

    // --- Update the cadence in place -------------------------------------------
    // Now the business wants the report twice a day (02:00 and 14:00). Update the
    // schedule without recreating it; its identity and history are preserved.
    log(`\n=== Updating cadence to twice daily (02:00 and 14:00) ===`);
    const updated = await scheduler.updateCron("nightly-report", {
        cronExpression: "0 2,14 * * *",
    });
    log(`  new expression: ${updated?.cronExpression}`);
    log(`  next fire recomputed from now: ${updated?.nextRunAt.toISOString()}`);

    // Change only the payload, leaving the cadence and its place in the cycle be.
    const repayloaded = await scheduler.updateCron("nightly-report", {
        payload: JSON.stringify({ format: "csv" }),
    });
    log(`  payload updated to: ${repayloaded?.payload}`);
    log(`  next fire unchanged by payload edit: ${repayloaded?.nextRunAt.toISOString()}`);
};

main().catch((error) => {
    console.error("cron-backfill-update example failed:", error);
    process.exitCode = 1;
});
