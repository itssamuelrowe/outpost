/**
 * End-to-end example: processing Shopify orders durably.
 *
 * This example wires together every part of Outpost:
 *
 * - The MySQL storage adapter persists all workflow and step state.
 * - The workflow engine runs a two-step "process order" workflow.
 * - The resilience plugin guards the payment step with a circuit breaker.
 * - The alerts plugin notifies an on-call channel when a workflow fails hard.
 * - The SQS transport consumes incoming order messages and hands each one to the
 *   engine.
 *
 * The scenario it solves is the motivating one: Shopify occasionally returns a
 * 5xx after it has already created the order. We classify that as an ambiguous
 * failure and supply a probe that looks the order up on recovery, so a
 * redelivered message never creates a duplicate order.
 */

import {
    ClassifyError,
    FailureKind,
    Probe,
    Scheduler,
    Step,
    Workflow,
    WorkflowEngine,
} from "@outpost/core";
import type { StepContext, WorkflowContext } from "@outpost/core";
import { AlertDispatcher, AlertSeverity, WebhookDestination } from "@outpost/plugin-alerts";
import { CircuitBreaker, createCircuitBreakerMiddleware } from "@outpost/plugin-resilience";
import { MysqlStorage } from "@outpost/storage-mysql";
import { SqsWorkflowConsumer } from "@outpost/transport-sqs";
import type { WorkflowMessage } from "@outpost/transport-sqs";
import { SQSClient } from "@aws-sdk/client-sqs";
import mysql from "mysql2/promise";

/**
 * The shape of the input each order workflow receives.
 */
interface OrderInput {
    orderReference: string;
    customerEmail: string;
    amountInCents: number;
}

/**
 * A stand-in for a real Shopify client. Replace with the actual SDK in
 * production.
 */
interface ShopifyClient {
    createOrder(input: OrderInput, correlationId: string): Promise<{ id: string }>;
    findOrderByCorrelationId(correlationId: string): Promise<{ id: string } | null>;
}

/**
 * Classifies timeouts and 5xx responses as ambiguous so the engine probes on
 * recovery.
 */
function classifyHttpError(error: unknown): FailureKind {
    const message = error instanceof Error ? error.message : String(error);
    return /timeout|5\d\d/i.test(message) ? FailureKind.AMBIGUOUS : FailureKind.DEFINITE;
}

/**
 * Builds a deterministic correlation id from the workflow identity.
 */
function correlationIdFor(context: StepContext): string {
    return `outpost:${context.workflowIdentifier}`;
}

// A single circuit breaker groups every call to the payment provider, so
// repeated failures trip it open and fail fast instead of hammering it. It lives
// at module scope so the @Step decorator below can attach its middleware; the
// breaker itself is stateful but shared, which is exactly the intent.
const paymentBreaker = new CircuitBreaker({
    name: "payment-provider",
    failureThreshold: 5,
    resetTimeoutMilliseconds: 30_000,
});

/**
 * The order workflow. Two durable steps: take payment, then create the Shopify
 * order. The order step is the one that can fail ambiguously (Shopify may 5xx
 * after it has already created the order), so it classifies HTTP errors and
 * carries a probe that looks the order up on recovery instead of creating a
 * duplicate.
 *
 * The Shopify client is injected through the constructor, so the workflow is
 * run as an instance: `engine.run(new ProcessOrder(shopify), id, input)`.
 */
@Workflow({ name: "process-order" })
class ProcessOrder {
    public constructor(private readonly shopify: ShopifyClient) {}

    @Step({
        id: "charge-payment",
        maxAttempts: 4,
        // Guard the payment call with the shared circuit breaker.
        middleware: [createCircuitBreakerMiddleware(paymentBreaker)],
    })
    public async chargePayment(input: OrderInput): Promise<{ chargeId: string }> {
        return chargePayment(input);
    }

    @Step({
        id: "create-shopify-order",
        maxAttempts: 3,
        classifyError: classifyHttpError,
    })
    public async createShopifyOrder(
        input: OrderInput,
        correlationId: string,
    ): Promise<{ orderId: string }> {
        const created = await this.shopify.createOrder(input, correlationId);
        return { orderId: created.id };
    }

    // On recovery from an ambiguous 5xx, look the order up rather than creating it
    // again. A probe method receives the StepContext from the engine, so it can
    // rebuild the same correlation id the create step used. If the order exists,
    // the step completes with no duplicate.
    @Probe("create-shopify-order")
    public async probeShopifyOrder(context: StepContext): Promise<{ orderId: string } | null> {
        const existing = await this.shopify.findOrderByCorrelationId(correlationIdFor(context));
        return existing ? { orderId: existing.id } : null;
    }

