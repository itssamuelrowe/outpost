---
id: durable-cron
title: Durable cron
---

# Durable cron

Durable cron runs a workflow on a repeating schedule, like a crontab line, but resilient to restarts, crashes, and deploys. This page covers what it is and how to register one. For real-world usage see [Durable cron patterns](./durable-cron-patterns.md); for how the poller fires schedules see [Scheduler lifecycle](./scheduler-lifecycle.md).

## Why not an OS cron job

A system `cron` entry or a `setInterval` fires a job on one machine, in memory, with no record of what happened. If that machine is down at the fire time, the run is simply lost. If it fires but crashes halfway, nothing resumes it. In a fleet, either every instance fires (duplicate work) or you nominate one special box (a single point of failure).

A durable cron schedule lives in your storage backend. Any instance can fire it, exactly one wins the claim, the fire is recorded, and the workflow it starts is itself durable, so a crash mid-run resumes where it left off. Missed windows can be replayed. That is the difference between "run this command at 9am on this box" and "guarantee this workflow runs for the 9am occurrence, whatever happens to the machines."

## Registering a schedule

A schedule always fires by starting a workflow. You can wire it up with a decorator or with the functional API; both do exactly the same thing.

### With the `@Cron` decorator

Apply `@Cron` alongside `@Workflow`, then register your cron classes in one call. The decorator is pure sugar: it records the schedule on the class and `registerCronWorkflows` sets it up through the functional API behind the scenes.

```ts
import { Workflow, Step, Cron, registerCronWorkflows } from "@outpost/core";

@Workflow({ name: "nightly-report" })
@Cron({ expression: "0 2 * * *", timeZone: "America/New_York" })
class NightlyReport {
    @Step({ maxAttempts: 5 })
    async deliver(pdf: Pdf) {
        return mailer.send("ops@example.com", pdf);
    }

    async run(context: WorkflowContext, input: { scheduledFor: string }) {
        // ...gather, render, deliver...
    }
}

// Once at startup: registers every @Cron workflow and installs the fire handler.
await registerCronWorkflows(scheduler, engine, [NightlyReport]);
scheduler.start(async (timer) => resumeWorkflow(timer.workflowIdentifier));
```

### With the functional API

The same schedule without decorators. You register the schedule and install the fire handler yourself.

```ts
scheduler.onCronFire(async ({ schedule, workflowIdentifier, scheduledFor }) => {
    await engine.run(schedule.workflowName, workflowIdentifier, {
        scheduledFor: scheduledFor.toISOString(),
    });
});

await scheduler.registerCron({
    name: "nightly-report",
    cronExpression: "0 2 * * *",
    workflowName: "nightly-report",
    timeZone: "America/New_York",
});
```

See [Functional durable cron](../function-style/durable-cron.md) for the functional style in full.

Either way, registration is **idempotent by name**: calling it on every boot is the intended pattern. An unchanged schedule keeps its firing history rather than resetting; a changed expression or payload is updated in place. The cron expression and time zone are validated immediately, so a typo throws at registration rather than failing silently on a later tick.

## Cron expression format

Standard five-field cron (`minute hour day-of-month month day-of-week`), with optional seconds as a sixth leading field.

| Expression     | Meaning                             |
| -------------- | ----------------------------------- |
| `0 * * * *`    | every hour, on the hour             |
| `*/15 * * * *` | every 15 minutes                    |
| `0 9 * * 1-5`  | 09:00 on weekdays                   |
| `0 2 * * *`    | 02:00 every day                     |
| `0 0 1 * *`    | midnight on the first of each month |

## Time zones

