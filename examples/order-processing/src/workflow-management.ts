/**
 * Operating on workflows after they start: the lifecycle-management API.
 *
 * Starting a workflow is only half the story. In production you also need to
 * observe and steer executions after the fact: check a workflow's status, read
 * its result, list everything that failed overnight, or cancel a run that
 * should no longer proceed. Outpost exposes these as read-and-control methods
 * on the engine, backed by the same storage your workflows already use.
 *
 * This example runs a small mix of workflows — some that succeed, one that
 * fails, and one it cancels before completion — then demonstrates each
 * management call against them.
 *
 * It uses in-memory storage. Run it with:
 *
 * yarn tsx src/workflow-management.ts
 */

import {
    MemoryStorage,
    Step,
    Workflow,
    WorkflowCancelledError,
    WorkflowEngine,
    WorkflowStatus,
} from "@outpost/core";
import type { WorkflowContext } from "@outpost/core";

/**
 * The input to the charge workflow.
 */
interface ChargeInput {
    amount: number;
}

/**
 * The receipt a successful charge produces.
 */
interface ChargeReceipt {
    receiptId: string;
    amount: number;
}

function log(message: string): void {
    console.log(message);
}

/**
 * A workflow that succeeds and returns a receipt.
 */
@Workflow({ name: "charge" })
class Charge {
    @Step({ id: "charge-card" })
    public async chargeCard(amount: number): Promise<string> {
        return `rcpt-${amount}`;
    }

    public async run(context: WorkflowContext, input: ChargeInput): Promise<ChargeReceipt> {
        const receiptId = await this.chargeCard(input.amount);
        return { receiptId, amount: input.amount };
    }
}

/**
 * A workflow that always fails, to populate a FAILED record.
 */
@Workflow({ name: "broken" })
class Broken {
    @Step()
    public async explode(): Promise<never> {
        throw new Error("downstream returned 500");
    }

    public async run(): Promise<never> {
        return this.explode();
    }
}

const main = async (): Promise<void> => {
    const storage = new MemoryStorage();
    const engine = new WorkflowEngine(storage);

    // 1. Run a couple of successful charges and read their results back.
    log("=== Running successful workflows ===");
    await engine.run<ChargeInput, ChargeReceipt>(Charge, "charge-1", { amount: 1000 });
    await engine.run<ChargeInput, ChargeReceipt>(Charge, "charge-2", { amount: 2500 });

    const status1 = await engine.getWorkflowStatus("charge-1");
    log(`  charge-1 status: ${status1}`);

    const result2 = await engine.getWorkflowResult<ChargeReceipt>("charge-2");
    log(`  charge-2 result: ${JSON.stringify(result2)}`);

    const description1 = await engine.describeWorkflow<ChargeInput, ChargeReceipt>("charge-1");
    log(
        `  charge-1 described: name=${description1?.workflowName}, ` +
            `input=${JSON.stringify(description1?.input)}, output=${JSON.stringify(description1?.output)}`,
    );

    // 2. Run a workflow that fails, then find it via a status filter.
    log("\n=== A failing workflow ===");
    await engine.run(Broken, "broken-1", null).catch(() => undefined);

    const failed = await engine.listWorkflows({ statuses: [WorkflowStatus.FAILED] });
    log(`  workflows in FAILED state: ${failed.map((w) => w.workflowIdentifier).join(", ")}`);
    log(`  broken-1 error: ${failed[0]?.error}`);

    // 3. Cancel a workflow before it runs, and prove it will not resume.
    log("\n=== Cancellation ===");
    // Create the record without running it to completion, simulating a workflow
    // that has been started (or enqueued) but not yet executed.
    await storage.ensureWorkflow("charge-3", "charge", null);

    const cancelled = await engine.cancelWorkflow("charge-3");
    log(`  cancelWorkflow("charge-3") -> ${cancelled}`);
    log(`  charge-3 status: ${await engine.getWorkflowStatus("charge-3")}`);

    try {
        await engine.run<ChargeInput, ChargeReceipt>(Charge, "charge-3", { amount: 999 });
        log("  ERROR: cancelled workflow ran, which should not happen");
    } catch (error) {
        if (error instanceof WorkflowCancelledError) {
            log("  running charge-3 was refused with WorkflowCancelledError, as expected");
        } else {
            throw error;
        }
    }

    // 4. A full listing, most recently updated first.
    log("\n=== All workflows (most recent first) ===");
    const all = await engine.listWorkflows();
    for (const workflow of all) {
        log(`  - ${workflow.workflowIdentifier} [${workflow.status}] (${workflow.workflowName})`);
    }
};

main().catch((error) => {
    console.error("workflow-management example failed:", error);
    process.exitCode = 1;
});
