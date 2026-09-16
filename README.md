<div align="center">

# Outpost

**Embeddable durable execution that resolves the ambiguous-failure problem, without a workflow cluster.**

_When your API call returns a 5xx but the write actually succeeded, Outpost stops you from doing it twice._

</div>

---


## What is Outpost?

An embeddable durable execution library that runs **inside your application process**. No orchestrator, no daemon, no cluster. Your own database is the coordination point.

- **Embeddable.** A library, not a platform. Add it to an existing app.
- **Correctness-first.** Leasing, stale-worker fencing, the commit window, and ambiguous-state resolution are the parts we refuse to cut corners on.
- **Pluggable storage.** The engine depends on a narrow storage contract. Any backend that provides the required atomic coordination primitives can implement it.
- **Modular.** Resilience (circuit breakers, backoff), alerts, and chaos testing live in separate plugin packages so the core stays small.


## The problem Outpost exists to solve

Outpost is for **finishing a multi-step process correctly, across systems and across time, when any step can fail on its own.** That covers a family of problems that idempotency keys and database transactions do not:

- **The ambiguous-failure window**  
  An API returns a `504` or `500` and you genuinely don't know whether the charge went through or the order was created. The queue redelivers, your retry fires, and now you've charged twice or created two orders.

  Idempotency keys alone don't close this, because the failure happened between the side effect and your durable commit. Outpost records the step as `AMBIGUOUS` and, on recovery, runs your **probe** (a query against the downstream system) before it ever retries, re-executing only if the effect never happened.

- **Multi-step recovery, not one atomic write**  
  A checkout charges the card, creates the order, then notifies the customer. A crash after the charge must resume at the order and never redo the charge. Outpost checkpoints each step and re-runs only the unfinished ones. A database transaction cannot span three external systems; this can.

- **Durable waits that outlive the process**  
  "Hold the order for two hours, then ship." "Wait a day, then send a reminder." A workflow can [`sleep`](./website/docs/scheduling/durable-sleep.md) durably: the timer is persisted, the process may exit, and the workflow resumes on time, possibly on another machine. No held connection, no lock, no cron job re-deriving state you already had.

- **Recurring work that survives restarts**  
  Durable cron runs a workflow on a schedule that lives in the database, not in one machine's memory. Any instance can fire it, exactly one wins the claim, missed windows can be replayed, and it is time-zone aware. It replaces a fragile `setInterval` or an OS crontab that silently drops runs when the box is down.

- **Fan-out into durable sub-executions**  
  One order fans out into one fulfilment per line item. Child workflows run concurrently, each memoised and recoverable on its own, each linked back to its parent for auditing.

- **Retries and backoff you do not hand-roll**  
  Per-step attempt budgets, exponential backoff, and full jitter, with the retry state persisted so a restart neither resets the counter nor fires every retry at once.

- **Optional steps that should not sink the job**  
  A fraud score or a best-effort sync can fail and fall back to a value instead of failing the whole workflow.

Each of these is a place teams otherwise hand-build a progress table, a retry loop, a timer, and a recovery path, one call at a time. Outpost provides them behind one tested embeddable library.

