# Embeddable Durable Execution Library — Requirements Specification

## 1. Document Purpose

This document consolidates the requirements, design decisions, constraints, and implementation expectations established in the conversation for an embeddable durable execution library.

The intended product is a lightweight workflow/durable-execution library that runs inside an application's process, persists workflow and step state in an atomic storage backend, supports durable timers and background execution, and exposes modular integrations for resilience, queues, alerting, and fault injection.

The central product proposition is:

> Provide durable, resumable, idempotent step execution without requiring a dedicated workflow orchestrator or external workflow cluster.

The conversation explicitly prioritizes simplicity, embeddability, storage portability across systems with appropriate atomic primitives, and modularity over a monolithic platform. The requirements below preserve those decisions and distinguish core requirements from implementation recommendations and known limitations.

---

## 2. Product Scope

### 2.1 In Scope

The library shall provide:

- In-process durable workflow/step execution.
- Step-level checkpointing and memoization.
- Crash recovery through persisted execution state.
- Atomic step claiming/leasing to prevent concurrent execution.
- Idempotent return of previously committed step results.
- Configurable retry policies.
- Exponential backoff with optional full jitter.
- Durable time-based waits/sleep.
- Embedded scheduling for due workflow resumes.
- Pluggable primary state storage.
- A default MySQL/InnoDB storage implementation.
- PostgreSQL and Redis storage adapters as modular packages.
- Queue/transport adapters, with SQS as the first-party implementation.
- Mandatory, optional, and deferred execution semantics.
- Middleware/interceptor pipelines.
- Circuit breaker middleware.
- Alerting hooks/middleware.
- Immutable audit logging.
- Deterministic chaos/fault-injection testing.
- A modular package layout so integrations can be installed independently.
- Developer-facing TypeScript APIs for defining workflows and steps.

### 2.2 Out of Scope

The initial architecture shall not require:

- A dedicated external workflow orchestrator.
- A separate workflow daemon or cluster.
- S3/object storage as the primary workflow state store.
- A centralized APM implementation embedded in the core.
- A queue implementation hardcoded into the core engine.
- Full deterministic replay of arbitrary application code.
- Automatic sandboxing of nondeterministic code.
- A guarantee that arbitrary external side effects are exactly-once without cooperation from the external system.

Object storage may be considered later for large payload offloading, but it is not part of the primary state-coordination contract.

---

## 3. Product Goals

### G-001 — Embeddability

The library must run directly in the host application process.

### G-002 — Zero Additional Orchestration Infrastructure

The core durable execution engine must not require users to operate a dedicated workflow server, workflow daemon, cluster, or control plane.

### G-003 — Simple Durable Semantics

The core state model should be understandable as persisted workflow and step state transitions rather than a complex distributed orchestration protocol.

### G-004 — Durable Step Execution

A workflow must be able to resume after application/process failure without requiring the developer to manually construct workflow state machines.

### G-005 — Idempotent Step Recovery

Previously committed step results must be reused rather than re-executing the step.

### G-006 — Storage Portability

The execution engine must depend on a narrow storage abstraction so that supported atomic backends can be swapped without changing workflow definitions.

### G-007 — Modular Reliability Features

Retries, circuit breakers, alerting, transports, and chaos testing should integrate through modular packages and middleware rather than increasing the core's coupling.

### G-008 — Practical Mid-Market Positioning

The product should occupy the space between simple task queues and heavier dedicated workflow systems, especially for teams that want durable steps without operating a workflow cluster.

---

## 4. Architectural Principles

### AR-001 — Core Engine Is an Execution State Machine

The core should primarily manage:

- workflow identity;
- step identity;
- persisted step state;
- step claiming/leasing;
- step completion;
- step failure;
- timer registration;
- state/event recording;
- middleware execution.

The core should remain unaware of specific queue vendors, alerting vendors, and transport protocols.

### AR-002 — Storage Must Provide Atomic Coordination

Primary workflow storage must provide sufficient atomic primitives for:

- conditional state transitions;
- exclusive step claims;
- leases/lock expiration;
- indexed due-time queries;
- durable writes;
- consistent reads of execution state.

Recommended supported storage classes are:

- MySQL/InnoDB;
- PostgreSQL;
- SQLite where concurrency requirements permit;
- Redis using atomic scripting and ordered data structures.

### AR-003 — Object Storage Is Not Primary State

S3 and similar object stores shall **never** be supported as the primary coordination/state store. This is a permanent architectural decision, not an initial-release limitation. The required scheduler, leasing, and atomic workflow coordination semantics do not map onto object storage, and no future release will add S3 as a primary state backend.

Large payload offloading to object storage may be considered as a separate, non-coordination concern (see PERF-004), but object storage shall not participate in step claiming, leasing, or timer scheduling.

### AR-004 — Integration Features Are First-Party Modules

First-party packages may provide a cohesive user experience while preserving core modularity.

The intended structure is:

```text
packages/
├── core/
├── storage-mysql/
├── storage-postgres/
├── storage-redis/
├── transport-sqs/
├── plugin-resilience/
├── plugin-alerts/
└── plugin-chaos/
```

### AR-005 — Explicit Durable Steps

Durability applies at explicit step boundaries such as `ctx.step(...)`.

The library does not promise transparent durability for arbitrary JavaScript control flow or nondeterministic code between checkpoints.

### AR-006 — Separation of Lifecycles

Durable execution and circuit breaking have different semantics:

- durable execution is long-lived and retry/resume oriented;
- circuit breaking is fail-fast and dependency-health oriented.

Therefore, circuit breakers belong in middleware rather than hardcoded into the durable state engine.

### AR-007 — Transport Independence

Workflows may be initiated by SQS, HTTP, gRPC, direct application invocation, or future event sources.

Transport lifecycle concerns such as batching, prefetching, visibility timeouts, ACK/NACK semantics, partitioning, and consumer groups must not be embedded in the workflow core.

---

## 5. Functional Requirements

## 5.1 Workflow Definition and Execution

### FR-001 — Workflow Definition

The library shall allow developers to define named workflows as asynchronous functions receiving a workflow context and input.

Illustrative API:

```ts
const workflow = engine.defineWorkflow(
  "process-order",
  async (ctx, input) => {
    // durable steps
  }
);
```

### FR-002 — Workflow Identity

Every workflow execution shall have a stable workflow execution identifier.

### FR-003 — Workflow Input

Workflow input shall be persisted or otherwise durably associated with the workflow execution when the workflow requires recovery from a later process.

### FR-004 — Workflow Output

A completed workflow may persist a final output value.

### FR-005 — Workflow Status

The workflow lifecycle shall support, at minimum:

- `RUNNING`
- `COMPLETED`
- `FAILED`
- `SUSPENDED`

An implementation may add states where required by operational behavior, but state semantics must be documented.

### FR-006 — Explicit Step Boundaries

Developers shall invoke durable step execution explicitly, for example:

```ts
await ctx.step("charge-card", async () => {
  return await paymentGateway.charge(...);
});
```

### FR-007 — Stable Step Keys

Each durable step must have a stable key scoped to the workflow execution.

The pair:

```text
(workflow_id, step_key)
```

shall uniquely identify a durable step execution.

---

## 5.2 Step Memoization and Idempotency

### FR-008 — Completed-Step Memoization

When the storage layer reports that a step is already `COMPLETED`, the engine shall return the persisted step output without executing the step function again.

### FR-009 — Atomic Step Claim

The engine shall claim a runnable step through an atomic storage operation.

A claim operation must be capable of returning:

- whether the step was claimed;
- any already cached result;
- the current attempt number.

### FR-010 — Step Lease

A running step shall have a lease/lock duration.

