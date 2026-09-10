/**
 * A self-contained, runnable demonstration of Outpost.
 *
 * Unlike `main.ts`, which shows how the pieces wire together with SQS in
 * production, this file actually runs. It uses in-process fakes for the external
 * services, so you can watch a durable workflow execute — including the
 * ambiguous-state probe recovery — without standing up AWS or any real third
 * parties.
 *
 * Storage is chosen automatically:
 *   - If OUTPOST_DEMO_DB_URL is set, it uses the real MySQL adapter, so state
 *     survives across process runs.
 *   - If it is not set, it falls back to the in-memory adapter, so the demo runs
 *     with zero setup (state lives only for the duration of the process).
 *
 * Run it with a database:
 *   OUTPOST_DEMO_DB_URL="mysql://root:password@127.0.0.1:3306/outpost" yarn demo
 *
 * Or with no setup at all:
 *   yarn demo
 */

import { ClassifyError, FailureKind, MemoryStorage, Step, Workflow, WorkflowEngine } from "@outpost/core";
import type { StorageAdapter, WorkflowContext } from "@outpost/core";
import { MysqlStorage } from "@outpost/storage-mysql";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";

/** The input for the checkout workflow. */
interface OrderInput {
  orderId: string;
  customerPhone: string;
  customerEmail: string;
  totalInCents: number;
}

/**
 * A fake Shopify client that reproduces the motivating bug: the first attempt
 * to create an order genuinely creates it, but then returns a 500. A later
 * lookup by correlation id can find the already-created order.
 */
class FakeShopify {
  private readonly ordersByCorrelation = new Map<string, { id: string }>();
  private failNextWithFiveHundred = true;

  public async createOrder(correlationId: string): Promise<{ id: string }> {
    const order = { id: `SHOP-${this.ordersByCorrelation.size + 1}` };
    this.ordersByCorrelation.set(correlationId, order);
    if (this.failNextWithFiveHundred) {
      this.failNextWithFiveHundred = false;
      // The order was created, but the response fails. This is the ambiguous case.
      throw new Error("503 Service Unavailable");
    }
    return order;
  }

  public async findOrderByCorrelationId(correlationId: string): Promise<{ id: string } | null> {
    return this.ordersByCorrelation.get(correlationId) ?? null;
  }
}

/** Classifies timeouts and 5xx responses as ambiguous so the engine probes on recovery. */
function classifyHttpError(error: unknown): FailureKind {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|5\d\d/i.test(message) ? FailureKind.AMBIGUOUS : FailureKind.DEFINITE;
}

/**
 * The checkout workflow: create the order, then send WhatsApp and email
 * confirmations. The order step is the one that can fail ambiguously, so it has
 * a probe (discovered by the `probe<StepName>` convention).
 */
@Workflow({ name: "create-order-and-notify" })
class CreateOrderAndNotify {
  private correlationId = "";

  public constructor(private readonly shopify: FakeShopify) {}

  @Step({ maxAttempts: 3 })
  public async createOrder(): Promise<{ orderId: string }> {
    const created = await this.shopify.createOrder(this.correlationId);
    console.log(`  [createOrder] created ${created.id}`);
    return { orderId: created.id };
  }

  public classifyErrorForCreateOrder(error: unknown): FailureKind {
    return classifyHttpError(error);
  }

  public async probeCreateOrder(): Promise<{ orderId: string } | null> {
    const existing = await this.shopify.findOrderByCorrelationId(this.correlationId);
    if (existing) {
      console.log(`  [probeCreateOrder] found existing ${existing.id}; skipping create`);
      return { orderId: existing.id };
    }
    console.log("  [probeCreateOrder] no existing order; will create");
    return null;
  }

  @Step()
  public async notifyWhatsApp(input: OrderInput): Promise<{ sent: true }> {
    console.log(`  [notifyWhatsApp] messaging ${input.customerPhone}`);
    return { sent: true };
  }

  @Step()
  public async notifyEmail(input: OrderInput): Promise<{ sent: true }> {
    console.log(`  [notifyEmail] emailing ${input.customerEmail}`);
    return { sent: true };
  }

  public async run(context: WorkflowContext, input: OrderInput): Promise<{ orderId: string }> {
    this.correlationId = `outpost:${context.workflowIdentifier}`;
    const order = await this.createOrder();
    await this.notifyWhatsApp(input);
    await this.notifyEmail(input);
    return order;
  }
}

async function main(): Promise<void> {
  // Choose storage based on the environment: real MySQL when a URL is provided,
  // otherwise the in-memory adapter so the demo runs with no setup.
  const { storage, pool } = await createStorage();

  const engine = new WorkflowEngine(storage);
  const shopify = new FakeShopify();

  const input: OrderInput = {
    orderId: `order-${Date.now()}`,
    customerPhone: "+15551234567",
    customerEmail: "sam@example.com",
    totalInCents: 4200,
  };

  console.log(`\nRun 1: first attempt (the create-order step will 500 after creating)`);
  try {
    await engine.run(new CreateOrderAndNotify(shopify), input.orderId, input);
  } catch (error) {
    console.log(`  Run 1 stopped as expected: ${(error as Error).message}`);
  }

  console.log(`\nRun 2: resume (the probe should find the order and skip create)`);
  const result = await engine.run<OrderInput, { orderId: string }>(
    new CreateOrderAndNotify(shopify),
    input.orderId,
    input,
  );

  console.log(`\nDone. Final result:`, result);
  console.log("Notice the order was created exactly once, despite the 500 and the retry.");

  // Close the database pool only if we opened one.
  if (pool) {
    await pool.end();
  }
}

/**
 * Selects the storage backend from the environment.
 *
 * When `OUTPOST_DEMO_DB_URL` is set, a MySQL pool is created (using UTC so
 * timestamps round-trip cleanly) and its schema is ensured. Otherwise the demo
 * falls back to the in-memory adapter, which needs no setup but keeps state only
 * for the lifetime of the process.
 */
async function createStorage(): Promise<{ storage: StorageAdapter; pool: Pool | null }> {
  const databaseUrl = process.env.OUTPOST_DEMO_DB_URL;

  if (!databaseUrl) {
    console.log("No OUTPOST_DEMO_DB_URL set; using in-memory storage (state is not persisted).");
    return { storage: new MemoryStorage(), pool: null };
  }

  console.log(`Connecting to MySQL at ${databaseUrl.replace(/:[^:@/]*@/, ":****@")}`);
  const pool = mysql.createPool({ uri: databaseUrl, connectionLimit: 5, timezone: "Z" });
  const storage = new MysqlStorage(pool);
  await storage.migrate();
  return { storage, pool };
}

main().catch((error) => {
  console.error("Demo failed:", error);
  process.exitCode = 1;
});