    public async run(context: WorkflowContext, input: OrderInput): Promise<{ orderId: string }> {
        // The workflow identifier is a stable correlation id both the create step
        // and its probe derive the Shopify tag from.
        const correlationId = `outpost:${context.workflowIdentifier}`;
        await this.chargePayment(input);
        return this.createShopifyOrder(input, correlationId);
    }
}

async function main(): Promise<void> {
    // 1. Persistence. The pool uses UTC so DATETIME values round-trip cleanly.
    const pool = mysql.createPool({
        uri: process.env.DATABASE_URL ?? "mysql://root:password@127.0.0.1:3306/outpost",
        connectionLimit: 10,
        timezone: "Z",
    });
    const storage = new MysqlStorage(pool);
    await storage.migrate();

    // 2. Alerting. A webhook destination receives critical incidents; delivery
    //    failures are logged and never disrupt workflow execution.
    const alerts = new AlertDispatcher(
        [
            new WebhookDestination({
                url: process.env.ALERT_WEBHOOK_URL ?? "https://example.com/hook",
            }),
        ],
        { onDeliveryError: (outcome) => console.error("Alert delivery failed", outcome) },
    );

    // 3. The engine, configured to surface any failure-recording problems. The
    //    workflow itself is the @Workflow-decorated ProcessOrder class above; its
    //    payment step is already guarded by the shared circuit breaker via the
    //    @Step middleware option.
    const engine = new WorkflowEngine(storage, {
        onRecordingError: (workflowIdentifier, error) =>
            console.error(`Failed to record failure for ${workflowIdentifier}`, error),
    });

    const shopify = createShopifyClient();

    // 4. The scheduler resumes workflows whose retry timers or sleeps have come due.
    const scheduler = new Scheduler(storage, {
        onHandlerError: (workflowIdentifier, error) =>
            console.error(`Scheduler failed to resume ${workflowIdentifier}`, error),
    });
    scheduler.start(async (timer) => {
        // A due timer means a step is ready to retry; re-running the workflow picks
        // up from the persisted state. The input is reloaded from storage in a real
        // system; here we assume it is available to the resume path.
        await resumeWorkflow(engine, storage, timer.workflowIdentifier);
    });

    // 5. The SQS consumer feeds incoming orders into the engine. A message is
    //    deleted only after its workflow run resolves; a thrown error leaves it on
    //    the queue for SQS to redeliver. Each message runs the ProcessOrder class,
    //    constructed with the Shopify client it needs.
    const consumer = new SqsWorkflowConsumer({
        client: new SQSClient({}),
        queueUrl: process.env.ORDERS_QUEUE_URL ?? "https://sqs.example.com/orders",
        onHandlerError: async (message, error) => {
            console.error("Order handler failed", message.workflowIdentifier, error);
            await alerts.dispatch({
                severity: AlertSeverity.CRITICAL,
                title: "Order workflow failed",
                message: `Workflow ${message.workflowIdentifier} could not be processed.`,
                workflowIdentifier: message.workflowIdentifier,
                occurredAt: new Date(),
            });
        },
    });

    await consumer.start(async (message: WorkflowMessage) => {
        await engine.run<OrderInput, { orderId: string }>(
            new ProcessOrder(shopify),
            message.workflowIdentifier,
            message.input as OrderInput,
        );
    });
}

/**
 * Placeholder payment call. Replace with a real payment provider integration.
 */
async function chargePayment(_input: OrderInput): Promise<{ chargeId: string }> {
    return { chargeId: "charge-placeholder" };
}

/**
 * Placeholder resume path; a real system reloads the stored input first.
 */
async function resumeWorkflow(
    _engine: WorkflowEngine,
    _storage: MysqlStorage,
    _workflowIdentifier: string,
): Promise<void> {
    // Intentionally left as a stub for the example.
}

/**
 * Placeholder Shopify client.
 */
function createShopifyClient(): ShopifyClient {
    const created = new Map<string, { id: string }>();
    return {
        async createOrder(_input, correlationId) {
            const order = { id: `SHOP-${created.size + 1}` };
            created.set(correlationId, order);
            throw new Error("503 Service Unavailable"); // the order was created, but Shopify 5xx'd
        },
        async findOrderByCorrelationId(correlationId) {
            return created.get(correlationId) ?? null;
        },
    };
}

main().catch((error) => {
    console.error("Fatal error starting the example", error);
    process.exitCode = 1;
});