If a worker disappears without completing the step, an expired lease shall permit another worker to take over.

### FR-011 — Concurrent Worker Protection

Two workers attempting to run the same step concurrently must not both obtain a valid exclusive step claim under normal storage semantics.

### FR-012 — Atomic Success Commit

Successful step completion shall persist the step result and associated execution metadata atomically enough to prevent a second worker from observing the step as permanently incomplete after a successful commit.

### FR-013 — Audit Association

Step lifecycle changes shall create corresponding audit events where configured.

### FR-014 — Side-Effect Limitation

The library shall document that persisted memoization alone cannot make an arbitrary external side effect exactly-once across the crash window between external side-effect completion and durable state commit.

The library's purpose is to make durable step recovery practical, not to eliminate all external distributed transaction problems.

---

## 5.3 Retry and Backoff

### FR-015 — Configurable Maximum Attempts

Each retryable step shall support a configurable maximum attempt count.

### FR-016 — Exponential Backoff

Retry delay shall support exponential growth with configurable:

- base delay;
- maximum delay;
- multiplicative factor.

### FR-017 — Full Jitter

Full jitter should be supported and enabled by default for standard retry policies.

The reference algorithm is:

```text
rawDelay = min(maxDelay, baseDelay × factor^attempt)
delay = random(0, rawDelay)
```

### FR-018 — Retry Scheduling

A retryable failure shall be persistable with a `nextAttemptAt`/equivalent timestamp so the retry can occur after the configured delay.

### FR-019 — Exhausted Retry Handling

When maximum attempts are exhausted, the engine shall:

- record the terminal step failure;
- emit an audit event;
- expose an alert hook for retry exhaustion;
- propagate the error for mandatory steps.

### FR-020 — Independent Retry Policies

Different steps shall be able to configure different retry budgets and backoff policies.

This is particularly important for critical-path integrations versus deferred, best-effort integrations.

---

## 5.4 Circuit Breaker Middleware

### FR-021 — Middleware-Based Circuit Breakers

Circuit breakers shall be implemented as middleware or plugins rather than core storage/execution logic.

### FR-022 — Circuit States

A standard circuit breaker implementation shall support:

- `CLOSED`
- `OPEN`
- `HALF_OPEN`

### FR-023 — Fail-Fast Behavior

When a circuit is `OPEN`, calls guarded by the circuit should fail without invoking the downstream function until the reset/probe period permits a test.

### FR-024 — Configurable Threshold

Circuit breaker configuration shall support at least:

- failure threshold;
- reset timeout.

A future implementation may support sliding-window failure rates and time windows.

### FR-025 — Success Reset

Successful probe/execution shall restore the breaker to `CLOSED` and reset the failure count.

### FR-026 — Circuit Grouping

Multiple steps may share a circuit breaker group for a common downstream dependency, such as a payment provider.

### FR-027 — Scope Warning

The initial in-memory circuit breaker is process-local.

A distributed/global circuit state across application instances shall not be implied unless a shared coordination backend is later introduced.

---

## 5.5 Durable Timers and Sleep

### FR-028 — Durable Sleep

The workflow context shall support a durable sleep/wait operation.

Example:

```ts
await ctx.sleep("cooling-period", "2 hours");
```

The workflow must be able to resume after the wait even if the original process exits.

### FR-029 — Timer Persistence

Timer metadata shall be persisted durably.

A timer record should include:

- timer identifier;
- workflow identifier;
- optional step key;
- due time;
- status;
- payload;
- timestamps.

### FR-030 — Embedded Scheduler

The library shall provide an embedded scheduler/poller that can run inside application processes.

### FR-031 — Due Timer Selection

SQL-based schedulers should use indexed due-time queries and row-level concurrency protection such as `FOR UPDATE SKIP LOCKED` where supported.

### FR-032 — Multi-Instance Safety

Multiple application instances may execute the scheduler simultaneously without processing the same timer more than once under normal locking semantics.

### FR-033 — Redis Timer Support

The Redis adapter may use a sorted set keyed by timestamp for scalable due-time scheduling.

---

## 5.6 Optional and Deferred Steps

The library shall distinguish three execution semantics.

### FR-034 — Mandatory Steps

Mandatory steps shall:

- block workflow progression;
- retry according to their policy;
- ultimately fail the workflow when retries are exhausted unless the workflow explicitly handles the error.

Typical examples include charging a card or reserving inventory.

### FR-035 — Optional Steps

Optional steps shall:

- execute in line with the workflow;
- retry according to configured limits;
- return a configured fallback value after terminal failure;
- allow workflow progression;
- record the terminal outcome as `FAILED_OPTIONAL`.

Example:

```ts
await ctx.step("check-fraud-score", fn, {
  optional: true,
  fallbackValue: {
    riskScore: 0,
    status: "UNVERIFIED"
  }
});
```

### FR-036 — Deferred Steps

Deferred steps shall:

- not block the main workflow;
- be registered durably;
- run independently through a queue or scheduler;
- have their own retry/backoff policy;
- have their own execution identity;
- continue independently of the main workflow's latency path.

Example:

```ts
await ctx.defer("sync-to-salesforce", async () => {
  // background work
});
```

### FR-037 — Deferred Task Idempotency

Registering the same deferred task more than once for the same workflow execution and task key shall return the existing task identifier rather than creating duplicate logical tasks.

### FR-038 — Deferred Task State

The state model shall distinguish detached/deferred work from ordinary inline workflow steps.

At minimum, the implementation may use a state such as:

- `DEFERRED`

for a task awaiting independent execution.

---

## 5.7 Queue and Transport Integration

### FR-039 — Transport Adapter Contract

Queue/transport adapters shall be separate packages.

### FR-040 — SQS First-Party Adapter

A first-party SQS adapter shall support:

- publishing workflow messages;
- consuming messages;
- long polling;
- successful acknowledgement/deletion;
- retry via SQS visibility/redrive behavior;
- FIFO deduplication where configured;
- workflow-based message grouping where applicable.

### FR-041 — Queue Abstraction

A transport interface should support operations conceptually equivalent to:

```ts
interface QueueProvider {
  publish(queueName: string, message: QueueMessage): Promise<void>;
  subscribe(
    queueName: string,
    handler: (msg: QueueMessage) => Promise<void>
  ): Promise<void>;
  ack(messageId: string): Promise<void>;
  nack(messageId: string, retryDelayMs?: number): Promise<void>;
}
```

### FR-042 — Transport Lifecycle Isolation

The core engine must not dictate:

- worker concurrency model;
- queue polling frequency;
- queue batching;
- ACK strategy;
- DLQ policy;
- visibility timeout policy.

These belong to transport adapters and their integration contracts.

---

## 5.8 Storage Adapter Architecture

### FR-043 — Storage Interface

The core shall depend on a narrow adapter contract.

Reference operations:

```ts
interface StorageAdapter {
  claimStep(
    workflowId: string,
    stepKey: string,
    ttlMs: number
  ): Promise<{
    claimed: boolean;
    cachedResult?: any;
    attempt: number;
  }>;

  commitStep(
    workflowId: string,
    stepKey: string,
    result: any
  ): Promise<void>;

  failStep(
    workflowId: string,
    stepKey: string,
    error: Error,
    retryAt?: Date
  ): Promise<void>;

  scheduleTimer(
    workflowId: string,
    stepKey: string,
    runAt: Date,
    payload?: any
  ): Promise<void>;

  logEvent(
    workflowId: string,
    event: string,
    details: Record<string, any>
  ): Promise<void>;
}
```

### FR-044 — MySQL Default

The default production reference implementation shall target MySQL/InnoDB.

### FR-045 — PostgreSQL Adapter

