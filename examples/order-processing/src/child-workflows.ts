/**
 * Child workflows: composing durable sub-routines.
 *
 * A workflow does not have to be a flat list of steps. It can start other
 * workflows as first-class, durable children, let them run, and use their
 * results. Each child is a durable execution in its own right: its steps are
 * memoised, it survives restarts, and it is linked back to its parent so the
 * whole tree is auditable.
 *
 * This example models order fulfilment as a parent workflow that fans out to
 * one child per line item (a "fulfil item" workflow), runs them concurrently,
 * and then aggregates their tracking numbers. It shows three things:
 *
 * 1. `context.runChild(...)` — start a child and await its result in one call.
 * 2. `context.startChild(...)` — start several children, then gather results.
 * 3. Memoisation across a resume: re-running the parent does not re-run the
 *    children's committed steps.
 *
 * It uses in-memory storage, so there is nothing to configure. Run it with:
 *
 * yarn tsx src/child-workflows.ts
 */

import { MemoryStorage, Step, Workflow, WorkflowEngine } from "@outpost/core";
import type { WorkflowContext } from "@outpost/core";

/**
 * One line item in an order.
 */
interface LineItem {
    sku: string;
    quantity: number;
}

/**
 * The parent workflow's input: an order made of several line items.
 */
interface OrderInput {
    orderId: string;
    items: LineItem[];
}

/**
 * What fulfilling a single item produces.
 */
interface ItemFulfilment {
    sku: string;
    trackingNumber: string;
}

/**
 * The parent workflow's result: the order id plus every item's fulfilment.
 */
interface OrderFulfilment {
    orderId: string;
    fulfilments: ItemFulfilment[];
}

/**
 * A timestamped log line so the sequence of events is easy to follow.
 */
function log(message: string): void {
    const time = new Date().toISOString().slice(11, 19);
    console.log(`[${time}] ${message}`);
}

let reservationRuns = 0;

/**
 * The child workflow: fulfil a single line item. It reserves stock and books a
 * shipment, each as a durable step. Because these are steps, they are memoised:
 * a resume of the parent will not run them again.
 */
@Workflow({ name: "fulfil-item" })
class FulfilItem {
    @Step()
    public async reserve(item: LineItem): Promise<{ reservationId: string }> {
        reservationRuns += 1;
        log(`    reserve RUNNING for ${item.sku} x${item.quantity}`);
        return { reservationId: `res-${item.sku}` };
    }

    @Step()
    public async ship(item: LineItem, reservationId: string): Promise<{ trackingNumber: string }> {
        log(`    ship RUNNING for ${item.sku}`);
        return { trackingNumber: `trk-${item.sku}-${reservationId}` };
    }

    public async run(_context: WorkflowContext, item: LineItem): Promise<ItemFulfilment> {
        const reservation = await this.reserve(item);
        const shipment = await this.ship(item, reservation.reservationId);
        return { sku: item.sku, trackingNumber: shipment.trackingNumber };
    }
}

/**
 * The parent workflow: fan out to one child per line item, run them
 * concurrently, then aggregate. `startChild` returns a handle immediately;
 * awaiting `handle.result()` runs the child to completion durably.
 */
@Workflow({ name: "fulfil-order" })
class FulfilOrder {
    public async run(context: WorkflowContext, order: OrderInput): Promise<OrderFulfilment> {
        log(`  parent fulfilling order ${order.orderId} with ${order.items.length} items`);

        const handles = await Promise.all(
            order.items.map((item, index) =>
                // The child key is stable per item, so a resume addresses the same
                // child rather than starting a new one.
                context.startChild<LineItem, ItemFulfilment>(`item-${index}`, FulfilItem, item),
            ),
        );

        const fulfilments = await Promise.all(handles.map((handle) => handle.result()));
        return { orderId: order.orderId, fulfilments };
    }
}

const main = async (): Promise<void> => {
    const storage = new MemoryStorage();
    const engine = new WorkflowEngine(storage);

    const order: OrderInput = {
        orderId: "order-1001",
        items: [
            { sku: "widget", quantity: 2 },
            { sku: "gadget", quantity: 1 },
            { sku: "gizmo", quantity: 5 },
        ],
    };

    // First run: every child and every child step executes once.
    log("=== First run ===");
    const first = await engine.run<OrderInput, OrderFulfilment>(FulfilOrder, order.orderId, order);
    log(`  parent COMPLETED: ${first.fulfilments.length} items fulfilled`);
    for (const fulfilment of first.fulfilments) {
        log(`    ${fulfilment.sku} -> ${fulfilment.trackingNumber}`);
    }
    log(`  reservation steps executed so far: ${reservationRuns}`);

    // Second run with the same identifier: the parent and its children are all
    // memoised. No "RUNNING" lines appear, and the reservation count is unchanged.
    log("\n=== Second run (resume) ===");
    const second = await engine.run<OrderInput, OrderFulfilment>(FulfilOrder, order.orderId, order);
    log(`  parent COMPLETED again with identical result: ${second.orderId}`);
    log(`  reservation steps executed total: ${reservationRuns} (unchanged, all memoised)`);

    // The children are recorded as distinct workflows linked to the parent, which
    // you can query through the lifecycle-management API.
    const children = await engine.listWorkflows({ parentWorkflowIdentifier: order.orderId });
    log(`\nChildren of ${order.orderId} (${children.length}):`);
    for (const child of children) {
        log(`  - ${child.workflowIdentifier} [${child.status}] (${child.workflowName})`);
    }
};

main().catch((error) => {
    console.error("child-workflows example failed:", error);
    process.exitCode = 1;
});