A schedule is evaluated in the [IANA time zone](https://en.wikipedia.org/wiki/List_of_tz_database_time_zones) you give it, defaulting to UTC. This matters more than it first appears.

If you want a report at 9am local time, `"0 9 * * *"` with `timeZone: "America/New_York"` fires at 9am **wall-clock** time year round. Across the daylight-saving change it lands at 14:00 UTC in winter and 13:00 UTC in summer, but always at 9am for the people reading the report. Scheduled in UTC, the local fire time would drift by an hour twice a year.

Time zone support is built on [`date-fns-tz`](https://github.com/marnusw/date-fns-tz) for validation and on a cron parser that understands zone-aware occurrences, including the awkward cases around DST transitions. Always set `timeZone` for anything tied to human hours.

## Missed windows: catch-up

What should happen if your process is down when a fire is due? Say an hourly job is offline from 02:00 to 05:00; three occurrences went by unfired. You choose per schedule with `catchUp`:

- **`catchUp: false` (default): skip.** Missed windows are dropped; the schedule resumes at the next occurrence. Right for "current state" jobs, a dashboard refresh gains nothing from three stale replays.
- **`catchUp: true`: replay.** Each missed occurrence fires on recovery, in order. Right for jobs that must not miss a window, an hourly billing rollup should process every hour even if delayed.

```ts
@Cron({ expression: "0 * * * *", catchUp: true })
```

Replays are bounded per tick (`maxCatchUpPerTick`, default 100) so a schedule paused for a very long time cannot produce an unbounded burst of runs on the first tick after recovery. Because each occurrence maps to a deterministic identifier (below), replayed fires are safe.

## Exactly-once per occurrence

When a schedule fires, the scheduler derives a workflow identifier from the schedule name and the exact scheduled instant, for example `cron-nightly-report-2026-03-08T07:00:00.000Z`. That stable identifier gives two guarantees:

- **Across instances.** Several processes can run the scheduler at once; the claim that fires an occurrence is atomic, so only one dispatches it. Even if a race slipped through, both resolve to the same identifier and the engine [memoizes](../concepts/steps.md) completed work rather than repeating it.
- **Across restarts.** A crash after firing but before completing resumes the same execution on recovery.

## Jitter

Cron schedules love round numbers: the top of the hour, midnight, the start of the week. When many schedules (or many instances sharing one) come due at the same instant, they would hit the database and downstream systems in lockstep, the classic **thundering herd**. The scheduler adds a small random delay drawn from `[0, ceiling]` to each fire; a ten-second default spreads a wall of 02:00 fires into a gentle ramp without meaningfully delaying the work. This is the same reasoning behind the jitter in [retry backoff](../concepts/retries-and-backoff.md).

```ts
const scheduler = new Scheduler(storage, {
    cronJitterMilliseconds: 30_000, // spread fires across a 30-second window
});
```

Set `cronJitterMilliseconds: 0` to fire at the exact instant, for example in tests that assert on timing.

## Managing schedules at runtime

Schedules are living records, not just startup configuration. Change them while the application runs, no redeploy needed.

```ts
await scheduler.pauseCron("nightly-report"); // stop firing, keep the definition
await scheduler.resumeCron("nightly-report"); // start firing again
await scheduler.removeCron("nightly-report"); // delete it
const all = await scheduler.listCronSchedules(); // inspect nextRunAt / lastRunAt
const id = await scheduler.triggerCron("nightly-report"); // fire once, out of band
```

A paused schedule is skipped by the poller but retains its history. A manual `triggerCron` fires immediately and leaves the schedule's own `nextRunAt` untouched, useful for a "run it now" button or a smoke test.

## A note on scale

Cron evaluation polls the storage backend on an interval, a good fit for a moderate number of schedules. A deployment with very high volume may need a different backend; see [Scheduler lifecycle](./scheduler-lifecycle.md#a-note-on-scale).

## Related

- [Durable cron patterns](./durable-cron-patterns.md): nightly batch, polling, fan-out, catch-up, business hours, run-it-now, and the anti-patterns to avoid.
- [Functional durable cron](../function-style/durable-cron.md): the same, authored as plain functions.
- [Scheduler lifecycle](./scheduler-lifecycle.md): how the poller fires schedules.
- [Steps](../concepts/steps.md): memoization, which makes a re-fired occurrence safe.
