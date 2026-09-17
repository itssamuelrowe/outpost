/**
 * Durable sleep that survives a process restart.
 *
 * This example proves the central promise of a durable sleep: a workflow can
 * pause for a wall-clock duration, the process can be killed at any moment, and
 * running it again resumes the workflow exactly where it left off, without
 * repeating work that already finished.
 *
 * The workflow is deliberately tiny:
 *
 * 1. reserveStock (a step, runs before the sleep)
 * 2. ctx.sleep("cooling-period", 1 minute) <-- durable pause
 * 3. shipOrder (a step, runs after the sleep)
 *
 * Run it:
 *
 * yarn tsx src/durable-sleep.ts
 *
 * You will see reserveStock run, then a live countdown for the one-minute
 * sleep. Press Ctrl+C at any point during the countdown to kill the process.
 * Run the same command again: it does NOT re-run reserveStock, it picks the
 * countdown back up from where the durable timer says it should, and when the
 * minute is up it runs shipOrder and completes.
 *
 * State is kept in a JSON file on disk via JsonFileStorage (from
 * @outpost/core), which is what lets the workflow outlive the process. A real
 * deployment would use the MySQL adapter instead.
 */

import { existsSync, rmSync } from "node:fs";

import {
    JsonFileStorage,
    Scheduler,
    Step,
    Workflow,
    WorkflowEngine,
    WorkflowStatus,
    WorkflowSuspendedError,
    type WorkflowContext,
} from "@outpost/core";

/**
 * Where the durable state lives between runs of this process.
 */
const STORE_PATH = new URL("../.durable-sleep-state.json", import.meta.url).pathname;

/**
 * The stable identifier for this workflow execution, reused across restarts.
 */
const WORKFLOW_ID = "order-42";

/**
 * The durable pause between reserving stock and shipping.
 */
const SLEEP_MS = 60_000; // one minute

/**
 * A timestamped log line so the sequence of events is easy to follow.
 */
function log(message: string): void {
    const time = new Date().toISOString().slice(11, 19); // HH:MM:SS
    console.log(`[${time}] ${message}`);
}

interface OrderInput {
    orderId: string;
}

/**
 * The workflow. `reserveStock` and `shipOrder` log when they actually execute.
 * Because completed steps are memoized, `reserveStock` logs exactly once no
 * matter how many times the process is restarted, and `shipOrder` logs only
 * after the sleep has elapsed.
 */
@Workflow({ name: "fulfil-order" })
class FulfilOrder {
    @Step()
    public async reserveStock(input: OrderInput): Promise<{ reservationId: string }> {
        log(`  reserveStock RUNNING for ${input.orderId} (happens once, ever)`);
        return { reservationId: `res-${input.orderId}` };
    }

    @Step()
    public async shipOrder(input: OrderInput): Promise<{ trackingNumber: string }> {
        log(`  shipOrder RUNNING for ${input.orderId} (only after the sleep)`);
        return { trackingNumber: `trk-${input.orderId}` };
    }

    public async run(context: WorkflowContext, input: OrderInput): Promise<string> {
        await this.reserveStock(input);
        await context.sleep("cooling-period", SLEEP_MS);
        await this.shipOrder(input);
        return `order ${input.orderId} shipped`;
    }
}

/**
 * Prints a live, in-place countdown until `dueAt`. Resolves when the due time
 * is reached. The countdown reflects the durable timer, so after a restart it
 * shows the true remaining time, not a fresh minute.
 */
async function countDownUntil(dueAt: Date): Promise<void> {
    return new Promise((resolve) => {
        const render = (): void => {
            const remainingMs = dueAt.getTime() - Date.now();
            if (remainingMs <= 0) {
                process.stdout.write(`\r  sleeping... 0s remaining   \n`);
                clearInterval(handle);
                resolve();
                return;
            }
            const seconds = Math.ceil(remainingMs / 1000);
            // \r returns to the start of the line so the countdown updates in place.
            process.stdout.write(`\r  sleeping... ${seconds}s remaining   `);
        };
        render();
        const handle = setInterval(render, 250);
    });
}

/**
 * Runs (or resumes) the workflow once. Returns `true` if it completed, or
 * `false` if it suspended at the durable sleep.
 */
async function runOnce(engine: WorkflowEngine): Promise<boolean> {
    try {
        const result = await engine.run(new FulfilOrder(), WORKFLOW_ID, { orderId: WORKFLOW_ID });
        log(`workflow COMPLETED: ${result}`);
        return true;
    } catch (error) {
        if (error instanceof WorkflowSuspendedError) {
            return false;
        }
        throw error;
    }
}

const main = async (): Promise<void> => {
    // A fresh, completed run should start over so the demo is repeatable. If the
    // previous run is still mid-sleep (SUSPENDED), we keep the file and resume it.
    const storage = new JsonFileStorage(STORE_PATH);
    if (existsSync(STORE_PATH)) {
        const previousStatus = (await storage.getWorkflow(WORKFLOW_ID))?.status;
        if (previousStatus === WorkflowStatus.COMPLETED) {
            log("previous run had completed; starting a fresh workflow");
            rmSync(STORE_PATH);
        } else if (previousStatus === WorkflowStatus.SUSPENDED) {
            log("found a suspended workflow on disk; resuming it");
        }
    }

    const engine = new WorkflowEngine(storage);

    log(`running workflow "${WORKFLOW_ID}"`);
    const completedImmediately = await runOnce(engine);
    if (completedImmediately) {
        return;
    }

    // The workflow suspended at the durable sleep. Find the timer's due time so we
    // can show an accurate countdown, then let the embedded scheduler resume the
    // workflow when the timer becomes due.
    const dueTimer = storage
        .dump()
        .schedules.find((schedule) => schedule.stepKey === "cooling-period");
    const dueAt = dueTimer ? dueTimer.runAt : new Date(Date.now() + SLEEP_MS);

    log(`workflow SUSPENDED at durable sleep; resumes at ${dueAt.toISOString().slice(11, 19)}`);
    log("press Ctrl+C any time to kill this process, then run the command again to resume");

    await countDownUntil(dueAt);

    // The scheduler polls for due timers and resumes the workflow by running it
    // again with the same identifier. reserveStock is skipped (already committed),
    // the sleep is now in the past so it returns, and shipOrder runs.
    const scheduler = new Scheduler(storage, { pollIntervalMilliseconds: 500 });
    await new Promise<void>((resolve, reject) => {
        scheduler.start(async (timer) => {
            log(`scheduler resuming "${timer.workflowIdentifier}" (timer: ${timer.stepKey})`);
            try {
                await runOnce(engine);
                resolve();
            } catch (error) {
                reject(error instanceof Error ? error : new Error(String(error)));
            }
        });
    });
    await scheduler.stop();
};

main().catch((error) => {
    console.error("durable-sleep example failed:", error);
    process.exitCode = 1;
});
