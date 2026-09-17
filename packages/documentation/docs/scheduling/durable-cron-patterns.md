---
id: durable-cron-patterns
title: Durable cron patterns
---

# Durable cron patterns

Durable cron lets a workflow run on a repeating schedule that survives restarts, crashes, and deploys. This page is about **how to use it well**: the recurring patterns that come up in real systems, and how to express each one. For what durable cron is and how to register a schedule, see [Durable cron](./durable-cron.md); for how the poller fires schedules, see [Scheduler lifecycle](./scheduler-lifecycle.md).

If you have not set one up before, the shape is always the same:

```ts
import { Scheduler, WorkflowEngine } from "@outpost/core";

const engine = new WorkflowEngine(storage);
const scheduler = new Scheduler(storage);

// Turn each fire into a durable workflow run.
scheduler.onCronFire(async ({ schedule, workflowIdentifier, scheduledFor }) => {
    await engine.run(schedule.workflowName, workflowIdentifier, {
        scheduledFor: scheduledFor.toISOString(),
        payload: schedule.payload,
    });
});

scheduler.start(async (timer) => {
    await engine.run(/* resume the workflow this timer belongs to */);
});
```

Everything below is a variation on registering the right schedule and writing the workflow it starts.

## The mental model: a schedule starts a workflow

A cron schedule does not _do_ the work. It **starts a workflow**, and the workflow does the work. That separation is the whole point: the schedule handles "when," and durable execution handles "reliably." Once a fire hands off to `engine.run`, you get memoized steps, durable sleep, retries with backoff, and audit events for free.

So the design question for every pattern is really two questions:

1. What cadence should the schedule fire on?
2. What should the workflow it starts actually do?

Keep the workflow idempotent per occurrence and you can lean on the engine for the hard parts.

The examples below use the `@Cron` decorator, which records the schedule on the class; a single `registerCronWorkflows(scheduler, engine, [...])` call at startup wires them all up. Every one has an exact [functional equivalent](../function-style/durable-cron.md) if you prefer plain functions.

## Pattern 1: the nightly batch job

The classic. Run a report, a cleanup, or a rollup once a day at a fixed local time.

```ts
@Workflow({ name: "nightly-report" })
@Cron({ expression: "0 2 * * *", timeZone: "America/New_York" }) // 2am Eastern, DST-aware
class NightlyReport {
    // Step methods take their own arguments; the decorator adds durability.
    @Step({ maxAttempts: 3 })
    async gather(scheduledFor: string) {
        return reportingDb.aggregateForDay(scheduledFor);
    }

    @Step({ maxAttempts: 3 })
    async render(rows: ReportRow[]) {
        return renderer.toPdf(rows);
    }

    @Step({ maxAttempts: 5 })
    async deliver(pdf: Pdf) {
        return mailer.send("ops@example.com", pdf);
    }

    async run(ctx: WorkflowContext, input: { scheduledFor: string }) {
        const rows = await this.gather(input.scheduledFor);
        const pdf = await this.render(rows);
        await this.deliver(pdf);
    }
}
```

```ts
// Once at startup, for every @Cron workflow:
await registerCronWorkflows(scheduler, engine, [NightlyReport]);
```

Why this is better than an OS cron entry: if the delivery step's mail provider is down at 02:00, the workflow retries `deliver` with backoff over the next while, without re-gathering or re-rendering (those steps are memoized). If the process crashes after rendering, recovery resumes at `deliver`. A plain cron job would have to redo everything or silently drop the run.

**Pass the occurrence into the work.** Notice `scheduledFor` flows into `gather`. A report for "the 2am run on March 8" should aggregate March 8's data regardless of when it actually executes (it might run at 02:00:07 after jitter, or at 05:00 after a recovery). Deriving the business date from the scheduled instant, not from `Date.now()`, keeps the output correct.

## Pattern 2: high-frequency polling

Check an external system every few minutes. The temptation is `setInterval`; the problem is that `setInterval` overlaps if a run takes longer than the interval, and vanishes on restart.

```ts
await scheduler.registerCron({
    name: "sync-inventory",
    cronExpression: "*/5 * * * *", // every 5 minutes
    workflowName: "sync-inventory",
});
```