A PostgreSQL adapter should provide equivalent durable execution semantics while taking advantage of PostgreSQL atomic locking/notification capabilities where appropriate.

### FR-046 — Redis Adapter

A Redis adapter should use atomic scripting for step claim/check-and-set operations and an ordered set for timer scheduling.

### FR-047 — Capability Consistency

All supported adapters shall document any semantic differences in:

- locking;
- consistency;
- expiration;
- scheduling;
- serialization limits;
- transaction support.

The core public API should remain stable where semantics can be preserved.

---

## 6. Persistence Model

The baseline relational model consists of workflow executions, step journal state, schedules, and immutable audit events.

### 6.1 Workflow Execution Record

Conceptual fields:

| Field | Purpose |
|---|---|
| workflow_id | Stable execution identifier |
| workflow_name | Workflow definition name |
| status | Current workflow lifecycle |
| input | Persisted workflow input |
| output | Persisted final output |
| error | Terminal/relevant failure information |
| created_at | Creation timestamp |
| updated_at | Last state modification |

### 6.2 Step Journal

Conceptual fields:

| Field | Purpose |
|---|---|
| workflow_id | Owning workflow |
| step_key | Stable durable step key |
| status | Step lifecycle |
| attempts | Number of attempts |
| max_attempts | Retry budget |
| output | Memoized successful/fallback result |
| last_error | Most recent failure |
| locked_until | Step lease expiration |
| created_at | Creation timestamp |
| updated_at | Last state modification |

Recommended states include:

- `PENDING`
- `RUNNING`
- `COMPLETED`
- `FAILED`
- `FAILED_OPTIONAL`
- `DEFERRED`

### 6.3 Schedule Record

Conceptual fields:

| Field | Purpose |
|---|---|
| schedule_id | Timer identifier |
| workflow_id | Target workflow |
| step_key | Optional target step/task |
| run_at | Due timestamp |
| status | Scheduler state |
| payload | Resume/dispatch payload |
| created_at | Creation timestamp |

Recommended statuses include:

- `PENDING`
- `PROCESSED`
- `CANCELLED`

### 6.4 Audit Record

Conceptual fields:

| Field | Purpose |
|---|---|
| id | Monotonic/unique event identifier |
| workflow_id | Workflow scope |
| step_key | Optional step scope |
| event_type | Lifecycle event type |
| details | Structured event payload |
| created_at | Event timestamp |

The audit ledger should be immutable from the application's logical perspective.

---

## 7. Step Execution State Machine

The implementation should maintain a clear and testable state model.

### 7.1 Normal Lifecycle

```text
PENDING
   |
   v
RUNNING
   |
   +----> COMPLETED
   |
   +----> FAILED ----retry----> PENDING/RUNNABLE
                         |
                         +----terminal----> FAILED

Optional terminal outcome:
FAILED_OPTIONAL

Deferred:
DEFERRED --> independently RUNNING --> COMPLETED/FAILED
```

### 7.2 Check-Execute-Commit Semantics

The standard step execution sequence shall be:

1. Check whether the step already has a committed result.
2. If completed, return the cached output.
3. Otherwise atomically claim/lease the step.
4. Execute the middleware pipeline and function.
5. On success, atomically persist completion and result.
6. On failure, persist failure information and either schedule retry or transition to terminal failure.
7. Record relevant audit events throughout the lifecycle.

### 7.3 Lease Recovery

A worker holding a lease may disappear.

After the lease expires:

- another worker may claim the step;
- the new worker increments/uses the appropriate attempt number;
- the old worker must not be able to commit stale work over a newer successful execution.

Implementations should therefore consider fencing/version checks where needed to protect against stale workers.

---

## 8. Middleware and Plugin System

### 8.1 Middleware Contract

The core shall support middleware wrapping step execution.

Reference form:

```ts
type StepMiddleware = (
  ctx: StepContext,
  next: () => Promise<any>
) => Promise<any>;
```

### 8.2 Step Context

The middleware context should expose at least:

```ts
interface StepContext {
  workflowId: string;
  stepKey: string;
  attempt: number;
}
```

### 8.3 Middleware Order

The engine shall support:

- global middleware;
- per-step middleware.

A predictable composition order must be documented.

### 8.4 Built-In/First-Party Middleware Packages

The following first-party packages are expected:

- `@outpost/plugin-resilience`
- `@outpost/plugin-alerts`
- `@outpost/plugin-chaos`

Future packages may add:

- metrics;
- tracing;
- structured logging;
- policy controls;
- rate limiting.

### 8.5 Core Independence

The core package must not directly depend on:

- AWS SDKs;
- Slack SDKs;
- PagerDuty SDKs;
- vendor-specific APM clients;
- circuit breaker libraries.

These belong in integration/plugin packages.

---

## 9. Observability and Audit Requirements

### OBS-001 — Immutable Audit Events

The system shall provide durable audit logging for important execution transitions.

Events should include, as appropriate:

- `STEP_STARTED`
- `STEP_COMPLETED`
- `STEP_FAILED`
- `STEP_RETRY_SCHEDULED`
- `STEP_OPTIONAL_FAILED`
- `TASK_DEFERRED`
- `CIRCUIT_OPEN`
- `ALERT_SENT`
- workflow lifecycle events.

### OBS-002 — Structured Details

Audit event details shall be structured data suitable for filtering and analysis.

### OBS-003 — Failure Alerts

The alerting plugin shall support hooks for events such as:

- circuit breaker activation;
- retries exhausted;
- fatal workflow failures.

### OBS-004 — Vendor-Neutral Alert Contract

The core shall expose a hook/event contract rather than directly implementing Slack, PagerDuty, webhook, or APM integrations.

### OBS-005 — No Required APM

Users must be able to use the durable execution library without adopting a particular observability vendor.

---

## 10. Fault Injection and Chaos Testing

A dedicated testing plugin is required because durable execution correctness depends heavily on crash and concurrency behavior.

### CHAOS-001 — Dedicated Package

Fault injection shall live in:

```text
@outpost/plugin-chaos
```

or an equivalent testing-only package.

### CHAOS-002 — Pre-Execution Failure

The plugin shall be able to fail a step before the user function executes.

### CHAOS-003 — Transient Failure

The plugin shall be able to fail selected attempts and then allow later attempts to succeed.

Example rule:

```text
attempts: [1, 2]
=> fail attempts 1 and 2; execute normally on attempt 3
```

### CHAOS-004 — Hard Process Crash

The plugin shall support process-abort simulation to test recovery across actual process lifecycles.

### CHAOS-005 — Post-Execution Crash

The plugin shall support simulation of the critical dual-write window in which:

1. business logic completes;
2. process fails;
3. durable step result has not yet been committed.

### CHAOS-006 — Lease Expiration

The plugin shall support injecting a delay long enough to expire the step lease.

### CHAOS-007 — Rule Matching

Chaos rules shall be selectable by:

- exact step key; or
- regular expression.

They may also be restricted to selected attempts.

### CHAOS-008 — Test Isolation

Chaos functionality shall not be required by production deployments of the core library.

### CHAOS-009 — Integration Tests

The test suite shall verify that workflows recover correctly after:

- transient step failures;
- process crashes;
- post-execution commit-window failures;
- expired leases;
- retries;
- deferred work failures.

---

## 11. Developer Experience Requirements

### DX-001 — Minimal Setup

A developer should be able to construct the engine with:

- a storage adapter;
- optional middleware;
- optional transport/integration packages.

### DX-002 — Familiar Async API

Workflow definitions and step functions should use normal language-level asynchronous functions/promises.

### DX-003 — Explicit Step API

The expected primary API includes:

```ts
ctx.step(stepKey, fn, options)
```

### DX-004 — Durable Sleep API

