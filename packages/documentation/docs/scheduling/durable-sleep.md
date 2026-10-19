---
id: durable-sleep
title: Durable sleep
---

# Durable sleep

Sometimes a workflow needs to wait. Hold an order for two hours before sending a reminder. Pause a day between onboarding emails. Back off for a while before checking an external job again. An ordinary `setTimeout` cannot do this safely, because if the process restarts during the wait, the timer is gone and the workflow is lost.

A **durable sleep** solves this. It records the wait in storage, suspends the workflow, and lets the scheduler resume it once the time has passed, even if the original process exited long ago.

## Using it

Call `context.sleep` from inside your workflow, giving it a key and a duration in milliseconds.

```ts
@Workflow({ name: "checkout" })
class Checkout {
    async run(context: WorkflowContext, input: OrderInput) {
        await this.createOrder(input);

        // Wait two hours before nudging the customer.
        await context.sleep("reminder-delay", 2 * 60 * 60 * 1000);

        await this.sendReminder(input);
    }
}
```

The key (`"reminder-delay"`) identifies this particular sleep within the workflow, much like a step key. Keep it stable, and give each distinct sleep in a workflow its own key.

## What actually happens

A durable sleep is not a blocking pause. Here is the real sequence:

1. The first time the workflow reaches the sleep, Outpost records a timer with a due time of "now plus the duration" and then **suspends** the workflow. The workflow's status becomes `SUSPENDED`, and the current run stops there. It does not sit in memory waiting.
2. The embedded [scheduler](#the-scheduler) periodically looks for timers whose due time has passed. When this sleep becomes due, the scheduler resumes the workflow by running it again.
3. On that resume, the workflow re-executes from the top. The steps before the sleep return their saved results without repeating. When execution reaches the sleep again, its due time has now passed, so the sleep returns immediately and the code after it runs.

Because the timer lives in storage, all of this survives a process restart. A workflow can sleep for a day across three deployments and still wake up correctly.

## The due time is fixed on the first call

An important detail: the due time is set the first time the sleep runs, and it is not moved forward on later resumes. If a workflow that slept for ten minutes is resumed after nine minutes (perhaps by an unrelated event), the sleep suspends it again for the remaining minute rather than restarting the full ten. The wait means "until this instant," not "for this long, restarted each time."

This is why the sleep key matters and why sleeps are idempotent: the key is how Outpost recognises the same sleep across resumes and reuses its original due time.

## It is a durable primitive, so the deterministic rules apply

`context.sleep` is one of the two durable primitives Outpost exposes (the other is `context.step`). Everything the [Writing deterministic steps](../concepts/writing-deterministic-steps.md) guide says about the code between steps applies around a sleep too. In particular, do not carry a time-sensitive handle across a sleep; anything created before a sleep may be stale after it. See [Time-sensitive resources](../concepts/expirable-resources.md).

## The scheduler

Durable sleep only works if something wakes the workflow when a timer is due. That something is the **scheduler**, a small background poller you run inside your application processes. There is no separate service to operate.

```ts
import { Scheduler } from "@outpost/core";

const scheduler = new Scheduler(storage);
scheduler.start(async (timer) => {
    // A due timer means a workflow is ready to resume. Re-run it; the steps
    // before the sleep are memoised, so it fast-forwards to where it left off.
    await resumeWorkflow(timer.workflowIdentifier);
});
```

You can run the scheduler in as many processes as you like. It claims each due timer atomically, so no timer is resumed twice under normal locking. When you shut a process down, call `scheduler.stop()` to end the poll loop cleanly.

The scheduler is deliberately simple: it polls the database on an interval. That is a great fit for moderate timer volumes. For very large numbers of timers, database polling can become a bottleneck, which is a known limitation of the first release.

The same scheduler also fires recurring schedules (durable cron), so a workflow can run on a repeating schedule that survives restarts. See [Durable cron](./durable-cron.md) and the [Scheduler lifecycle](./scheduler-lifecycle.md).

## Other durable features

Durable sleep is one of a small set of durable capabilities. Here is the whole family, so you know what tools you have:

- **Durable steps (`context.step`).** The core primitive: run an action once, save its result, and never repeat it on resume. See [Steps](../concepts/steps.md).
- **Durable sleep (`context.sleep`).** This page: wait for a duration that survives restarts.
- **Retries with backoff.** A failed step can be retried on a schedule, which uses the same timer and scheduler machinery as sleep. See [Retries and backoff](../concepts/retries-and-backoff.md).
- **Probes for ambiguous outcomes.** Resolve "did this already happen?" after a timeout or 5xx, without duplicating the effect. See [Ambiguous state and probes](../concepts/ambiguous-state-and-probes.md).
- **Optional steps with fallbacks.** Let a non-critical step fail without failing the whole workflow. See [Steps](../concepts/steps.md#step-options).
- **Manual lease release.** Hand back an in-flight step during a graceful shutdown so another worker can take it immediately. See [Leases and fencing](../concepts/leases-and-fencing.md#releasing-a-lease-manually).

All of these share the same foundation: state and timers live in storage, so the engine can stop and resume at any point without losing work.