For polling, you usually want **skip, not catch-up** (the default). If your poller was down for an hour, you do not want twelve back-to-back syncs replaying stale five-minute windows; you want one fresh sync now. Leaving `catchUp` at its default `false` gives exactly that.

### Guarding against overlap

Cron starts a run on schedule, but nothing stops a slow run from still executing when the next fire arrives. If overlap would be harmful (double-processing, racing writes), make the workflow's first step a claim that no-ops when a previous run is still in flight:

```ts
async run(ctx: WorkflowContext, input: { scheduledFor: string }) {
  const acquired = await this.acquireSyncLock(ctx, input);
  if (!acquired) {
    return; // a previous sync is still running; skip this occurrence
  }
  await this.pullChanges(ctx, input);
  await this.releaseSyncLock(ctx, input);
}
```

Because each occurrence has its own workflow identifier, two occurrences are two independent executions; the lock step is what serializes them when you need that.

## Pattern 3: fan-out to per-entity workflows

A single schedule that then kicks off one workflow per customer, per tenant, per region. The scheduled workflow is a small dispatcher; the real work happens in the children.

```ts
@Workflow({ name: "dispatch-billing" })
@Cron({ expression: "0 0 1 * *", catchUp: true }) // 1st of each month; must not miss
class DispatchBilling {
    @Step({ maxAttempts: 3 })
    async listAccounts(scheduledFor: string) {
        return billing.accountsDueOn(scheduledFor);
    }

    @Step({ maxAttempts: 5 })
    async enqueueEach(accounts: Account[], scheduledFor: string) {
        for (const account of accounts) {
            // Deterministic child id: same account + same billing day => same run.
            await engine.run("charge-account", `charge-${account.id}-${scheduledFor}`, {
                accountId: account.id,
            });
        }
    }

    async run(ctx: WorkflowContext, input: { scheduledFor: string }) {
        const accounts = await this.listAccounts(input.scheduledFor);
        await this.enqueueEach(accounts, input.scheduledFor);
    }
}
```

```ts
await registerCronWorkflows(scheduler, engine, [DispatchBilling]);
```

The key detail is the **deterministic child identifier** built from the account and the billing day. If the dispatcher re-runs (retry, crash recovery, or a catch-up replay), it calls `engine.run` with the same identifiers, so each account is charged once for that billing day rather than once per dispatcher attempt.

## Pattern 4: don't-miss-a-window jobs (catch-up)

Some schedules must process every window even if the processor was offline. Hourly billing rollups, metering, anything where a skipped window means lost money or a gap in a ledger.

```ts
await scheduler.registerCron({
    name: "hourly-metering",
    cronExpression: "0 * * * *",
    workflowName: "roll-up-metering",
    catchUp: true, // replay every missed hour on recovery
});
```

With `catchUp: true`, if the service is down from 02:00 to 05:00, the first tick after recovery fires the 03:00, 04:00, and 05:00 occurrences in order. Each fires with its own `scheduledFor`, so the workflow rolls up the correct hour:

```ts
async run(ctx: WorkflowContext, input: { scheduledFor: string }) {
  // The window is derived from the scheduled instant, never from "now",
  // so a replayed 03:00 fire still meters the 03:00–04:00 window.
  const windowStart = new Date(input.scheduledFor);
  await this.meterWindow(ctx, windowStart);
}
```

Two safeguards make this safe rather than dangerous:

- **Deterministic identifiers** mean a window that was half-processed before the crash resumes instead of double-counting.
- **A per-tick cap** (`maxCatchUpPerTick`, default 100) bounds the burst, so a schedule that was paused for a month does not try to replay thousands of windows in one tick.

Choosing between skip and catch-up comes down to one question: _is a missed occurrence a lost fact, or just a skipped refresh?_ Lost fact → catch-up. Skipped refresh → default skip.

## Pattern 5: business-hours and weekday schedules

Cron's day-of-week and ranges cover most calendar rules, and time zones make them mean what you expect.