The expected primary API includes:

```ts
ctx.sleep(timerKey, duration)
```

### DX-005 — Deferred Work API

The expected API includes:

```ts
ctx.defer(taskKey, fn, options)
```

### DX-006 — Typed Configuration

Public configuration interfaces should expose:

- retry settings;
- backoff settings;
- optional/fallback behavior;
- circuit breaker selection;
- lease duration;
- middleware.

### DX-007 — Stable Package Boundaries

Package boundaries should be visible to developers and independently installable.

---

## 12. Reference End-User Composition

A representative application should be able to compose the library as follows:

```ts
import { WorkflowEngine } from "@outpost/core";
import { MysqlStorage } from "@outpost/storage-mysql";
import { createCircuitBreaker } from "@outpost/plugin-resilience";
import { SqsWorkflowConsumer } from "@outpost/transport-sqs";

const storage = new MysqlStorage({
  connectionString: process.env.DATABASE_URL
});

const stripeBreaker = createCircuitBreaker({
  threshold: 5,
  resetTimeoutMs: 30_000
});

const engine = new WorkflowEngine(storage);

await engine.step(
  "order-123",
  "charge-card",
  async () => {
    return await stripe.charges.create(/* ... */);
  },
  [stripeBreaker]
);
```

A full workflow example should support the following conceptual pattern:

```ts
const orderWorkflow = engine.defineWorkflow(
  "process-order",
  async (ctx, input) => {
    const payment = await ctx.step(
      "charge-card",
      async () => paymentGateway.charge(input.userId, input.amount),
      {
        maxAttempts: 4,
        backoff: {
          baseMs: 1000,
          maxMs: 15000,
          factor: 2
        }
      }
    );

    await ctx.sleep("cooling-period", "2 hours");

    const fulfillment = await ctx.step(
      "fulfill-order",
      async () => warehouse.dispatch(input.orderId),
      { maxAttempts: 3 }
    );

    return {
      paymentId: payment.id,
      trackingNumber: fulfillment.tracking
    };
  }
);
```

---

## 13. Non-Functional Requirements

### NFR-001 — Reliability

The library shall prioritize correct recovery semantics over minimizing storage operations.

### NFR-002 — Concurrency Safety

All supported storage implementations shall protect against ordinary duplicate claims under concurrent workers.

### NFR-003 — Operational Simplicity

The core deployment model shall remain embedded in the host application.

### NFR-004 — Low Overhead

The design target discussed in the conversation is single-digit-millisecond step overhead for normal database-backed operations, subject to deployment, database latency, serialization cost, and transaction behavior.

This is a target rather than a guaranteed benchmark until measured.

### NFR-005 — Scalability

The initial scheduler should favor simplicity through indexed database polling.

A separate high-throughput scheduler backend, such as Redis sorted sets, may be used when timer volume justifies it.

### NFR-006 — Extensibility

Adding a storage backend, queue provider, alert sink, or resilience policy must not require changes to the core execution model.

### NFR-007 — Testability

All durable semantics must be testable through deterministic integration and chaos tests.

### NFR-008 — Serialization

The implementation shall define supported data types and serialization behavior for:

- workflow input;
- step outputs;
- errors;
- audit details;
- deferred-task payloads.

### NFR-009 — Security

The implementation should provide secure handling of persisted workflow inputs, outputs, and audit metadata, including configuration hooks for database credentials and secrets management.

Secrets should not be written to audit logs by default.

---

## 14. MySQL Reference Requirements

The MySQL implementation shall use InnoDB.

### MYSQL-001 — Workflow Table

Provide a workflow execution table containing the workflow identifier, name, status, input, output, error, and timestamps.

### MYSQL-002 — Step Journal Table

Provide a composite key on:

```text
(workflow_id, step_key)
```

and fields for status, attempts, maximum attempts, output, failure information, lease expiration, and timestamps.

### MYSQL-003 — Schedule Indexing

Provide an index optimized for:

```text
status + run_at
```

or an equivalent query pattern.

### MYSQL-004 — Audit Index

Provide an index optimized for:

```text
workflow_id + created_at
```

### MYSQL-005 — Locking

Where supported and appropriate, scheduler and claim operations should use row-level locking and `SKIP LOCKED`.

### MYSQL-006 — Transaction Boundaries

Operations that establish durable execution state should use transactions to maintain atomicity between state transitions and associated records where required.

### MYSQL-007 — Stale Worker Protection

The adapter should prevent an expired/stale lease holder from overwriting a newer owner's result.

---

## 15. Redis Reference Requirements

The Redis implementation shall preserve the same logical semantics as the relational adapters.

### REDIS-001 — Atomic Claim

Use Lua scripting or equivalent atomic server-side operations for:

- checking existing result;
- validating ownership;
- claiming/reclaiming a step;
- updating attempt/lease state.

### REDIS-002 — Timer Scheduling

Use a sorted set with due time as the score.

### REDIS-003 — Lease Semantics

Store step ownership and expiration information in a way that prevents an expired worker from safely committing after ownership has changed.

### REDIS-004 — Semantic Documentation

Document Redis-specific tradeoffs around:

- memory use;
- persistence mode;
- replication;
- failover;
- atomicity scope;
- operational durability.

---

## 16. Scheduler Requirements

### SCH-001 — Embedded Ticker

The scheduler may operate as a lightweight background ticker inside each process.

### SCH-002 — Configurable Poll Interval

The polling interval should be configurable.

### SCH-003 — Batch Dispatch

Due timers should be processed in batches.

### SCH-004 — Multi-Instance Coordination

The scheduler must coordinate across multiple application instances.

### SCH-005 — Dispatch Safety

A timer shall not be marked processed before the system has durably established its dispatch outcome according to the adapter contract.

### SCH-006 — Recovery of Stuck Dispatches

The design should support recovery if a scheduler worker dies during dispatch.

### SCH-007 — Scale Threshold

Documentation shall explain that database polling is optimized for moderate workloads and may become a bottleneck at very large timer counts.

---

## 17. Queue Requirements

### QUEUE-001 — SQS Long Polling

The SQS adapter should use long polling to reduce unnecessary empty receives.

### QUEUE-002 — Successful Completion ACK

The queue message should be acknowledged/deleted after the workflow/handler has completed according to the selected integration semantics.

### QUEUE-003 — Failure Handling

On handler failure, queue redelivery/DLQ policy should remain configurable by the SQS deployment rather than being hidden inside the durable core.

### QUEUE-004 — FIFO Support

When FIFO is used, message deduplication and grouping should use appropriate workflow/task identifiers.

### QUEUE-005 — Transport-Neutral Core

No SQS type or SDK dependency shall leak into the core package public API.

---

## 18. Alerting Requirements

### ALERT-001 — Hook-Based Alerts

The alert package shall allow callbacks/handlers for important execution incidents.

### ALERT-002 — Standard Events

Alert sources should include:

- terminal workflow failure;
- exhausted step retries;
- circuit breaker opening;
- optionally, repeated scheduler/transport failures.

### ALERT-003 — Extensible Destinations

Destinations should be implementable for:

- webhooks;
- Slack;
- PagerDuty;
- custom internal alert services.

### ALERT-004 — Failure Isolation

Failure to send an alert must not corrupt the durable state machine.

---

## 19. Error Handling Requirements

### ERR-001 — Structured Step Errors

Step failures shall preserve at least:

- error message;
- attempt number;
- timestamp;
- step identity;
- workflow identity.

### ERR-002 — Retry Classification

The API should allow future or plugin-provided classification of:

- retryable errors;
- non-retryable/fatal errors.

### ERR-003 — Optional Error Semantics

Optional terminal errors shall be observable and auditable even though they do not abort the workflow.

