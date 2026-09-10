---
id: workflow-lifecycle
title: Workflow lifecycle
---

# Workflow lifecycle

This page explains what actually happens when a workflow runs, resumes, and completes. Understanding it makes the rest of Outpost feel obvious: nearly everything follows from a single idea, which is that **completed steps are saved and never repeated.**

## The workflow, from start to finish

When you call `engine.run(Workflow, id, input)`:

1. **The execution is recorded.** Outpost writes a workflow record keyed by your identifier (or finds the existing one, if this identifier has run before) and marks it `RUNNING`.
2. **The `run` method executes from the top.** Your orchestration code runs, calling steps in order.
3. **Each step is handled durably.** The first time a step is reached it executes and its result is saved; if it was already completed on an earlier run, its saved result is returned without executing again.
4. **The workflow finishes.** If `run` returns, the workflow is marked `COMPLETED` and its output is saved. If `run` throws, it is marked `FAILED` and the error is recorded.

A workflow lifecycle therefore looks like this:

```
RUNNING ──► COMPLETED     (run returned)
   │
   └──────► FAILED        (a mandatory step failed, or run threw)
```

The important subtlety is step 2: **`run` re-executes from the top on every resume.** The next section explains why that is the heart of how Outpost works, and how it differs from other tools.

### A concrete resume

Take a checkout that charges a card and then ships an order. Suppose the process crashes after the charge is saved but before shipping:

- **First run:** `chargeCard` executes and is saved. Then the process dies before `shipOrder` completes.
- **Resume:** `run` starts again from the top. `chargeCard` is already `COMPLETED`, so its saved result is returned and the card is **not** charged again. Execution continues to `shipOrder`, which now runs.

The customer is charged exactly once, and the order ships, even though `run` executed twice.

## It runs again; it is not replayed

This is the single idea that sets Outpost apart from other durable execution tools, so it is worth stating plainly.

When a workflow resumes, Outpost **runs your `run` method again, from the top, like an ordinary function call.** It does not replay your code against a recorded event log. What makes the resume safe is memoization: the steps that already finished return their saved results instead of doing their work a second time. So a resume "fast-forwards" through the completed steps by re-executing the cheap glue between them and returning saved values for the expensive steps, then picks up real work at the first step that had not finished.

### How this compares to replay-based engines

Tools like Temporal or DBOS take a different approach called **deterministic replay**. They record an event log of everything that happened, and on recovery they replay your workflow code against that log, feeding each operation its recorded result. This is powerful, but it comes with a strict contract: your workflow code must be perfectly deterministic, because any divergence from the recorded history is a bug the engine will reject. That is why those systems forbid calling `Date.now()`, `Math.random()`, or reading external state anywhere in workflow code.

Outpost trades that power for simplicity:

| | Replay engines (Temporal, DBOS) | Outpost |
| --- | --- | --- |
| On recovery | Replays code against a recorded log | Re-runs the function normally |
| Determinism required | Everywhere in workflow code | Only in the glue **between** steps |
| `Date.now()` in the body | Forbidden | Allowed, though see the caution below |
| Mental model | Event sourcing and history | Ordinary code plus memoized steps |

### What this means for you

The upside is a much smaller thing to keep in your head: there is no event log or history to reason about. You write ordinary async code, and steps are the durable checkpoints.

The trade-off is that the code **between** your steps genuinely runs again on every resume. If that glue makes a decision from something that changes between runs (the clock, a random value, a freshly fetched list), the resume can take a different path than the original run. Keeping that glue predictable is the whole subject of [Writing deterministic steps](./writing-deterministic-steps.md). The rule of thumb is simple: **do anything unpredictable inside a step, never between steps.**

Memoization has one important limit that follows directly from this model. It preserves the **value** a step returned, but not the validity of whatever that value points to in the outside world. A step that returns a payment link or a signed URL can hand back a perfectly intact value on resume, long after the real resource behind it has expired. This has its own page, since it needs care to get right: see [Time-sensitive resources](./expirable-resources.md).

## The step lifecycle

Zooming in: every time a step is reached, Outpost runs the same short cycle. It first checks for a saved result; if one exists it is returned immediately (memoization). Otherwise it claims an exclusive lease, optionally probes when a prior attempt was ambiguous, runs your function, and records the outcome.

![The lifecycle of a durable step: check for a saved result and return it if present; otherwise claim a lease; if the prior attempt was ambiguous, run the probe, which either returns the saved result when the effect is found or proceeds to run the step function when it is not; then record the outcome as completed, a terminal failure, ambiguous, or a scheduled retry that loops back to claim after backoff.](/img/step-lifecycle.svg)

Reading it in words:

1. **Check first.** If the step already has a saved result, it is returned right away and nothing runs again. This is what makes resuming safe.
2. **Claim and lease.** Otherwise Outpost takes an exclusive lease, so no other worker runs the same step at the same time.
3. **Probe if the last attempt was ambiguous.** If a previous attempt ended in the `AMBIGUOUS` state and the step has a probe, the probe runs *before* your function:
   - if it **finds** the effect already happened, the step is marked completed from the probe's result and its value is returned, so your function does **not** run;
   - if it **does not find** it, your function runs normally;
   - if no probe was provided, the step is parked as `NEEDS_REVIEW` rather than guessed.
4. **Run and record the outcome.** Your function runs, and the result is one of: `COMPLETED` (saved), a terminal failure (`FAILED`, or `FAILED_OPTIONAL` which lets the workflow continue with a fallback), a scheduled retry that loops back to claim after backoff, or `AMBIGUOUS` when the outcome is unknown.

The colours are a hint: green is a happy ending, red is a terminal failure, yellow is the "we are not sure yet" ambiguous path, and blue is ordinary progress.

## Where the other pieces fit

- **Retries** are the "scheduled retry" arrow: a failed-but-retryable step records a timer and loops back to claim after a backoff delay. See [Retries and backoff](./retries-and-backoff.md).
- **Probes** are the ambiguous branch: they resolve "did this already happen?" without duplicating a side effect. See [Ambiguous state and probes](./ambiguous-state-and-probes.md).
- **Leases and fencing** are what make the "claim" step safe when several workers share the work. See [Leases and fencing](./leases-and-fencing.md).
- **Determinism** is about the code *between* steps, which re-runs on every resume. See [Writing deterministic steps](./writing-deterministic-steps.md).
- **Branching and loops** use ordinary control flow, with a few rules to keep resumes safe. See [Branching and loops](./branching-and-loops.md).
- **Time-sensitive resources** need care, because memoization saves a value but not the validity of what it points to. See [Time-sensitive resources](./expirable-resources.md).
