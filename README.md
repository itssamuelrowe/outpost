<div align="center">

# Outpost

**Embeddable durable execution that resolves the ambiguous-failure problem, without a workflow cluster.**

_When your API call returns a 5xx but the write actually succeeded, Outpost stops you from doing it twice._

</div>

---

## The problem Outpost exists to solve

You call an external API, a payment provider, Shopify, a warehouse. It returns a `504` or a `500`. Did the charge go through? Did the order get created? You genuinely don't know.

Your queue redelivers the message. Your retry fires again. Now you've charged the card twice, or created two orders. This is the **ambiguous-failure** window, and idempotency keys alone don't close it, because the failure happened between the side effect and your durable commit.

Outpost treats this as a first-class case. When a step fails with a timeout or 5xx, it records the step as `AMBIGUOUS`. On recovery it runs your **probe** first, a query against the downstream system, and only re-executes if the probe confirms the effect never happened.

```ts
@Workflow({ id: "process-order" })
class ProcessOrder {
  @Step({
    id: "create-order",
    maxAttempts: 4,
    // Timeouts and 5xx are ambiguous: the write may have landed.
    classifyError: (error) =>
      isTimeoutOr5xx(error) ? FailureKind.AMBIGUOUS : FailureKind.DEFINITE,
  })
  async createOrder(ctx: StepContext, input: OrderInput) {
    return shopify.orders.create({ ...input.order, tags: [ctx.workflowIdentifier] });
  }

  // On recovery, look before you leap.
  @Probe({ for: "create-order" })
  async findExistingOrder(ctx: StepContext) {
    const [existing] = await shopify.orders.search({ tag: ctx.workflowIdentifier });
    return existing ?? null; // non-null => already created, skip re-execution
  }
}
```

That is the wedge. Everything else in Outpost exists to make that pattern safe and boring.

## What Outpost is

An embeddable durable execution library that runs **inside your application process**. No orchestrator, no daemon, no cluster. Your own database is the coordination point.

- **Embeddable.** A library, not a platform. Add it to an existing app.
- **Correctness-first.** Leasing, stale-worker fencing, the commit window, and ambiguous-state resolution are the parts we refuse to cut corners on.
- **Pluggable storage.** The engine depends on a narrow storage contract. Any backend that provides the required atomic coordination primitives can implement it.
- **Modular.** Resilience (circuit breakers, backoff), alerts, and chaos testing live in separate plugin packages so the core stays small.

## Where it is today, and where it is going

Outpost ships first for **Node/TypeScript** with a **MySQL/InnoDB** reference storage adapter. That is the starting point, not the ceiling.

The architecture is deliberately built around a narrow storage abstraction and a transport-independent core so the project can grow **language agnostic** and **storage agnostic** over time. Additional runtimes and storage backends (any system offering the required atomic primitives such as conditional writes, exclusive claims, leases, and indexed due-time queries) can slot in behind the same contract without changing workflow definitions.

Object storage such as S3 is the one explicit exception: it is never a primary coordination store, because leasing, claiming, and timer scheduling do not map onto it.

## What Outpost is not

- Not a replacement for a dedicated orchestrator today. If you need deterministic replay of arbitrary code across many languages and services right now, use a purpose-built platform.
- Not an exactly-once guarantee for arbitrary external side effects. Nothing is, without cooperation from the downstream system. Outpost gives you the tools (`AMBIGUOUS` status plus `probe`) to resolve the window honestly.

## Quick start

```ts
import { Workflow, Step, WorkflowEngine } from "@outpost/core";
import { MysqlStorage } from "@outpost/storage-mysql";

@Workflow({ id: "process-order" })
class ProcessOrder {
  @Step({
    id: "charge-card",
    maxAttempts: 4,
    backoff: { baseMs: 1000, maxMs: 15_000, factor: 2 },
  })
  async chargeCard(ctx: StepContext, input: OrderInput) {
    return paymentGateway.charge(input.userId, input.amount);
  }

  @Step({ id: "fulfill-order", maxAttempts: 3 })
  async fulfillOrder(ctx: StepContext, input: OrderInput) {
    return warehouse.dispatch(input.orderId);
  }

  // The lifecycle function arranges ordinary control flow between durable steps.
  async run(ctx: WorkflowContext, input: OrderInput) {
    const payment = await this.chargeCard(ctx, input);

    // Durable sleep, survives process restarts.
    await ctx.sleep("cooling-period", 2 * 60 * 60 * 1000);

    const fulfillment = await this.fulfillOrder(ctx, input);
    return { paymentId: payment.id, trackingNumber: fulfillment.tracking };
  }
}

const engine = new WorkflowEngine(
  new MysqlStorage({ connectionString: process.env.DATABASE_URL }),
);
engine.register(ProcessOrder);

// Start (or resume) an execution. Completed steps are memoized on resume.
await engine.run("process-order", `order-${orderId}`, orderInput);
```

The `(workflowIdentifier, stepKey)` pair uniquely identifies a durable step. Re-running the same workflow identifier resumes from the last committed step instead of re-executing completed work.

## Core guarantees

- **Step memoization.** A committed step returns its stored output instead of running again.
- **Atomic claim and lease.** Concurrent workers cannot both hold a live lease on the same step.
- **Stale-worker fencing.** A worker that wakes after losing its lease cannot overwrite a newer owner's result.
- **Configurable retries** with exponential backoff and full jitter.
- **Durable sleep** that resumes after process restarts via the embedded scheduler.
- **Optional steps** that fall back instead of failing the workflow, and **immutable audit events** for every material transition.

## Packages

| Package | Purpose |
|---|---|
| `@outpost/core` | Workflow/step execution, leasing, ambiguous-state resolution, middleware, audit |
| `@outpost/storage-mysql` | MySQL/InnoDB reference storage adapter |
| `@outpost/transport-sqs` | First-party SQS consumer/publisher (transport stays out of core) |
| `@outpost/plugin-resilience` | Circuit breaker middleware plus backoff helpers |
| `@outpost/plugin-alerts` | Vendor-neutral alert hooks (webhook, Slack, PagerDuty) |
| `@outpost/plugin-chaos` | Deterministic fault injection: crashes, transient failures, lease expiry |

## Honest limitations

- **Exactly-once external side effects are not guaranteed.** The `probe` pattern resolves the ambiguous window, but it does not eliminate the underlying distributed-transaction problem. Prefer downstream idempotency keys where the provider supports them.
- **Circuit breaker state is process-local.** It is not fleet-wide dependency health.
- **The scheduler polls the storage backend.** This is designed for moderate timer volumes. Very high timer counts will need a different backend.
- **No deterministic replay.** Durability applies at explicit step boundaries (each `@Step` method), not to arbitrary control flow between them.

## Repository layout

```text
packages/
├── core/                 # @outpost/core
├── storage-mysql/        # @outpost/storage-mysql
├── transport-sqs/        # @outpost/transport-sqs
├── plugin-resilience/    # @outpost/plugin-resilience
├── plugin-alerts/        # @outpost/plugin-alerts
└── plugin-chaos/         # @outpost/plugin-chaos
web/                      # Landing page (Next.js)
```

See [`requirements.md`](./requirements.md) for the full specification.

## License

TBD.