### ERR-004 — Circuit-Open Errors

An open circuit shall produce a distinct error condition that can be recognized by middleware and application code.

### ERR-005 — Deferred Failures

Deferred task failures shall be independently observable from the parent workflow.

---

## 20. Security and Data Handling

### SEC-001 — Least-Privilege Storage

Adapters shall document the minimum database/Redis permissions required.

### SEC-002 — Credential Handling

Connection strings and provider credentials shall be supplied through standard configuration mechanisms.

### SEC-003 — Sensitive Data

The engine should not automatically copy sensitive external API responses into audit logs.

### SEC-004 — Audit Redaction

Provide a mechanism to redact or transform audit details before persistence.

### SEC-005 — Tenant/Application Isolation

Where the library is used in multi-tenant applications, workflow identifiers and persisted records must support appropriate application-level isolation.

---

## 21. Testing and Acceptance Criteria

### AC-001 — Basic Durable Step

**Given** a pending step,  
**when** it executes successfully,  
**then** the step is committed as completed and its result is persisted.

### AC-002 — Memoized Completion

**Given** a completed step with stored output,  
**when** the step is requested again,  
**then** the function is not executed and the stored output is returned.

### AC-003 — Concurrent Claim

**Given** two workers attempt the same pending step,  
**when** they claim it concurrently,  
**then** only one obtains the valid lease.

### AC-004 — Process Crash Before Completion

**Given** a worker crashes during a running step,  
**when** the lease expires and another worker retries,  
**then** the workflow can continue from the persisted checkpoint.

### AC-005 — Retry

**Given** a step fails transiently and has remaining attempts,  
**then** its next execution is scheduled using the configured retry policy.

### AC-006 — Retry Exhaustion

**Given** a mandatory step reaches its maximum attempts,  
**then** it becomes terminally failed and the workflow observes the failure.

### AC-007 — Optional Failure

**Given** an optional step exhausts retries,  
**then** the workflow continues with its fallback value and the step is auditable as `FAILED_OPTIONAL`.

### AC-008 — Deferred Task

**Given** a deferred task,  
**when** it is created,  
**then** the main workflow can continue without waiting for the task to finish.

### AC-009 — Durable Sleep

**Given** a workflow enters a durable wait,  
**when** the process terminates before the due time,  
**then** a later process can resume the workflow after the timer becomes due.

### AC-010 — Circuit Open

**Given** a circuit breaker is open,  
**when** a protected step executes,  
**then** the downstream function is not called until the breaker permits a probe.

### AC-011 — Post-Execution Crash

**Given** the step's business function succeeds but the process fails before durable commit,  
**when** the step is recovered,  
**then** the system must exhibit documented behavior for the possible duplicate external side effect and must not falsely claim exactly-once external execution.

### AC-012 — Lease Expiration

**Given** a step exceeds its lease,  
**when** another worker takes over,  
**then** stale ownership must not overwrite the new owner's durable completion.

### AC-013 — Audit

**Given** any material state transition,  
**then** an appropriate structured audit event is persisted.

### AC-014 — Storage Portability

**Given** equivalent supported storage adapters,  
**then** workflow definitions can run without storage-specific workflow code.

### AC-015 — Transport Portability

**Given** a workflow triggered through a supported transport,  
**then** the workflow engine remains independent from transport-specific APIs.

### AC-016 — Ambiguous-State Probe Resolves to Completed

**Given** a step whose prior attempt failed with a network timeout or 5xx and is recorded as `AMBIGUOUS`, and a `probe()` that returns data,  
**when** the step is recovered,  
**then** the engine marks the step `COMPLETED` using the probe result and does not call `execute()`.

### AC-017 — Ambiguous-State Probe Resolves to Re-Execute

**Given** an `AMBIGUOUS` step and a `probe()` that returns `null`,  
**when** the step is recovered,  
**then** the engine calls `execute()` normally.

### AC-018 — Authoring Parity

**Given** the same workflow expressed via the functional, class/decorator, and builder APIs,  
**then** each produces identical durability, retry, lease, memoization, and audit behavior.

### AC-019 — Custom Identifier Override

**Given** a workflow or step with a custom identifier supplied through its decorator,  
**then** persisted history is keyed by the custom identifier rather than the function/method name.

### AC-020 — Multi-Process Coordination

**Given** multiple worker processes sharing one storage backend,  
**when** they contend for the same runnable step,  
**then** at most one obtains a valid exclusive claim under the adapter's documented atomic semantics.

### AC-021 — Pluggable Encoding Round-Trip

**Given** a value persisted under one configured encoder,  
**when** the default encoder is later changed,  
**then** the previously persisted value can still be decoded via its recorded encoding tag.

---

## 22. Failure Scenario Matrix

| Scenario | Required Outcome |
|---|---|
| Worker dies before step function starts | Another worker can claim and execute the step |
| Worker dies during step execution | Lease eventually expires and another worker may retry |
| Step returns successfully and commit succeeds | Cached result prevents duplicate execution |
| Step fails before max attempts | Retry is scheduled |
| Step reaches max attempts | Mandatory step fails terminally |
| Optional step reaches max attempts | Fallback returned; workflow continues |
| Process dies during durable sleep | Timer remains durable and can wake workflow later |
| Queue message is redelivered | Workflow/step idempotency prevents logical duplication |
| Circuit is open | Protected call fails fast |
| Deferred API unavailable | Deferred task retries independently |
| Scheduler process dies | Due schedule remains recoverable |
| Two schedulers race | Locking prevents duplicate dispatch under supported backend semantics |
| Lease expires while stale worker resumes | Stale worker must not overwrite a newer lease owner |
| Post-execution crash before commit | External side effect may repeat; behavior must be documented and testable |
| Attempt fails with timeout/5xx (ambiguous) | Step recorded `AMBIGUOUS`; probe-first recovery resolves via `probe()` or re-executes |
| Ambiguous step recovered with probe returning data | Step marked `COMPLETED` from probe result; `execute()` skipped |
| Ambiguous step recovered with probe returning null | Step proceeds to `execute()` normally |

---

## 23. Package Requirements

### `@outpost/core`

Must contain:

- workflow/step execution;
- step state handling;
- middleware pipeline;
- storage interfaces;
- workflow context;
- durable timer abstraction;
- core lifecycle hooks.

Must not require a specific queue, cloud provider, alerting vendor, or database vendor.

### `@outpost/storage-mysql`

Must contain:

- MySQL schema/migrations;
- transactional step claiming;
- step commits/failures;
- timer storage and polling;
- audit persistence.

### `@outpost/storage-postgres`

Must contain:

- PostgreSQL equivalent of the storage contract;
- appropriate transaction/locking behavior;
- optional notification optimization.

### `@outpost/storage-redis`

Must contain:

- atomic claim/release/commit operations;
- timer scheduling through sorted sets;
- required serialization and durability configuration guidance.

### `@outpost/transport-sqs`

Must contain:

- SQS consumer;
- publisher integration as required;
- visibility/ACK integration;
- FIFO support;
- transport-specific configuration.

### `@outpost/plugin-resilience`

Must contain:

- retry/backoff helpers;
- circuit breaker middleware;
- configurable policies.

### `@outpost/plugin-alerts`

Must contain:

- alert event hooks;
- extensible destination adapters;
- failure-safe dispatch behavior.

### `@outpost/plugin-chaos`

Must contain:

- deterministic failure injection;
- crash simulation;
- delayed execution;
- post-execution commit-window simulation;
- lease-expiration simulation.

---

## 24. Documentation Requirements

The project documentation shall clearly explain:

1. What durable execution means in this library.
2. What guarantees are provided by step memoization.
3. What is and is not guaranteed for external side effects.
4. Why durable steps must be explicit.
5. How storage adapters differ.
6. How leases work.
7. How retries interact with durable state.
8. How circuit breakers differ from durable retry logic.
9. How optional and deferred steps behave.
10. How to run the scheduler.
11. How to run multiple application instances safely.
12. How SQS integration works.
13. How to perform crash/fault-injection testing.
14. When the library is preferable to a task queue.
15. When a heavier workflow orchestrator is more appropriate.
16. Scheduler scaling limitations.
17. Redis durability and operational tradeoffs.
18. Migration/versioning implications of changing step keys or workflow logic.

---

## 25. Compatibility and Evolution Requirements

### COMP-001 — Step Key Stability

Changing a step key is a semantic migration because persisted history is keyed by the old value.

Documentation and tooling should warn developers about this.

### COMP-002 — Workflow Code Changes

The engine shall document how changing workflow code affects already-running workflows.

The initial product should not claim replay compatibility equivalent to deterministic event-sourcing engines.

### COMP-003 — Schema Migrations

Storage packages shall provide versioned migrations.

### COMP-004 — Adapter Contract Stability

Storage adapters should implement versioned or semver-compatible contracts to prevent accidental semantic drift.

---

## 26. Performance and Scalability Expectations

### PERF-001 — Normal Step Overhead

Target low single-digit-millisecond framework/storage overhead under favorable local database conditions.

This requires benchmark validation before being presented as a guaranteed SLA.

### PERF-002 — Batch Scheduler Processing

The scheduler should support bounded batch sizes to avoid unbounded work in a single polling cycle.

### PERF-003 — Indexed Queries

All high-frequency scheduler and step lookup paths must be index-backed.

### PERF-004 — Large Payloads

The system should avoid unnecessarily large row/document payloads.

A future payload-store abstraction may be added without changing the step state model.

### PERF-005 — Timer Volume

Documentation must state that database polling is intended for moderate timer workloads.

For larger workloads, Redis/ZSET or a future specialized scheduler may be used.

---

## 27. Product Positioning Requirements

The library is intended to provide a middle ground:

```text
Low complexity                               High complexity
----------------------------------------------------------------
Task queues                                  Dedicated workflow
(BullMQ/Celery/etc.)                         orchestrators
                                             (Temporal/etc.)

                    Embeddable Durable Steps
```

The library should be positioned around:

- no dedicated orchestrator;
- durable step state;
- SQL/Redis-backed coordination;
- explicit step APIs;
- modular queue and resilience integrations;
- simpler operational model.

It should not attempt to reproduce every capability of large workflow platforms.

---

## 28. Key Architectural Risks

### RISK-001 — Exactly-Once Misinterpretation

Users may infer exactly-once external side effects from durable step memoization.

**Mitigation:** document the crash window clearly and encourage downstream idempotency keys.

### RISK-002 — Distributed Circuit Breaker Expectations

Process-local circuit state may be mistaken for fleet-wide dependency health.

**Mitigation:** document scope and provide a future shared-state option only as a separate module.

### RISK-003 — Scheduler Scaling

Polling a database can become expensive at very high timer volumes.

**Mitigation:** batch processing, indexing, configurable intervals, and optional Redis scheduler support.

### RISK-004 — Stale Worker Commit

A worker can wake after losing a lease.

**Mitigation:** generation/version/fencing checks in storage commit operations.

### RISK-005 — Storage Semantic Leakage

Different databases can have materially different guarantees.

**Mitigation:** define minimum adapter capabilities and require adapters to document semantic deviations.

### RISK-006 — Core Scope Expansion

Adding every integration directly into the core can recreate the complexity the product is intended to avoid.

**Mitigation:** enforce package boundaries and keep transport, resilience, and alerting in plugins.

### RISK-007 — Workflow Code Evolution

Persisted step state may conflict with changed application logic.

**Mitigation:** stable step keys, versioning guidance, migration patterns, and explicit documentation.

---

## 29. Recommended MVP

The MVP should prioritize a small, coherent set of capabilities:

### MVP Core

- `@outpost/core`
- explicit `ctx.step(...)` (functional authoring only; class/decorator and builder deferred per ENR-000b);
- default-name and custom identifiers (ENR-005);
- workflow identifiers;
- step memoization;
- leases with stale-worker fencing;
- retries;
- durable sleep;
- ambiguous-state `probe()` recovery and resolution ladder (ENR-018–ENR-022) — the primary motivating capability;
- intent records + idempotency keys for external calls (ENR-024, ENR-021 strategy 3);
- JSON serialization (pluggable encoding deferred);
- camelCase / `outpost`-prefixed persistence (ENR-008, ENR-009);
- immutable audit events.

### MVP Storage

- MySQL/InnoDB reference adapter.

### MVP Integrations

- SQS transport;
- resilience middleware;
- alert hooks.

### MVP Testing

- deterministic chaos/fault injection;
- crash recovery integration tests;
- concurrent worker tests;
- lease expiration tests;
- optional/deferred semantics tests.

### Deferred / Not Planned

Not planned (per ENR-000a):

- PostgreSQL adapter;
- Redis adapter;
- Redis-based high-throughput scheduler.

Deferred (revisit only if a concrete need appears):

- class/decorator and builder authoring styles (ENR-000b);
- pluggable serialization encodings beyond JSON;
- additional transports;
- payload offloading;
- richer metrics/tracing integrations;
- advanced retry classification;
- workflow/version migration tooling.

---

## 30. Definition of Done

The product should be considered ready for an initial production-quality release when:

1. A workflow can survive process termination and resume from persisted step state.
2. Completed steps are memoized and not normally re-executed.
3. Concurrent workers cannot both obtain the same active step lease.
4. Expired leases can be reclaimed.
5. Stale workers cannot overwrite newer durable results.
6. Retries and exponential backoff are configurable and tested.
7. Durable sleeps survive process restarts.
8. Optional steps can fail without aborting their workflow.
9. Deferred steps execute independently of the critical workflow path.
10. SQS integration works without adding SQS dependencies to core.
11. Circuit breakers and alerts are implemented through plugins/middleware.
12. Audit events are durably recorded.
13. Chaos tests cover crash, retry, dual-write, and lease-expiration scenarios.
14. MySQL is fully supported as the reference backend.
15. Storage and transport boundaries are documented and tested.
16. The documentation clearly describes durability and exactly-once limitations.
17. Performance benchmarks are published for representative workloads.
18. Schema migrations and package versioning are operationally usable.

---

## 31. Traceability to the Conversation

The core architecture, package decomposition, MySQL-default storage decision, exclusion of S3 as a primary state store, middleware approach for resilience/alerts, SQS integration, three execution semantics, and chaos-testing requirements are all directly grounded in the supplied conversation. In particular, the source explicitly describes the embeddable/no-daemon constraint, pluggable storage, retry/idempotency, schedules, audit logs, alerts, and SQS integration. fileciteturn0file0L89-L111

The source also defines the step-journaling architecture, MySQL schema, storage operations, check-execute-commit execution cycle, retry/backoff logic, circuit breaker behavior, scheduler approach, SQS implementation shape, and the developer API. fileciteturn0file0L113-L137 fileciteturn0file0L141-L229 fileciteturn0file0L235-L304

The decision to exclude S3 from primary state, use atomic-capable stores, and keep reliability/observability concerns modular is explicitly supported by the conversation. fileciteturn0file0L563-L617

The package boundaries and middleware architecture are explicitly established in the conversation, including core, storage, transport, resilience, alerts, and chaos packages. fileciteturn0file0L765-L809

