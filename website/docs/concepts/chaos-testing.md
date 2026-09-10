---
id: chaos-testing
title: Chaos testing
---

# Chaos testing

Durable execution earns its keep during failures: crashes, timeouts, and workers dying mid-step. The problem is that those events are rare and hard to reproduce, so it is difficult to know your recovery paths actually work until a real outage tests them for you.

Outpost turns this around. Because every step runs through a middleware pipeline, you can hook into steps and **break them on purpose** in tests. This lets you reproduce the exact failure conditions that durable execution is meant to survive, and assert that your workflow recovers correctly. This ability to inject faults deterministically is one of the framework's core advantages.

:::warning
The chaos plugin is a testing tool. Never install it in production.
:::

## How it works

The `@outpost/plugin-chaos` package provides a middleware you add to the engine. It watches each step as it runs and, when a step matches one of your rules, injects the fault you configured: throwing an error, delaying execution, or failing after the step's work has run. Because it is ordinary step middleware, it sees exactly what the engine sees, so the failures it creates are faithful to real ones.

## Install

```bash
yarn add --dev @outpost/plugin-chaos
```

## Failing specific attempts

Suppose you want to check that a step which fails twice still succeeds on the third try. Add a rule that fails attempts 1 and 2.

```ts
import { createChaosMiddleware } from "@outpost/plugin-chaos";
import { WorkflowEngine, MemoryStorage } from "@outpost/core";

const engine = new WorkflowEngine(new MemoryStorage(), {
  middleware: [
    createChaosMiddleware([
      {
        stepKey: "charge-card",
        attempts: [1, 2], // fail the first two attempts
        error: () => new Error("injected failure"),
      },
    ]),
  ],
});
```

Now run the workflow and assert that it eventually completes and that the real work happened only once.

## Simulating a crash in the danger zone

The hardest case to get right is when a step's side effect succeeds but the process dies **before** the result is saved. You can simulate exactly that with `AFTER_EXECUTION` timing.

```ts
import { createChaosMiddleware, ChaosTiming } from "@outpost/plugin-chaos";

createChaosMiddleware([
  {
    stepKey: "create-order",
    attempts: [1],
    timing: ChaosTiming.AFTER_EXECUTION, // run the step, then fail before commit
    error: () => new Error("crash after the order was created"),
  },
]);
```

This lets you confirm your probe correctly detects the already-created order on the retry. See [Ambiguous state and probes](./ambiguous-state-and-probes.md).

## Expiring a lease

To test that another worker takes over a stalled step, add a delay long enough to pass the lease time. This exercises the same path as a genuinely dead worker whose lease expires. See [Leases and fencing](./leases-and-fencing.md).

```ts
createChaosMiddleware([
  { stepKey: "chargeCard", delayMilliseconds: 60000 },
]);
```

## Matching many steps at once

Instead of an exact `stepKey`, you can match by pattern with `stepKeyPattern`. For example, to inject failures into both notification steps (`notifyWhatsApp` and `notifyEmail`) at once:

```ts
createChaosMiddleware([
  { stepKeyPattern: /^notify/, error: () => new Error("notifications down") },
]);
```

## A recommended test checklist

For any important workflow, write chaos tests that cover:

- A step that fails a few times, then succeeds. This proves retries work.
- A crash after the side effect but before commit. This proves your probe works.
- An expired lease with a second worker taking over. This proves leases work.

If those pass, you can trust the workflow to recover in production.
