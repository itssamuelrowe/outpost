---
id: leases-and-fencing
title: Leases and fencing
---

# Leases and fencing

When you run more than one worker process, two of them might try to run the same step at the same time. Outpost prevents the resulting mess with two simple tools: **leases** and **fence tokens**. You do not have to write any code for these; this page explains what happens under the hood.

## The problem

Say two workers both pick up the `chargeCard` step for the same checkout at the same instant. If both run it, the customer is charged twice. We need to make sure only one worker runs a step at a time.

## Leases: a temporary claim

When a worker starts a step, it takes a **lease**. Think of it as putting a "busy" sign on the step for a short time. While the sign is up, no other worker will touch that step.

If the worker finishes, it clears the sign. But what if the worker crashes and never comes back? We cannot leave the sign up forever, or the step would be stuck. So the lease has an expiry time. Once it passes, another worker is allowed to take over.

## The stale worker problem

Here is the tricky part. Imagine:

1. Worker A takes the lease and starts the step.
2. Worker A becomes very slow (a long pause, a network stall).
3. The lease expires.
4. Worker B takes over and finishes the step correctly.
5. Worker A finally wakes up, unaware it lost the lease, and tries to save its own result.

If Worker A's late result overwrites Worker B's, we have corruption. We need to reject the late writer.

## Fence tokens: rejecting the late writer

Every time a step is claimed, Outpost gives out a **fence token**: a number that only ever goes up. Worker A might hold token 5; when Worker B takes over, it gets token 6.

When a worker saves its result, it must present its token. Outpost only accepts the write if the token still matches the latest one. Worker A shows token 5, but the current token is 6, so its write is rejected. Worker B's result stands.

## What this means for you

You get safe multi-worker execution for free:

- Run as many worker processes as you like against the same database.
- A crashed worker's steps are picked up by another once the lease expires.
- A slow, "zombie" worker can never overwrite newer, correct work.

You can tune how long a lease lasts per step with `leaseMilliseconds`, but the default is sensible and most people never change it.

## Releasing a lease manually

Normally you never touch leases. But there is one case where waiting for a lease to expire is wasteful: when a worker knows in advance that it is going away.

Consider a graceful shutdown. Your process receives a signal to stop (a deployment, a scale-down). It stops accepting new work, but a step is still running under a lease with, say, thirty seconds left. If the process simply exits, that step is stuck for the remainder of the lease before another worker can pick it up. For a long lease, that is a real delay in recovery, for a shutdown you already knew about.

Releasing the lease avoids the wait. The engine exposes two methods:

- `engine.releaseStep(workflowId, stepKey, fenceToken)` releases one specific lease.
- `engine.releaseInFlightSteps()` releases every lease the engine currently holds. This is the one you want in a shutdown handler.

```ts
async function shutdown() {
    // 1. Stop taking new work (for example, stop the queue consumer).
    consumer.stop();

    // 2. Hand back any steps still in flight so another worker can take them
    //    over immediately, instead of waiting for their leases to expire.
    await engine.releaseInFlightSteps();

    // 3. Exit.
    process.exit(0);
}
```

A release is guarded by the fence token, so only the current holder can release a lease. It clears the lease and returns the step to a pending, claimable state without changing the attempt count, so the next worker simply resumes it. If the token is stale (another worker has already taken over), the release does nothing and reports `false`.

Releasing a lease is not the same as cancelling or failing the step. The step's work is not marked done or failed; it is simply made available for another worker to run. Think of it as politely handing back a task you picked up but will not finish, rather than abandoning it and forcing everyone to wait for a timeout.