Finally, the source explicitly introduces the mandatory/optional/deferred semantics and the final baseline requirements for durable execution, storage, resilience, scheduling, queues, and observability. fileciteturn0file0L1076-L1128 fileciteturn0file0L1224-L1282

---

## 32. Summary of Hard Decisions

| Decision | Requirement |
|---|---|
| Deployment model | Embedded library; no external orchestrator required |
| Primary coordination storage | Atomic-capable database/cache only |
| Default storage | MySQL/InnoDB |
| S3 | Not a primary state store |
| Durable mechanism | Explicit step journaling/memoization |
| Step identity | `(workflow_id, step_key)` |
| Locking | Atomic claim + lease |
| Recovery | Reclaim after lease expiration |
| Retry | Configurable exponential backoff + jitter |
| Circuit breaker | Middleware/plugin |
| Alerts | Hook/plugin |
| Scheduler | Embedded database polling initially |
| High-scale timers | Optional Redis ZSET backend |
| Queue | SQS first-party adapter |
| Transport coupling | Kept outside core |
| Execution modes | Mandatory, optional, deferred |
| Audit | Immutable structured event log |
| Chaos testing | Dedicated plugin |
| Non-deterministic code | Must use explicit durable steps; no full replay guarantee |
| Exactly-once side effects | Not guaranteed for arbitrary external systems |


---

## 33. Enrichment Decisions

This section consolidates decisions and refinements added after the initial specification. Where a requirement here conflicts with an earlier illustrative example, this section is authoritative.

### 33.0 Scope Decision — MySQL-Only, Minimal Surface (Authoritative)

The initial build is deliberately scoped to a single MySQL shop's needs. The following overrides earlier multi-store and multi-authoring ambitions:

#### ENR-000a — Single Storage Backend

THE only supported storage backend SHALL be MySQL/InnoDB. The PostgreSQL adapter (FR-045, `@outpost/storage-postgres`), the Redis adapter (FR-033, FR-046, `@outpost/storage-redis`), and Redis-based timer scheduling are **not planned**. The storage-adapter abstraction (FR-043) MAY be retained as an internal seam for testability, but multi-store portability is not a goal and SHALL NOT drive design tradeoffs.

#### ENR-000b — Single Authoring Style

THE supported authoring style SHALL be the functional form (`defineWorkflow` + `ctx.step`). The class/decorator model (ENR-002–ENR-005) and the builder API (ENR-006–ENR-007) are **deferred** and out of scope for the initial build. The API-parity requirement (ENR-007) does not apply while only one style exists.

#### ENR-000c — Corner-Cutting Is Acceptable Except on Correctness

Simplifications that reduce surface area are acceptable. The one area where corners SHALL NOT be cut is durable-execution correctness: leasing, stale-worker fencing, the commit window, and ambiguous-state resolution (Section 33.7). These are the entire reason the library exists.

#### ENR-000d — Motivating Use Case

The concrete driver is a Shopify order-create flow that intermittently returns a 5xx while still creating the order, causing message-queue redelivery and duplicate orders. The ambiguous-state handling in Section 33.7 SHALL be sufficient to resolve this case using a client-controlled correlation attribute plus a probe query.

### 33.1 Storage Scope — S3 Permanently Excluded

#### ENR-001 — Permanent S3 Exclusion

Object storage (S3 or equivalent) shall **never** be supported as a primary workflow-state or coordination store, in any release. This supersedes any language suggesting S3 exclusion is merely an "initial architecture" limitation.

WHERE large-payload offloading is later introduced, THE object store SHALL be used only for opaque payload bytes and SHALL NOT participate in step claiming, leasing, timer scheduling, or any atomic coordination path.

### 33.2 Workflow Authoring — Class + Decorator Model

#### ENR-002 — Class-Based Workflow Definition

THE library SHALL allow workflows to be defined as classes annotated with decorators, in addition to the functional `defineWorkflow` form.

Illustrative API:

```ts
@Workflow()
class ProcessOrder {
  @Step({ maxAttempts: 4 })
  async chargeCard(ctx: StepContext, input: OrderInput) { /* ... */ }

  @Step({ maxAttempts: 3 })
  async fulfillOrder(ctx: StepContext, input: OrderInput) { /* ... */ }

  // steps arranged in a lifecycle function (see ENR-004)
  async run(ctx: WorkflowContext, input: OrderInput) {
    const payment = await this.chargeCard(ctx, input);
    await ctx.sleep("coolingPeriod", "2 hours");
    return await this.fulfillOrder(ctx, input);
  }
}
```

#### ENR-003 — Step Methods via Decorators

WHERE a method is annotated with a step decorator, THE library SHALL treat that method as a durable step, applying memoization, claiming, leasing, retry, and audit semantics identical to `ctx.step(...)`.

#### ENR-004 — Lifecycle Orchestration Function

THE class-based workflow SHALL expose a designated lifecycle function (e.g. `run`) that arranges the ordering and control flow of its decorated steps. Durability applies at decorated-step boundaries, consistent with AR-005; the lifecycle function itself is ordinary control flow and is not replayed deterministically.

#### ENR-005 — Default and Custom Identifiers

By default, THE identifier of a workflow or step SHALL be derived from the function/method name (the class name for a workflow, the method name for a step).

WHERE a custom identifier is supplied through the decorator (e.g. `@Step({ id: "charge-card" })` or `@Workflow({ id: "process-order" })`), THE library SHALL use the supplied identifier instead of the derived name.

Because persisted history is keyed by identifier, changing a derived identifier by renaming a function/method is a semantic migration (see COMP-001). THE documentation SHALL recommend explicit custom identifiers for long-lived workflows to decouple persisted identity from code symbols.

### 33.3 Builder API Support

#### ENR-006 — Builder Framework Alongside Classes

THE library SHALL provide a fluent builder API in addition to the class/decorator and functional forms, so workflows can be assembled programmatically without decorators.

Illustrative API:

```ts
const processOrder = engine.workflow("process-order")
  .step("charge-card", chargeCardFn, { maxAttempts: 4 })
  .sleep("cooling-period", "2 hours")
  .step("fulfill-order", fulfillOrderFn, { maxAttempts: 3 })
  .build();
```

#### ENR-007 — API Parity

All three authoring styles (functional, class/decorator, builder) SHALL compile to the same internal workflow/step representation and SHALL provide identical durability, retry, lease, memoization, and audit semantics. No authoring style shall expose capabilities unavailable to the others.

### 33.4 Naming Convention — camelCase with `outpost` Prefix

#### ENR-008 — Column Naming

All persisted column/field names across every first-party storage adapter SHALL use camelCase (e.g. `workflowId`, `stepKey`, `maxAttempts`, `lockedUntil`, `nextAttemptAt`, `createdAt`, `updatedAt`).

#### ENR-009 — Table Naming

All table/collection/keyspace names SHALL use camelCase and SHALL carry an `outpost` prefix (e.g. `outpostWorkflows`, `outpostSteps`, `outpostSchedules`, `outpostAuditEvents`).

#### ENR-010 — Identity Pair Restatement

The step identity pair from earlier sections is restated in camelCase as `(workflowId, stepKey)`. All snake_case field names appearing in Sections 6, 14, and 32 (e.g. `workflow_id`, `step_key`, `run_at`, `created_at`) are illustrative only and SHALL be implemented in camelCase per ENR-008.

### 33.5 Interprocess Synchronization via the Database

#### ENR-011 — Database-Backed Interprocess Coordination

THE library SHALL support running multiple worker processes concurrently against a shared storage backend, using the database (or Redis) as the sole coordination point. No separate coordination service shall be required.

#### ENR-012 — Mutual Exclusion Guarantees

