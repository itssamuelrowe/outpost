---
id: backfill-and-update
title: Backfilling and updating schedules
---

# Backfilling and updating schedules

A [durable cron schedule](./durable-cron.md) fires on its cadence and keeps doing so across restarts. Two operational needs come up around that steady state often enough to have first-class support: replaying a schedule over a past window, and changing a schedule's definition without losing its history.

Both are methods on the `Scheduler`, and both require that a cron fire handler is set (via `scheduler.onCronFire(...)`), because they dispatch through the same handler a normal fire uses.

## Backfilling a past window

`backfillCron(name, start, end)` replays every occurrence of a schedule in the historical `[start, end]` window through the fire handler, **without touching the schedule's live cadence**. Use it to catch up a schedule that missed a stretch (the process was down for a day) or to reprocess a range after fixing a bug.

```ts
const dispatched = await scheduler.backfillCron(
    "nightly-report",
    new Date("2026-03-01T00:00:00.000Z"),
    new Date("2026-03-07T23:59:59.000Z"),
);
// dispatched: the workflow identifiers fired, in chronological order
```

The window is inclusive of both ends: an occurrence landing exactly on `start` is included.

### Backfill is idempotent

Each backfilled occurrence is dispatched with a distinct, deterministic workflow identifier that includes both the schedule name and the exact instant, marked as a backfill:

```
cron-<name>-<instant>-backfill
```

Because the identifier is derived from the instant, running the same backfill twice resolves each occurrence to the _same_ workflow execution. Your fire handler passes that identifier to `engine.run`, and the engine memoises the completed run rather than doing the work again. So a backfill you accidentally run twice does not double-process anything.

### The live schedule is untouched

Backfilling never advances or rewinds the schedule's own `nextRunAt`. The regular cadence keeps firing on time regardless of any backfill you run.

### Bounding the burst

The number of occurrences dispatched in one call is capped by the scheduler's `maxCatchUpPerTick` setting (default 100), the same ceiling used for catch-up recovery. For a very wide window, call `backfillCron` over sub-ranges.

## Updating a schedule in place

`updateCron(name, changes)` edits an existing schedule while preserving its identity and firing history. Any subset of the mutable fields may change; omitted fields keep their current value.

```ts
// Change the cadence:
await scheduler.updateCron("nightly-report", {
    cronExpression: "0 2,14 * * *", // now twice daily
});

// Change only the payload:
await scheduler.updateCron("nightly-report", {
    payload: JSON.stringify({ format: "csv" }),
});
```

The updatable fields are `cronExpression`, `timeZone`, `payload`, `catchUp`, and `workflowName`.

### When `nextRunAt` is recomputed

If the update changes the **cadence** (the cron expression or the time zone), the next fire is recomputed from now, so the new cadence takes effect immediately instead of waiting for the old `nextRunAt` to pass. If the update touches only non-cadence fields (payload, catchUp, workflowName), the schedule keeps its place in its cycle and `nextRunAt` is left alone.

### Validation and history

A new expression or time zone is validated before anything is persisted, so an invalid update throws (`InvalidCronExpressionError` or `InvalidTimeZoneError`) and leaves the stored schedule untouched. The schedule's `lastRunAt` and creation time are preserved across an update, so updating is not the same as removing and re-registering: you keep the firing history.

`updateCron` returns the updated schedule, or `null` when no schedule with that name exists.

## Comparison with the other schedule controls

| Call                       | What it does                                                     |
| -------------------------- | ---------------------------------------------------------------- |
| `registerCron`             | Create a schedule (or refresh an existing one, keeping history). |
| `updateCron`               | Change an existing schedule's definition in place.               |
| `triggerCron`              | Fire once, now, out of band; cadence untouched.                  |
| `backfillCron`             | Replay a past window through the handler; cadence untouched.     |
| `pauseCron` / `resumeCron` | Stop and restart firing.                                         |
| `removeCron`               | Delete the schedule permanently.                                 |

## A complete example

See [`examples/order-processing/src/cron-backfill-update.ts`](https://github.com/) for a runnable example that registers a nightly report, backfills a week, and updates the cadence to twice daily.
