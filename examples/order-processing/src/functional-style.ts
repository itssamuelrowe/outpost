/**
 * The functional authoring style.
 *
 * Every other example in this folder uses the class-and-decorator style, which
 * is what we recommend by default. This file exists to show the alternative:
 * defining a workflow as a plain function with `engine.defineWorkflow`, using
 * `context.step(...)` for each durable action. The two styles behave
 * identically because the decorator style is a thin wrapper over this one; pick
 * whichever reads better for you.
 *
 * The workflow models a checkout that creates an order, charges the card, and
 * sends two notifications. Running it twice with the same identifier shows that
 * completed steps are memoised and never repeated.
 *
 * It uses in-memory storage, so there is nothing to configure. Run it with:
 *
 * yarn tsx src/functional-style.ts
 */

import { MemoryStorage, WorkflowEngine } from "@outpost/core";

/**
 * The checkout input.
 */
interface OrderInput {
    orderId: string;
    totalInCents: number;
    customerPhone: string;
    customerEmail: string;
}

/**
 * What the workflow returns once the order is placed and confirmed.
 */
interface OrderResult {
    orderId: string;
    receiptId: string;
}

function log(message: string): void {
    console.log(message);
}

// In-process fakes standing in for external systems, so the example is runnable
// with nothing installed. Each logs when it actually executes, which makes the
// memoisation visible on the second run.
const orders = {
    async create(input: OrderInput): Promise<{ orderId: string }> {
        log(`  [orders.create] creating ${input.orderId}`);
        return { orderId: input.orderId };
    },
};
const paymentProvider = {
    async charge(totalInCents: number): Promise<{ receiptId: string }> {
        log(`  [payment.charge] charging ${(totalInCents / 100).toFixed(2)}`);
        return { receiptId: `rcpt-${totalInCents}` };
    },
};
const whatsApp = {
    async sendMessage(phone: string, body: string): Promise<void> {
        log(`  [whatsApp] to ${phone}: ${body}`);
    },
};
const email = {
    async send(address: string, subject: string, body: string): Promise<void> {
        log(`  [email] to ${address}: ${subject} - ${body}`);
    },
};

const main = async (): Promise<void> => {
    const storage = new MemoryStorage();
    const engine = new WorkflowEngine(storage);

    // Register the workflow as a named function. Inside it, each durable action
    // is wrapped in `context.step(key, fn, options?)`. The step key is the first
    // argument, so it stays stable across resumes (the decorator style derives it
    // from the method name instead).
    engine.defineWorkflow<OrderInput, OrderResult>(
        "create-order-and-notify",
        async (context, input) => {
            await context.step("create-order", async () => orders.create(input));

            const payment = await context.step(
                "charge-card",
                async () => paymentProvider.charge(input.totalInCents),
                { maxAttempts: 4 },
            );

            await context.step(
                "notify-whatsapp",
                async () => {
                    await whatsApp.sendMessage(
                        input.customerPhone,
                        `Order ${input.orderId} confirmed!`,
                    );
                    // A step result must be serializable, so return plain data
                    // rather than the notifier's void.
                    return { sent: true };
                },
                { maxAttempts: 5 },
            );

            await context.step(
                "notify-email",
                async () => {
                    await email.send(
                        input.customerEmail,
                        "Your order is confirmed",
                        `Order ${input.orderId}`,
                    );
                    return { sent: true };
                },
                { maxAttempts: 5 },
            );

            return { orderId: input.orderId, receiptId: payment.receiptId };
        },
    );

    const input: OrderInput = {
        orderId: "order-777",
        totalInCents: 4999,
        customerPhone: "+15551234567",
        customerEmail: "sam@example.com",
    };

    // A registered functional workflow is run by name.
    log("=== First run ===");
    const first = await engine.run<OrderInput, OrderResult>(
        "create-order-and-notify",
        input.orderId,
        input,
    );
    log(`  result: ${JSON.stringify(first)}`);

    // Second run with the same identifier: every step is already committed, so
    // none of the fakes above log again; the saved result is returned.
    log("\n=== Second run (resume; all steps memoised) ===");
    const second = await engine.run<OrderInput, OrderResult>(
        "create-order-and-notify",
        input.orderId,
        input,
    );
    log(`  result: ${JSON.stringify(second)}`);
    log("\nNo step re-ran on the second run: completed work is memoised.");
};

main().catch((error) => {
    console.error("functional-style example failed:", error);
    process.exitCode = 1;
});