WHEN multiple worker processes contend for the same runnable step or due timer, THE storage adapter SHALL guarantee that at most one worker obtains a valid exclusive claim/lease under the adapter's documented atomic semantics (consistent with FR-011, SCH-004, and AC-003), using primitives such as `FOR UPDATE SKIP LOCKED` (SQL) or atomic Lua scripts (Redis).

#### ENR-013 — No Shared In-Memory State

THE engine SHALL NOT rely on shared in-memory state between worker processes for correctness. All cross-process synchronization SHALL flow through the persisted coordination primitives.

### 33.6 Serialization and Encoding

#### ENR-014 — Serializable Workflow I/O

Workflow input, workflow output, step outputs, deferred-task payloads, timer payloads, and audit details SHALL be serializable. THE library SHALL document the supported value types and reject or clearly error on non-serializable values (consistent with NFR-008).

#### ENR-015 — Pluggable Encoding

THE library SHALL support pluggable encoders/decoders so persisted values can use different serialization formats. JSON SHALL be the default encoding. Additional encodings (e.g. MessagePack, CBOR, or a user-provided codec) SHALL be selectable through configuration.

#### ENR-016 — Encoding Metadata and Compatibility

Persisted records SHALL record enough information (e.g. an encoding tag/version) to decode a value written by a previously configured encoder, so that changing the configured default encoder does not render already-persisted history undecodable.

#### ENR-017 — Encoding and Redaction Interaction

THE encoding layer SHALL compose with audit redaction (SEC-004) such that redaction is applied before encoding for persistence, and secrets are never encoded into audit records by default.

### 33.7 Ambiguous-State Handling via `probe()`

#### ENR-018 — AMBIGUOUS Step Status

THE step state model SHALL include an `AMBIGUOUS` status, recorded WHEN a step attempt fails in a way that leaves the external outcome unknown — specifically a network timeout or a 5xx-class response from the downstream dependency — such that the engine cannot determine whether the side effect actually occurred.

#### ENR-019 — Probe Function Registration

A step MAY declare an idempotent `probe()` function that inspects the downstream system to determine whether the step's effect already took place (e.g. by looking up an idempotency key or resource identifier).

#### ENR-020 — Probe-First Recovery

WHEN a step is being recovered and its prior attempt left it in `AMBIGUOUS` status, IF a `probe()` function is declared, THEN the engine SHALL call `probe()` before calling `execute()`:

- IF `probe()` returns data, THEN the engine SHALL mark the step `COMPLETED`, store the returned value as the step output, and SHALL NOT call `execute()`.
- IF `probe()` returns `null`, THEN the engine SHALL proceed to call `execute()` normally.

#### ENR-021 — Ambiguity Resolution Strategy Ladder

WHEN a step is in `AMBIGUOUS` status, THE engine SHALL resolve it using the strongest available strategy from the following ladder, and SHALL NEVER auto-succeed or blindly auto-retry an ambiguous step:

1. **Native idempotency key.** WHERE the downstream API dedupes on a client-supplied idempotency key (e.g. an `Idempotency-Key` header), THE step SHALL replay with the same key and rely on the downstream to return the original result. A `probe()` is not required in this case.

2. **Correlation attribute + probe query.** WHERE the downstream does not dedupe but allows a client-supplied attribute to be stamped on the resource and queried later (e.g. Shopify order `note_attributes`, `source_identifier`, or a cart token), THE step SHALL stamp a caller-generated correlation value and `probe()` SHALL query the downstream by that value. This is the primary strategy for the Shopify motivating case (ENR-000d).

3. **Intent record (local reservation).** Before the external call, THE engine SHOULD persist an intent record in MySQL keyed by the correlation value with status `PENDING`, updated to `DONE` (with the downstream resource id) on success. The intent record provides a stable local key that survives an ambiguous failure and anchors the probe query in strategy 2.

4. **Heuristic natural-key match.** WHERE no stamped attribute is available, `probe()` MAY match on natural attributes within a bounded time window. Because this can false-positive/false-negative, its result SHALL be treated as a review signal and SHALL NOT, by itself, authorize an automatic skip of `execute()`.

5. **Manual review / dead-letter.** WHEN no strategy can decide, THE step SHALL transition to a review/dead-letter state (see ENR-025), stop automatic retries, and emit an alert. Parking for human review is the required behavior; guessing is prohibited.

WHEN a step is `AMBIGUOUS` and no `probe()` function is declared, THE engine SHALL apply strategy 5 (park and alert) rather than retrying blindly, consistent with the documented exactly-once limitations (FR-014, AC-011).

#### ENR-022 — Probe Auditing

Probe invocations and their outcomes (`data` vs `null`) SHALL emit structured audit events (e.g. `STEP_PROBE_STARTED`, `STEP_PROBE_RESOLVED`, `STEP_PROBE_EMPTY`).

### 33.8 Circuit Breakers and Backoff Scope (Recommendation)

#### ENR-023 — Backoff in Core, Circuit Breakers as Plugin

Exponential backoff with jitter SHALL remain a core capability (per FR-016, FR-017) because retry scheduling is intrinsic to the durable state machine. Circuit breakers SHALL remain a middleware/plugin concern (per AR-006, FR-021) rather than core logic, because circuit breaking is a fail-fast dependency-health concern with a different lifecycle than durable retry/resume.

Rationale: keeping backoff in core preserves correct retry scheduling without a plugin; keeping circuit breakers in a plugin preserves core independence from vendor libraries and process-local vs. distributed-state tradeoffs (RISK-002).

### 33.9 Additional Robustness Features (Recommendations)

The following are recommended additions to strengthen the library. They are proposed as Post-MVP unless noted.

#### ENR-024 — Idempotency Keys for External Calls

THE library SHOULD provide first-class support for attaching idempotency keys to step executions, so downstream systems that honor idempotency keys can safely deduplicate retried side effects, directly mitigating the exactly-once crash window (RISK-001).

#### ENR-025 — Poison-Message / Dead-Letter Handling

THE library SHOULD provide a documented path for terminally failed workflows/steps to be routed to a dead-letter destination or held for manual intervention, rather than being lost.

#### ENR-026 — Workflow Cancellation and Termination

THE library SHOULD support explicit cancellation of a running or suspended workflow, transitioning it to a terminal `CANCELLED` state and cancelling associated pending timers and deferred tasks.

#### ENR-027 — Rate Limiting / Concurrency Caps

THE resilience plugin SHOULD offer optional per-dependency concurrency caps and rate limiting as middleware, complementing circuit breakers.

#### ENR-028 — Heartbeating for Long-Running Steps

Long-running steps SHOULD be able to heartbeat to extend their lease, preventing premature lease expiry and duplicate execution of legitimately slow work.

#### ENR-029 — Observability Metrics Hooks

THE library SHOULD expose vendor-neutral metrics hooks (step latency, retry counts, lease reclaims, circuit state changes, scheduler lag) consistent with the no-required-APM principle (OBS-005).

#### ENR-030 — Graceful Shutdown / Draining

Worker processes SHOULD support graceful shutdown that stops claiming new work while allowing in-flight leased steps to complete or cleanly release their leases for prompt reclaim.

### 33.10 New State and Event Additions

#### ENR-031 — State Model Additions

The step state model (Section 6.2 / 7.1) is extended with:

- `AMBIGUOUS` (ENR-018)

The workflow state model (FR-005) is extended with:

- `CANCELLED` (ENR-026)

#### ENR-032 — Audit Event Additions

The audit event catalogue (OBS-001) is extended with, as appropriate:

- `STEP_PROBE_STARTED`
- `STEP_PROBE_RESOLVED`
- `STEP_PROBE_EMPTY`
- `STEP_AMBIGUOUS`
- `WORKFLOW_CANCELLED`
