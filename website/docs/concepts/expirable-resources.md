---
id: expirable-resources
title: Time-sensitive resources
---

# Time-sensitive resources

Memoization is the feature that makes resuming safe: a completed step returns the exact value it produced the first time, without running again. But there is a limit to what that guarantee covers, and it is important to understand precisely, because it is easy to assume more safety than you actually have.

Memoization guarantees the **value** survives. It says nothing about whether the **thing that value refers to** is still valid in the outside world.

This distinction only matters for one kind of step: a step that returns a handle to a resource that can expire or change on its own. A signed URL, a payment link, a short-lived access token, a lock, a temporary reservation. For these, the saved value can be perfectly intact while the real resource behind it has quietly gone stale.

## A concrete example

Consider a checkout that generates a payment link early, waits for the customer, and then sends a reminder that includes the link.

```ts
@Workflow({ name: "checkout" })
class Checkout {
  @Step()
  async createPaymentLink(input: OrderInput): Promise<{ url: string }> {
    // The provider issues a link that expires in 15 minutes.
    return await paymentProvider.createLink(input.total);
  }

  async run(context: WorkflowContext, input: OrderInput) {
    const link = await this.createPaymentLink(input); // step 1, memoised

    await context.sleep("await-customer", 60 * 60 * 1000); // wait an hour

    // An hour later. The memoised `link.url` is byte-for-byte intact, but the
    // provider expired it 45 minutes ago.
    await this.sendReminder(input, link.url);
  }
}
```

Walk through what happens when this workflow resumes after the sleep. The step `createPaymentLink` is already completed, so its saved `url` is returned unchanged. The value survived perfectly. The resource it points to did not: the provider expired the link fifteen minutes after it was created.

Outpost cannot detect this, and it would be wrong to try. Only the payment provider knows a link's lifetime. From Outpost's point of view the step succeeded and produced a valid string, which is exactly what it saved and returned. The staleness lives entirely in the outside world.

Outpost cannot silently fix this, and it would be wrong to try, because only the outside system knows a resource's lifetime. What Outpost gives you is a structural fix that prevents the problem, and an opt-in signal for when you cannot prevent it and want the engine to catch the staleness for you.

## The first fix: create the resource next to its use

The cleanest solution is to not carry a volatile handle across a gap at all. Create it in a step placed right before the step that uses it.

```ts
async run(context: WorkflowContext, input: OrderInput) {
  await context.sleep("await-customer", 60 * 60 * 1000);

  // Generate the link at the moment it is needed. This step had not completed
  // before the wait, so it runs now on the resume and always produces a fresh
  // link. The fresh link is then memoised for any further retries of THIS step.
  const link = await this.createPaymentLinkForReminder(input);
  await this.sendReminder(input, link.url);
}
```

A durable step is the right unit of freshness. By creating the link in a step placed after the wait, it is minted when the workflow reaches that point, not an hour earlier.

### Where "create near use" is not enough

This fix has a real limit, and it is important to state it. It works only when nothing that can fail sits between the creation and the use. Consider:

```ts
async run(context: WorkflowContext, input: OrderInput) {
  const link = await this.createPaymentLink(input); // step A, memoised, expires in 15 min
  await this.reserveInventory(input);               // step B, calls an API that is DOWN
  await this.sendReminder(input, link.url);          // step C, uses the link
}
```

If step B's API is down, the workflow retries B with backoff, possibly for hours. Step A is already completed and memoised, so its link is never re-created, and by the time B finally succeeds, the link that A saved is long dead. Step C then uses an expired link. Moving A next to C does not help either, because B still sits between them.

The general truth: **a memoized perishable value is unsafe across any step that can fail and cause a long gap**, not just across a sleep. When you cannot restructure the workflow to avoid that, you want the engine to notice the staleness rather than hand back a dead value. That is what the opt-in expiry below is for.

## The second fix: opt-in result expiry

A step may declare that its result is perishable. When it does, and a resume reaches the step after its result has gone stale, the engine does **not** return the stale value and does **not** silently re-run the step. Instead it raises `StepResultExpiredError`, so your workflow decides what to do.

There are two ways to declare it, and you can use either or both:

```ts
@Step({
  // Time-based: the saved result is stale once it is older than this.
  resultTtlMilliseconds: 15 * 60 * 1000, // 15 minutes
})
async createPaymentLink(input: OrderInput): Promise<{ url: string }> {
  return await paymentProvider.createLink(input.total);
}
```

```ts
@Step({
  // Predicate-based: you decide, given the saved result, whether it is still valid.
  revalidate: (link) => paymentProvider.isLinkLive(link.url),
})
async createPaymentLink(input: OrderInput): Promise<{ url: string }> {
  return await paymentProvider.createLink(input.total);
}
```

Handling the error is ordinary control flow:

```ts
import { StepResultExpiredError } from "@outpost/core";

async run(context: WorkflowContext, input: OrderInput) {
  try {
    const link = await this.createPaymentLink(input);
    await this.sendReminder(input, link.url);
  } catch (error) {
    if (error instanceof StepResultExpiredError) {
      // Decide explicitly: regenerate under a fresh step key, alert, or compensate.
    }
    throw error;
  }
}
```

Steps that do not opt in are unchanged: their results never expire, preserving the default guarantee that a completed step is final and never re-run.

## Why the engine raises instead of silently re-running

This is the subtle part, and it is why expiry raises rather than quietly re-executing the step.

Imagine the engine re-ran the expired step automatically. Step A (create link) re-runs and produces a new link. But what about a step B that already completed **using the old link**, perhaps charging the card against it? B's saved result now references a link that no longer exists. If the engine also re-ran B, it could **charge the card twice**, which is exactly the double-execution durable execution exists to prevent. The engine has no dependency graph, so it cannot know which completed steps consumed the old value, and therefore cannot safely decide to re-run them.

So the engine refuses to guess. It surfaces the expiry and lets you, who do understand the dependencies, decide. This mirrors how mature durable execution systems handle irreversible work: they do not magically undo it, they let you run explicit compensation.

## What happens to the steps after an expired step?

Nothing automatic, by design. When `StepResultExpiredError` is raised, execution stops at that point on that run, exactly like any thrown error. Steps that already completed keep their saved results (the engine does not touch them), and steps that had not run yet do not run. It is now your workflow's job to decide what those earlier, already-committed steps mean:

- If nothing downstream irreversibly consumed the stale value, you can simply regenerate the resource (under a new step key) and continue.
- If a downstream step did commit a side effect based on the stale value, regenerating is not enough; you need to **compensate** for that side effect (for example, void the charge that used the dead link) before proceeding. That is a saga.

## Compensation and sagas (planned)

The pattern for undoing already-committed work when something later goes wrong is the **saga**: each step that makes a change also defines how to reverse it, and on failure the engine runs the reversals in order. Today Outpost does not have built-in saga support, so you handle compensation manually in your `catch` blocks. First-class compensation and saga support is planned, and this page will be updated when it lands.

Until then, the honest guidance is: prefer the structural fix (create and use a perishable resource with no failure-prone step between them), reach for opt-in expiry when you cannot, and write explicit compensation when a stale value may already have been consumed by a committed side effect.

## Tips for good expirable steps

- **Prefer the structural fix first.** Create and use a perishable resource with no failure-prone step between them. This avoids the problem entirely and needs no special features.
- **Do not carry a volatile handle across a `context.sleep` or a step that can fail.** A sleep or a retrying step is where time passes. Assume anything time-sensitive created before it is dead after it.
- **When you cannot restructure, opt into expiry.** Set `resultTtlMilliseconds` to the resource's real lifetime, or use `revalidate` to check it. This turns a silent stale value into an explicit `StepResultExpiredError` you can handle.
- **Set the TTL shorter than the real lifetime.** Give yourself a margin, so the engine flags the result as stale before the provider actually rejects it.
- **Match the resource's lifetime to the workflow's timing.** If you know a workflow will pause for an hour, do not request a fifteen-minute link an hour early. Ask for the resource when you are about to use it.
- **Have a plan for the error.** When you opt into expiry, write the `catch` for `StepResultExpiredError`: regenerate under a fresh step key if nothing downstream consumed the stale value, or compensate if it did.

The single sentence to remember: **if a step's result is a reference to something that can expire, do not assume it is still valid on a later resume. Structure the workflow so it cannot go stale, or opt into expiry so the engine tells you when it has.**