```ts
// Every weekday at 09:30 Eastern (market open).
await scheduler.registerCron({
    name: "market-open-check",
    cronExpression: "30 9 * * 1-5",
    workflowName: "check-market",
    timeZone: "America/New_York",
});

// Every 15 minutes during business hours, Mon–Fri.
await scheduler.registerCron({
    name: "queue-drain",
    cronExpression: "*/15 9-17 * * 1-5",
    workflowName: "drain-support-queue",
    timeZone: "Europe/London",
});
```

Always set `timeZone` for anything tied to human hours. "9:30" without a zone is 9:30 UTC, which is 4:30am in New York, almost certainly not what "market open" meant. See [the time zone section](./durable-cron.md#time-zones) for how DST is handled.

## Pattern 6: run-it-now, alongside the schedule

Operators often need to trigger a scheduled job on demand: a "Run report now" button, or re-running after fixing bad data. `triggerCron` fires immediately without disturbing the schedule's cadence.

```ts
// In an admin endpoint:
app.post("/admin/reports/run-now", async (_req, res) => {
    const workflowId = await scheduler.triggerCron("nightly-report");
    if (!workflowId) {
        return res.status(404).send("No such schedule");
    }
    res.json({ startedWorkflow: workflowId });
});
```

The manual fire uses a distinct identifier (suffixed `-manual`) so it never collides with a scheduled occurrence, and the schedule's own `nextRunAt` is untouched, the 02:00 run still happens tonight.

## Pattern 7: managing schedules as data

Schedules are stored records, not just startup code. That lets you build features on top of them: a tenant enabling a digest, an operator pausing a noisy job during an incident, a UI listing what runs when.

```ts
// A tenant turns their weekly digest on.
await scheduler.registerCron({
    name: `digest-${tenantId}`,
    cronExpression: "0 8 * * 1", // Mondays at 08:00
    workflowName: "send-digest",
    timeZone: tenant.timeZone,
    payload: JSON.stringify({ tenantId }),
});

// Pause every job during an incident, then resume afterwards.
for (const s of await scheduler.listCronSchedules()) {
    await scheduler.pauseCron(s.name);
}
// ...incident resolved...
for (const s of await scheduler.listCronSchedules()) {
    await scheduler.resumeCron(s.name);
}

// The tenant turns the digest off for good.
await scheduler.removeCron(`digest-${tenantId}`);
```

Two things make this pattern pleasant:

- **Registration is idempotent by name.** Re-registering `digest-${tenantId}` (say, on every boot, or when the tenant changes their delivery time) updates the definition in place and preserves firing history rather than resetting it. You do not need "create vs update" branching.
- **Per-entity names** like `digest-${tenantId}` give each tenant an independent schedule you can pause, resume, or remove without touching the others.

## Anti-patterns and pitfalls

**Deriving the business date from `Date.now()`.** After jitter or a catch-up replay, a fire can execute later than its scheduled instant. Compute the period the run covers from `scheduledFor`, not from the wall clock, or a delayed 02:00 run will report the wrong day.

**Assuming non-overlap.** Cron fires on schedule; it does not wait for the previous run to finish. If overlap is harmful, add a lock step (Pattern 2).

**Using catch-up for "current state" jobs.** Replaying twelve stale cache refreshes helps no one. Reserve `catchUp` for jobs where a missed window is a lost fact.

**Non-deterministic child identifiers in a fan-out.** If the dispatcher builds child ids with `Date.now()` or a random value, a retry or replay creates _new_ children instead of resuming the intended ones, which is how you double-charge. Always derive child ids from stable inputs plus the occurrence (Pattern 3).

**Scheduling human-hours jobs in UTC.** Set the `timeZone`. This is the single most common cron bug.

## Related

- [Durable cron](./durable-cron.md): what it is, registering a schedule, time zones, catch-up, and jitter.
- [Scheduler lifecycle](./scheduler-lifecycle.md): how the poller fires schedules.
- [Steps](../concepts/steps.md): memoization, which makes re-fired occurrences safe.
- [Durable sleep](./durable-sleep.md): pausing _within_ a workflow, as opposed to scheduling _between_ runs.
- [Retries and backoff](../concepts/retries-and-backoff.md): how a failing step inside a scheduled workflow recovers.
