---
id: deterministic-values
title: Deterministic time and randomness
---

# Deterministic time and randomness

A workflow body can be run more than once. It runs when you start it, and it runs again on every resume: after a crash, after a durable sleep, after a redelivered message. For that to be safe, the body has to reach the same decisions each time it runs up to the point it last committed. Reading the wall clock or generating a random value directly inside the body breaks that, because those return something different every time.

Consider stamping a created-at time:

```ts
// Do NOT do this inside a workflow body.
const createdAt = Date.now(); // different on every resume
```

On the first run `createdAt` might be `10:00:00`. If the process crashes and the workflow resumes at `10:05:00`, the naive code produces a different value, and any step that already committed using the earlier value is now inconsistent with the rest of the run. The same problem applies to `Math.random()`, `crypto.randomUUID()`, and anything else that is not a pure function of the workflow's input and committed state.

## The two helpers

The workflow context provides deterministic equivalents. Each records its value durably the first time it is called for a given key, and returns that same recorded value on every later run.

```ts
engine.defineWorkflow("issue-coupon", async (context, input) => {
    const couponId = await context.randomUUID("coupon-id"); // stable across resumes
    const issuedAt = await context.now("issued-at"); // epoch ms, stable across resumes

    const code = await context.step("build-code", async () => {
        return `SAVE-${couponId.slice(-4).toUpperCase()}`;
    });

    return { couponId, issuedAt, code };
});
```

- **`context.now(key)`** returns the current time as epoch milliseconds. The first call fixes the instant; every resume observes that same instant, even if hours of wall-clock time have passed.
- **`context.randomUUID(key)`** returns a version-4 UUID. The first call generates it; every resume returns the same id rather than a fresh one.

Both are recorded as ordinary durable steps under a reserved key derived from the one you pass, so they enjoy the same memoisation guarantee as any other step.

## The key argument

Each helper takes a stable `key` that identifies the value within the workflow. Distinct keys are independent values; the same key is the same value.

```ts
const a = await context.now("received-at");
// ... later ...
const b = await context.now("processed-at"); // a different, independently recorded instant
```

Reuse a key deliberately when you want the same recorded value in two places, and use distinct keys when you want distinct values. Treat keys like step keys: stable strings, not values computed from changing state.

## Making it testable

Both helpers draw from injectable sources on the engine, so tests can make them fully deterministic:

```ts
const engine = new WorkflowEngine(storage, {
    now: () => new Date("2026-01-01T09:00:00.000Z"),
    uuid: () => "11111111-1111-4111-8111-111111111111",
});
```

In production you normally omit these; `now` defaults to the system clock and `uuid` to the platform `crypto.randomUUID`.

## Relationship to writing deterministic steps

This page is about values a workflow needs to be stable _across resumes_. The related concept of [writing deterministic steps](./writing-deterministic-steps.md) is about keeping the control flow _between_ steps deterministic. The two work together: use `context.now` and `context.randomUUID` for time and randomness, keep the rest of the body a function of input and committed results, and every resume follows the same path the original run did.

## A complete example

See [`examples/order-processing/src/deterministic-values.ts`](https://github.com/) for a runnable example that issues a coupon and proves its id and timestamp are unchanged after a resume, even with the clock advanced and a new id available.
