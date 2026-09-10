---
id: steps
title: Steps
---

# Steps

A **step** is a single action you want Outpost to remember. You write it as a method marked with `@Step`, and call it from your workflow's `run` method. When you do, Outpost runs it durably.

```ts
@Step()
async chargeCard(total: number): Promise<{ id: string }> {
  return await paymentProvider.charge(total);
}
```

Two things make a step special:

1. **Its result is saved.** After the method finishes, Outpost stores what it returned.
2. **It is not repeated.** If the workflow runs again and this step already finished, Outpost skips the method and hands back the saved result. This is called *memoization*, and it is what lets a workflow resume safely after a crash.

To see the exact sequence a step goes through each time it is reached, read the [Workflow lifecycle](./workflow-lifecycle.md#the-step-lifecycle).

:::warning Memoization saves the value, not the resource behind it
A completed step returns the identical value it produced the first time, but it does not keep the outside world frozen. If a step returns a handle to something time-sensitive (a signed URL, a payment link, a lock, a short-lived token), that handle can expire while its saved value stays byte-for-byte intact. On a later resume you would read a valid-looking value that no longer works. Produce or re-validate such handles in a step close to where they are used. See [Time-sensitive resources](./expirable-resources.md).
:::

## The step key

Each step has a **key** that Outpost uses to recognize it across restarts. By default the key is the method name (here, `chargeCard`). Keep it stable: if you rename the method later, Outpost treats it as a brand-new step with no saved result, so it would run again. If you expect to rename methods, pin the key explicitly and leave that id alone:

```ts
@Step({ id: "charge-card" })
async chargeCard(total: number): Promise<{ id: string }> {
  return await paymentProvider.charge(total);
}
```

Step keys must also stay stable across resumes at run time, which matters most inside loops. See [Writing deterministic steps](./writing-deterministic-steps.md) for the rules and examples.

## What a step can return

A step's result is **saved and read back on a later run**, so it must be something that survives being turned into data and restored: numbers, strings, booleans, `null`, arrays, and plain objects made of those. Things that cannot be faithfully saved are not allowed, for example a `Date`, a `Map`, a class instance, or a function.

Outpost helps you get this right in two ways:

1. **At compile time.** Step return values are typed as serializable, so returning something like a `Date` will not compile:

   ```ts
   @Step()
   async createOrder(input: OrderInput): Promise<{ createdAt: Date }> {
     // Type error: Date is not serializable.
     return { createdAt: new Date() };
   }
   ```

   The fix is to return data instead, such as an ISO string: `{ createdAt: new Date().toISOString() }`.

2. **At run time (optional).** If you turn on the `validateSerializable` option when you create the engine, Outpost also checks each saved value as it runs and throws a clear error pointing at the offending field. This is a safety net for values that slipped past the type checker through a cast.

   ```ts
   const engine = new WorkflowEngine(storage, { validateSerializable: true });
   ```

## Step options

The `@Step` decorator accepts options that control how the step behaves when it fails or needs recovery:

- `maxAttempts` and `backoff`: how many times to retry and how long to wait between attempts. See [Retries and backoff](./retries-and-backoff.md).
- `optional` and `fallbackValue`: allow the workflow to continue with a fallback if the step fails terminally.
- `classifyError` and `probe`: decide whether a failure is ambiguous and, if so, resolve it safely on recovery. See [Ambiguous state and probes](./ambiguous-state-and-probes.md).
- `resultTtlMilliseconds` and `revalidate`: mark the step's result as perishable, so the engine raises `StepResultExpiredError` on a resume where the saved value has gone stale. See [Time-sensitive resources](./expirable-resources.md).

Next: how a workflow and its steps progress from start to finish, in the [Workflow lifecycle](./workflow-lifecycle.md).
