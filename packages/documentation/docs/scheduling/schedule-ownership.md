---
id: schedule-ownership
title: Distributing schedules across processes
---

# Distributing schedules across processes

By default every scheduler process evaluates every due schedule on each tick, and an atomic per-occurrence claim keeps two processes from firing the same occurrence (see [Scheduler lifecycle](./scheduler-lifecycle.md#running-across-instances)). That is correct and simple, and it is the right choice for a moderate number of schedules.

When the number of schedules grows large, or individual schedules do heavy work, you may instead want each process to **own a slice** of the schedules and evaluate only those. This page describes the optional lease-based ownership model that provides it, and the algorithm that keeps it safe, balanced, and starvation-free.

## The capacity choice is always explicit

There is no implicit default for how much a process takes on. When you enable ownership, you must state a `capacity`:

- **`capacity: "all"`**: the process owns and evaluates every schedule. This is the right choice for a single process or a monolith. Several `"all"` processes simply share the work through the atomic per-occurrence claim, the same as running without ownership at all.
- **`capacity: <number>`**: the process owns at most that many schedules and evaluates only those, so a large set spreads across the fleet.

Requiring the choice is deliberate. "Pick up everything" and "pick up only so much" have very different operational characteristics, and which one a deployment wants should be visible in its configuration, not inferred from a default. A missing or invalid `capacity` throws at construction.

## What ownership does and does not change

Ownership is a **load-distribution** optimization, not a correctness mechanism. Two guarantees are layered, and it is important to keep them separate:

- **Correctness (always on).** Firing an occurrence advances the schedule's `nextRunAt` atomically. Even if two processes briefly believe they own the same schedule (say, because of clock skew), only one wins the advance, so an occurrence is dispatched once. This is the same backstop the default model relies on.
- **Distribution (opt-in).** A lease records which process is responsible for a schedule, so in the normal case only the owner evaluates it. This keeps each process's per-tick work proportional to its slice rather than to the whole set.

Because correctness does not depend on the lease, a stale or misattributed lease can waste a little work but can never double-fire an occurrence.

## The lease

Each schedule carries two extra fields:

- `leaseOwner`: the id of the process currently responsible for it, or null when unowned.
- `leaseExpiresAt`: the instant the lease goes stale if it is not renewed.

A process owns a schedule only while it holds a live lease (`leaseOwner === self` and `leaseExpiresAt > now`). Everything else follows from how leases are acquired, renewed, and expired.

## Turning it on

Ownership is off by default. Pass an `ownership` block, with an explicit `capacity`, to enable it:

```ts
const scheduler = new Scheduler(storage, {
    pollIntervalMilliseconds: 1_000,
    ownership: {
        // Required and explicit: "all" to pick up everything, or a number to pick
        // up only so much. There is no default.
        capacity: 50,
        // A stable id, unique per process. Defaults to a random id at construction.
        processId: process.env.HOSTNAME,
        // How long a lease survives without renewal. Defaults to 3× the poll
        // interval; a crashed owner's slice is reclaimed within this window.
        leaseTtlMilliseconds: 3_000,
        // Hand leases back on graceful shutdown instead of waiting for expiry.
        releaseOnStop: true,
        // Also fire due-but-unowned schedules so none starve when the fleet's total
        // capacity is below the schedule count. Defaults to true.
        fireUnownedAsSafetyNet: true,
    },
    // Observe the safety net: a persistently non-zero count means add capacity.
    onUnownedSchedulesDetected: (count) =>
        logger.warn({ count }, "cron schedules fired without an owner"),
});

scheduler.onCronFire(async ({ schedule, workflowIdentifier, scheduledFor }) => {
    await engine.run(schedule.workflowName, workflowIdentifier, {
        scheduledFor: scheduledFor.toISOString(),
    });
});
scheduler.start(async (timer) => resumeWorkflow(timer.workflowIdentifier));
```

One-shot timers (durable sleep, retries) are unaffected by ownership; every process still shares that work through the atomic per-timer claim. `scheduler.processId` returns the effective id, or `null` when ownership is off.

## The algorithm

Each process runs two ownership steps on every tick, before the firing phase. Let `self` be this process's id and `ttl` be `leaseTtlMilliseconds`.

### 1. Renew: keep what you already hold

```
renew all schedules WHERE leaseOwner = self
  SET leaseExpiresAt = now + ttl
```

A live process heartbeats its leases every tick. As long as it keeps ticking, it keeps its slice. This is what makes a crash detectable: a dead process stops renewing, and its leases age out.

### 2. Acquire: top up to your capacity

```
if capacity == "all":
  claim every free-or-expired schedule (up to the batch size per tick)
else:
  owned   = count(leaseOwner = self AND lease live)
  deficit = capacity - owned
  if deficit > 0:
    atomically claim up to `deficit` schedules
      WHERE leaseOwner IS NULL OR leaseExpiresAt <= now   -- free or expired
      SET leaseOwner = self, leaseExpiresAt = now + ttl
      ORDER BY leaseExpiresAt NULLS FIRST                  -- longest-free first
      LIMIT deficit
```

The claim is a single conditional atomic write. Whoever's write lands first wins the row; a competing process sees it already owned and moves on. This is the same fencing principle the engine uses for [step leases](../concepts/leases-and-fencing.md): the database, not the application, arbitrates the race. Topping up only to `capacity` (never beyond) is what bounds each process and lets ownership spread as processes join.

### 3. Fire: what you own, plus a safety net

The firing phase considers schedules where `leaseOwner = self` and the lease is live. Then, unless disabled, the process also fires any schedule that is **due but unowned** (see the leftover question below). Everything from the default model (atomic `nextRunAt` advance, jitter, catch-up) applies unchanged to both.

## The three guarantees

### Each process claims only a few

With a numeric `capacity`, acquisition tops up only to that number and never beyond, so a process owns at most `capacity` schedules and evaluates only those. Its per-tick work is proportional to its slice, not to the whole set. (With `capacity: "all"`, "a few" becomes "all", by choice.)

### Two processes never pick the same one

Acquisition is a conditional write guarded by the lease predicate, in a relational backend, one `UPDATE ... WHERE (leaseOwner IS NULL OR leaseExpiresAt <= now) ... LIMIT k` under the row locks the update takes. Concurrent acquirers are serialized by the database: the first commits and flips the rows to its ownership; the second's `WHERE` no longer matches, so it claims different rows (or none). No schedule is ever owned by two processes at once. The application-side read only _sizes_ the request; the write itself re-checks the predicate, so a stale read can cause a process to attempt more than it gets, never to over-claim. And even if a lease were somehow misattributed, the atomic `nextRunAt` advance at fire time still guarantees an occurrence fires once.

### No starvation if a process goes down

A crashed owner stops renewing, so its leases expire at `leaseExpiresAt`; they cannot stay stuck to a dead process. On the next tick, any survivor below its capacity acquires them from the free/expired pool. Worst-case time from crash to re-ownership is one `ttl` plus one tick. Set `ttl` to a small multiple of the poll interval (default 3×): shorter means faster failover but more renewal writes; longer means the reverse. On a _graceful_ shutdown, `releaseOnStop` hands leases back immediately so peers do not even wait for expiry.

## What about the leftover schedule?

> 101 schedules, two processes each with `capacity: 50`. They own 50 and 50. What happens to the 101st?

This is the case to get right, because a naive "fire only what you own" design would strand that schedule forever: nobody owns it, so nobody fires it. Outpost handles it with the **safety net** (step 3 above), on by default:

- Each process, after firing its owned slice, also claims and fires schedules that are **due and currently unowned**. So on the tick where the 101st comes due, whichever process gets to it first fires it. Nothing starves.
- That claim is the same atomic advance-on-fire used everywhere, so the leftover is fired exactly once even though two processes are eligible to sweep it.
- Every time the net catches leftovers, their count is reported through `onUnownedSchedulesDetected`. A persistently non-zero value is the signal that **total capacity is below the schedule count** and you should add a process or raise `capacity`. In the example, 3 × 50 = 150 ≥ 101 would give the 101st a proper owner and the net would report zero.

So the leftover is never dropped; it is fired opportunistically and surfaced as a capacity signal. If you would genuinely rather an over-capacity schedule be skipped than run on an already-full fleet, set `fireUnownedAsSafetyNet: false`, then unowned schedules wait until capacity frees up. That is rarely what you want, which is why the net defaults on.

## Balancing and late joiners

Because each process tops up only to its `capacity`, ownership balances as the fleet changes:

- **Scale up.** A new process starts owning nothing, sees a deficit, and acquires from the free pool. If existing processes already hold everything, it acquires nothing at first, then picks up leases as they expire and are re-balanced. Meanwhile the safety net ensures no schedule waits on that convergence to fire.
- **Scale down / crash.** The leaving process's leases expire (or are released on graceful stop) and are redistributed across survivors by step 2.

Both directions converge without any central coordinator or leader election; the shared store is the only coordination point, consistent with the rest of Outpost.

## When to use which model

|                           | Default (per-occurrence)                   | Lease ownership (per-schedule)                         |
| ------------------------- | ------------------------------------------ | ------------------------------------------------------ |
| Coordination              | Atomic occurrence claim                    | Atomic occurrence claim **plus** leases                |
| Per-tick work per process | Proportional to _all_ due schedules        | Proportional to _owned_ due schedules                  |
| Best for                  | Up to ~thousands of schedules              | Very large schedule counts, or heavy per-schedule work |
| Failover                  | Immediate (any process fires any due item) | Bounded by lease `ttl`                                 |
| Extra writes              | None                                       | Renewal heartbeats each tick                           |

Ownership is opt-in precisely because it trades a little extra write traffic and `ttl`-bounded failover for bounded per-process work. Reach for it when a single process evaluating the whole set each tick becomes the bottleneck, not before.

## Related

- [Scheduler lifecycle](./scheduler-lifecycle.md): the poll loop ownership plugs into.
- [Leases and fencing](../concepts/leases-and-fencing.md): the same atomic-claim principle applied to steps.
- [Durable cron](./durable-cron.md): the schedules being distributed.