See the [Quick start](#quick-start) for a runnable workflow.

## "I already have idempotency keys and transactions. Do I even need this?"

Keep them; Outpost uses them too. The point of this section is not to re-list what Outpost does (see [the problems above](#the-problem-outpost-exists-to-solve)) but to be precise about where these two tools stop, because the boundary is exactly what durable execution adds.

- **An idempotency key makes one call safe to repeat**  
  It does not remember how far a multi-step process got. If step four fails and you retry from the top, steps one through three run again unless you also made each of them idempotent and added your own "did this already run?" check, which is most of a durable engine, hand-built.
- **A transaction makes one set of local writes atomic**  
  Its rollback stops at your database. It cannot undo a Stripe charge or a Shopify order, so it cannot make "charge, create order, email" all-or-nothing. The moment a process spans more than one system, the guarantee is gone.

- **Neither one spans time**  
  A transaction cannot stay open for two hours while you wait to ship, and neither tool schedules a retry, resumes after a crash, or lets you prove your recovery paths work before an outage does.

Outpost does not replace idempotency keys or transactions; it orchestrates them across a whole process. In fact a step's [probe](#the-problem-outpost-exists-to-solve) often relies on an idempotency key or a lookup to decide whether an ambiguous action already happened.

The honest rule: if your whole job is one idempotent write in one transaction, use those and move on. The moment it becomes "charge, then wait, then fulfill, then notify," and any of those can fail independently, you either build a progress tracker yourself or you let Outpost handle it.

## Quick start

This is a workflow that reserves stock, waits durably, then ships. Because the
wait is a durable sleep, the process can exit during it and resume later exactly
where it left off.

The example uses `JsonFileStorage` so the state survives a restart with
nothing to install; a real deployment swaps in the MySQL adapter and the workflow
code does not change.

This example mirrors the runnable
[`durable-sleep` example](./examples/order-processing/src/durable-sleep.ts).

```ts
import {
    JsonFileStorage,
    Scheduler,
    Step,
    Workflow,
    WorkflowEngine,
    type WorkflowContext,
} from "@outpost/core";

interface OrderInput {
    orderId: string;
}

@Workflow({ name: "fulfil-order" })
class FulfilOrder {
    /* Step methods take their own arguments; the @Step decorator adds durability.
     * Because its result is saved, reserveStock runs once, ever, no matter how
     * many times the process restarts.
     */
    @Step()
    async reserveStock(input: OrderInput) {
        return { reservationId: `res-${input.orderId}` };
    }

    @Step()
    async shipOrder(input: OrderInput) {
        return { trackingNumber: `trk-${input.orderId}` };
    }

    async run(context: WorkflowContext, input: OrderInput) {
        await this.reserveStock(input);

        /* Durable sleep: the timer is persisted, so the process may exit here and
         * resume when it becomes due, possibly on another machine.
         */
        await context.sleep("cooling-period", 60 * 60 * 1000);

        return this.shipOrder(input);
    }
}

/* JsonFileStorage keeps state in a file, which is what lets the workflow outlive
 * the process. Swap in MysqlStorage for production; nothing else changes.
 */
const storage = new JsonFileStorage("./outpost-state.json");
const engine = new WorkflowEngine(storage);

/* Start (or resume) an execution by passing the class. Completed steps are
 * memoized on resume, so reserveStock is never repeated.
 */
await engine.run(FulfilOrder, "order-42", { orderId: "order-42" });

/* The embedded scheduler wakes suspended workflows when their durable timers are
 * due. Run it inside your ordinary app processes; no separate daemon required.
 */
const scheduler = new Scheduler(storage);
scheduler.start(async (timer) => {
    await engine.run(FulfilOrder, timer.workflowIdentifier, {
        orderId: timer.workflowIdentifier,
    });
});
```

The `(workflowIdentifier, stepKey)` pair uniquely identifies a durable step. Re-running the same workflow identifier resumes from the last committed step instead of re-executing completed work.

## Packages

| Package                      | Purpose                                                                         |
| ---------------------------- | ------------------------------------------------------------------------------- |
| `@outpost/core`              | Workflow/step execution, leasing, ambiguous-state resolution, middleware, audit |
| `@outpost/storage-mysql`     | MySQL/InnoDB reference storage adapter                                          |
| `@outpost/transport-sqs`     | First-party SQS consumer/publisher (transport stays out of core)                |
| `@outpost/plugin-resilience` | Circuit breaker middleware plus backoff helpers                                 |
| `@outpost/plugin-alerts`     | Vendor-neutral alert hooks (webhook, Slack, PagerDuty)                          |
| `@outpost/plugin-chaos`      | Deterministic fault injection: crashes, transient failures, lease expiry        |

## What Outpost is not, and its honest limitations

- **Not a drop-in replacement for a dedicated orchestrator today**  
  If you need deterministic replay of arbitrary code across many languages and services right now, use a purpose-built platform.
- **Not an exactly-once guarantee for arbitrary external side effects**  
  Nothing is, without cooperation from the downstream system. The `AMBIGUOUS` status plus a `probe` resolve the window honestly, but they do not eliminate the underlying distributed-transaction problem. Prefer downstream idempotency keys where the provider supports them.
- **No deterministic replay**  
  Durability applies at explicit step boundaries (each `@Step` method), not to arbitrary control flow between them.
- **Circuit breaker state is process-local**  
  It is not fleet-wide dependency health.
- **The scheduler polls the storage backend**  
  This is designed for moderate timer volumes. Very high timer counts will need a different backend.

## Where it is today, and where it is going

Outpost ships first for **Node/TypeScript** with a **MySQL/InnoDB** reference storage adapter. That is the starting point, not the ceiling.

The architecture is deliberately built around a narrow storage abstraction and a transport-independent core so the project can grow **language agnostic** and **storage agnostic** over time.

Additional runtimes and storage backends (any system offering the required atomic primitives such as conditional writes, exclusive claims, leases, and indexed due-time queries) can slot in behind the same contract without changing workflow definitions.

## License

TBD.
