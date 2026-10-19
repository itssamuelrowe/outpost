---
id: scheduler-lifecycle
title: Scheduler lifecycle
---

# Scheduler lifecycle

The scheduler is the small background poller that makes every time-based feature work. It runs inside your ordinary application processes, there is no separate daemon or cluster, and it has exactly two jobs:

1. **Dispatch due one-shot timers.** These back [durable sleep](./durable-sleep.md) and retry backoff. You never create them directly.
2. **Fire due recurring schedules.** These are [durable cron](./durable-cron.md) jobs you register with a cron expression.

This page is about the poller itself: how it starts, what one tick does, and how it stops. The two features it drives have their own pages.

## The poll loop

Once started, the scheduler repeats a simple cycle until stopped. Each cycle is one **tick** followed by a sleep for the poll interval (1 second by default). If `stop` was called during a tick, the loop exits without sleeping.

![The scheduler poll loop: start begins the loop; each tick claims and dispatches due one-shot timers, then claims and fires due cron schedules; the loop sleeps for the poll interval and repeats until stop ends it.](/img/scheduler-lifecycle.svg)

A tick has two phases, always in this order:

1. **Claim due one-shot timers**, atomically, up to `batchSize` of them, and hand each to the timer handler you passed to `start`. Claiming marks a timer processed in the same step, so a concurrent scheduler cannot dispatch it twice. The timers are dispatched one after another, in the order claimed.
2. **Claim due cron schedules**, atomically advancing each one to its next occurrence, then fire each through the `onCronFire` handler. This phase is skipped entirely when no cron handler is registered, so a scheduler used only for durable sleep and retries does no cron work.

Because both claims are atomic, you can run the loop in many processes at once without double-dispatch.

`tick()` returns the number of one-shot timers it dispatched. Both `tick()` and `tickCron()` are public and can be driven manually, one cycle at a time, which is how the test suite exercises the scheduler deterministically without running the unbounded loop.

### Jitter runs inside the tick

One detail is worth calling out because it affects the loop's timing, not just cron semantics: the small random [jitter](./durable-cron.md#jitter) applied to each cron fire is awaited **inside the tick**. Before dispatching a fire, the scheduler sleeps for that fire's jitter offset, then calls the handler. Catch-up replays are handled the same way, one occurrence after another, each with its own jitter delay.

The practical consequence is that a tick can take longer than an instant when cron fires are due, and the next poll interval only begins after the tick (including all jitter waits and handler calls) has finished. For the common case, a handful of schedules with a jitter ceiling far below the poll interval, this is negligible. If you run a very large number of catch-up occurrences at once, expect that tick to be correspondingly long; `maxCatchUpPerTick` exists to bound exactly this.

## Starting and stopping

```ts
import { Scheduler } from "@outpost/core";

const scheduler = new Scheduler(storage);

// The timer handler resumes a workflow whose durable sleep or retry is now due.
scheduler.start(async (timer) => {
    await resumeWorkflow(timer.workflowIdentifier);
});

// ...later, on shutdown:
await scheduler.stop();
```

- `start(handler)` begins the loop in the background. Calling it while already running is a no-op.
- `stop()` ends the loop **after the current cycle finishes**, then resolves, so you can await a clean shutdown.

If you also use durable cron, register the cron fire handler with `onCronFire` (see [Durable cron](./durable-cron.md)); the same tick dispatches both kinds of work.

## Configuration

```ts
const scheduler = new Scheduler(storage, {
    pollIntervalMilliseconds: 1_000, // how often to tick (default 1s)
    batchSize: 50, // max items claimed per tick (default 50)
    onHandlerError: (id, error) => logger.warn({ id, error }, "dispatch failed"),
});
```

`onHandlerError` matters because the work is already committed by the time your handler runs: a due timer is marked processed when claimed, and a due cron schedule has already been advanced to its next occurrence. A handler that throws is therefore **reported** through this callback rather than rethrown, so one bad item cannot stall the loop or block its siblings in the same tick. Both handlers are protected this way. The callback's first argument is the workflow identifier for a timer failure, and the schedule name for a cron fire failure.

A corollary worth internalizing: because a cron schedule is advanced at claim time, a fire whose handler throws is **not** retried by the scheduler. The schedule simply moves on to its next occurrence. If the work must not be lost, make the fire handler start a durable workflow (which carries its own retries), rather than doing the work directly in the handler.

The `cronJitterMilliseconds`, `maxCatchUpPerTick`, and `randomNumberGenerator` options tune cron firing specifically; they are covered in [Durable cron](./durable-cron.md).

## Running across instances

Run the scheduler in every application process if you like. Both phases of the tick claim their work atomically against the shared storage backend, so under normal locking no timer and no cron occurrence is dispatched twice. This gives you availability (any instance can do the work) without a designated leader.

By default every process evaluates every due schedule each tick. When the schedule count grows large, you can instead have each process own and evaluate only a bounded slice; see [Distributing schedules across processes](./schedule-ownership.md).

## A note on scale

The scheduler polls the storage backend on an interval. That is a good fit for a moderate number of timers and schedules. A deployment with a very large number of due items at once may need a different backend; this is a known property of the first release, called out again under [durable cron](./durable-cron.md#a-note-on-scale).

## Related

- [Durable sleep](./durable-sleep.md): the one-shot timer primitive the loop dispatches.
- [Durable cron](./durable-cron.md): recurring schedules the loop fires.
- [Durable cron patterns](./durable-cron-patterns.md): worked examples.
- [Retries and backoff](../concepts/retries-and-backoff.md): the other source of one-shot timers.
