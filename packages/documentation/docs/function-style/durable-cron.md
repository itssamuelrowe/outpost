---
id: functional-durable-cron
title: Functional durable cron
---

# Functional durable cron

This page shows durable cron written in the [functional style](./functional-workflows.md): plain functions registered by name, no decorators. If you want the concepts behind scheduling (how firing, claiming, catch-up, jitter, and time zones work) read [Durable cron](../scheduling/durable-cron.md), [Durable cron patterns](../scheduling/durable-cron-patterns.md), and [Scheduler lifecycle](../scheduling/scheduler-lifecycle.md) first. This page is only about the authoring shape.

## One important thing up front

**Both styles share one scheduling engine.** The class style offers a `@Cron` decorator that records the schedule on the class, wired up by `registerCronWorkflows`. The functional style skips the decorator and calls the same underlying API directly: `scheduler.registerCron(...)` to register the schedule and `scheduler.onCronFire(...)` to run the workflow when it fires. The decorator is pure sugar over exactly these calls, so the two are interchangeable. The only real difference between the styles is how you define the **workflow** the schedule starts.

So "functional durable cron" really means: define the workflow with `engine.defineWorkflow`, then point a schedule at its name with `registerCron`.

## The full shape

```ts
import { Scheduler, WorkflowEngine } from "@outpost/core";

const engine = new WorkflowEngine(storage);
const scheduler = new Scheduler(storage);

// 1. Define the workflow as a plain function, registered by name.
engine.defineWorkflow("nightly-report", async (context, input) => {
    const rows = await context.step("gather", async () =>
        reportingDb.aggregateForDay(input.scheduledFor),
    );
    const pdf = await context.step("render", async () => renderer.toPdf(rows));
    await context.step("deliver", async () => mailer.send("ops@example.com", pdf), {
        maxAttempts: 5,
    });
});

// 2. Turn each fire into a run of that workflow, by name.
scheduler.onCronFire(async ({ schedule, workflowIdentifier, scheduledFor }) => {
    await engine.run(schedule.workflowName, workflowIdentifier, {
        scheduledFor: scheduledFor.toISOString(),
    });
});

// 3. Register the schedule, pointing workflowName at the function's name.
await scheduler.registerCron({
    name: "nightly-report",
    cronExpression: "0 2 * * *",
    workflowName: "nightly-report", // matches defineWorkflow's name
    timeZone: "America/New_York",
});

// 4. Start the poller.
scheduler.start(async (timer) => {
    await engine.run(/* resume the workflow this timer belongs to */);
});
```

The link between the schedule and the workflow is the **name**: `registerCron`'s `workflowName` must match the string you passed to `defineWorkflow`. The `onCronFire` handler reads `schedule.workflowName` and hands it straight to `engine.run`.

## How it lines up with the class style

For contrast, here is the class-style version of the same job. It carries the schedule on the class with `@Cron` and is wired up with one `registerCronWorkflows` call:

```ts
@Workflow({ name: "nightly-report" })
@Cron({ expression: "0 2 * * *", timeZone: "America/New_York" })
class NightlyReport {
    @Step({ maxAttempts: 5 })
    async deliver(pdf: Pdf) {
        return mailer.send("ops@example.com", pdf);
    }
    async run(ctx: WorkflowContext, input: { scheduledFor: string }) {
        /* ... */
    }
}

await registerCronWorkflows(scheduler, engine, [NightlyReport]);
```

| Concern              | Class style                                         | Functional style                                  |
| -------------------- | --------------------------------------------------- | ------------------------------------------------- |
| Define the workflow  | `@Workflow({ name: "nightly-report" })` class       | `engine.defineWorkflow("nightly-report", fn)`     |
| A durable step       | `@Step()` method                                    | `context.step("id", fn, options)`                 |
| Declare the schedule | `@Cron({ expression, timeZone })` on the class      | `scheduler.registerCron({ ... })`                 |
| Wire it up           | `registerCronWorkflows(scheduler, engine, [Class])` | `scheduler.onCronFire(...)` + `registerCron(...)` |

`registerCronWorkflows` does nothing you could not do by hand: it reads the `@Cron` metadata, calls `registerCron`, and installs an `onCronFire` handler that runs the class. The scheduling engine underneath is the same either way.

## Patterns in functional form

The [Durable cron patterns](../scheduling/durable-cron-patterns.md) page explains the _why_ for each of these. Here they are in functional form.

### Fan-out to per-entity workflows

A small dispatcher schedule that starts one child workflow per account, with a deterministic child identifier so retries and replays never double-charge.

```ts
engine.defineWorkflow("charge-account", async (context, input) => {
    await context.step("charge", async () => billing.charge(input.accountId), {
        maxAttempts: 5,
    });
});

engine.defineWorkflow("dispatch-billing", async (context, input) => {
    const accounts = await context.step("list-accounts", async () =>
        billing.accountsDueOn(input.scheduledFor),
    );

    await context.step("enqueue-each", async () => {
        for (const account of accounts) {
            // Deterministic child id: same account + same billing day => same run.
            await engine.run("charge-account", `charge-${account.id}-${input.scheduledFor}`, {
                accountId: account.id,
            });
        }
    });
});

await scheduler.registerCron({
    name: "monthly-billing",
    cronExpression: "0 0 1 * *",
    workflowName: "dispatch-billing",
    catchUp: true, // billing must not miss a month
});
```

### Overlap guard for high-frequency polling

Make the first step a lock claim that no-ops when a previous run is still in flight.

```ts
engine.defineWorkflow("sync-inventory", async (context, input) => {
    const acquired = await context.step("acquire-lock", async () =>
        locks.tryAcquire("sync-inventory"),
    );
    if (!acquired) {
        return; // a previous sync is still running; skip this occurrence
    }
    await context.step("pull-changes", async () => inventory.pull(input.scheduledFor));
    await context.step("release-lock", async () => locks.release("sync-inventory"));
});

await scheduler.registerCron({
    name: "sync-inventory",
    cronExpression: "*/5 * * * *",
    workflowName: "sync-inventory",
    // catchUp defaults to false: after an outage, run once now, not twelve stale syncs.
});
```

### Deriving the business date from the occurrence

Whatever the style, compute the period a run covers from `scheduledFor`, not from `Date.now()`, so a jittered or replayed fire still processes the right window.

```ts
engine.defineWorkflow("roll-up-metering", async (context, input) => {
    const windowStart = new Date(input.scheduledFor);
    await context.step("meter", async () => metering.rollUp(windowStart), {
        maxAttempts: 3,
    });
});

await scheduler.registerCron({
    name: "hourly-metering",
    cronExpression: "0 * * * *",
    workflowName: "roll-up-metering",
    catchUp: true,
});
```

## Managing schedules

Pause, resume, remove, list, and trigger are plain scheduler methods and, again, identical across styles:

```ts
await scheduler.pauseCron("nightly-report");
await scheduler.resumeCron("nightly-report");
await scheduler.removeCron("nightly-report");
const all = await scheduler.listCronSchedules();
const runNow = await scheduler.triggerCron("nightly-report");
```

## Related

- [Functional workflows](./functional-workflows.md): the functional authoring style in general.
- [Durable cron](../scheduling/durable-cron.md): what it is, and the `@Cron` decorator equivalent.
- [Durable cron patterns](../scheduling/durable-cron-patterns.md): the patterns above, with the reasoning behind each.
- [Scheduler lifecycle](../scheduling/scheduler-lifecycle.md): the scheduling mechanics.
