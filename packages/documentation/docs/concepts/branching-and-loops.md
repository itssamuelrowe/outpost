---
id: branching-and-loops
title: Branching and loops
---

# Branching and loops

Workflows are ordinary code, so you can use `if`, `for`, `while`, and everything else you already know. This page shows how to use them safely, since the `run` method re-executes from the top on every resume (see [Workflow lifecycle](./workflow-lifecycle.md#it-runs-again-it-is-not-replayed)).

The single rule to keep in mind: **the shape of your control flow (which branch is taken, how many times a loop runs, and each step's key) must be the same on every run.** Decisions that could differ between runs belong inside a step, whose result is saved once and reused.

## Branching

A branch is safe when the condition it tests comes from the input or from a step result, both of which are stable across resumes.

```ts
async run(context: WorkflowContext, input: OrderInput) {
  // `input.isGift` is fixed for this run, so the branch is stable.
  if (input.isGift) {
    await this.addGiftWrap(input);
  }

  // A decision that depends on live data is made inside a step, so the branch
  // it drives is stable on resume.
  const risk = await this.assessRisk(input); // a step returning a saved value
  if (risk.score > 80) {
    await this.holdForReview(input);
  } else {
    await this.autoApprove(input);
  }
}
```

The danger is branching on something that changes between runs, such as the clock, a random value, or a freshly fetched value read directly in `run`. That is covered in detail, with bad and good examples, in [Writing deterministic steps](./writing-deterministic-steps.md).

## You can mix class and functional styles freely

The class and [functional](../function-style/functional-workflows.md) styles are not exclusive. Inside a class workflow, the `run` method (and any method it passes the context to) can call `context.step(...)` directly, exactly like the functional style. This is not a workaround; it is the intended way to create steps whose keys are computed at run time, such as one step per item in a loop.

```ts
@Workflow({ name: "fulfil-order" })
class FulfilOrder {
    async run(context: WorkflowContext, input: OrderInput) {
        // A decorated step for the fixed part of the work...
        await this.reserveInventory(input);

        // ...and functional context.step calls for the dynamic, per-item part.
        for (const item of input.items) {
            await context.step(`fulfil-item-${item.id}`, async () => {
                await warehouse.ship(item.id);
                return { shipped: true };
            });
        }
    }

    @Step()
    async reserveInventory(input: OrderInput) {
        return await inventory.reserve(input.items);
    }
}
```

Decorated `@Step` methods are best for the fixed steps of a workflow, because each has a stable, method-derived key. The functional `context.step` form is best when you need a computed key, which is exactly the case in a loop. Use whichever fits each part of the workflow.

## Loops

You can loop over the workflow input and perform a durable step for each element. Because `run` re-executes on resume, the loop runs again from the start, but any iteration whose step already completed returns its saved result instead of doing its work again. So finished iterations are skipped cheaply and real work resumes at the first unfinished element.

The correct way to give each iteration its own durable checkpoint is the **functional `context.step` form with a per-element key**:

```ts
@Workflow({ name: "fulfil-order" })
class FulfilOrder {
    async run(context: WorkflowContext, input: OrderInput) {
        for (const item of input.items) {
            // A stable, per-item key. Each item is its own durable step.
            await context.step(`fulfil-item-${item.id}`, async () => {
                await warehouse.ship(item.id);
                return { shipped: true };
            });
        }
    }
}
```

If the process crashes after items `A` and `B` shipped but before `C`, then on resume the loop runs again: the steps `fulfil-item-A` and `fulfil-item-B` are already completed and return their saved results without shipping again, and only `fulfil-item-C` actually runs. Each item ships exactly once.

### Two ways to get loops wrong

**Unstable per-iteration keys.** Each iteration must produce the same key on every run. Derive it from the element's own id or its index in the fixed input, never from the clock or a random value.

```ts
// Bad: the key changes on resume, so finished items are not recognised and ship again.
await context.step(`fulfil-item-${Date.now()}`, async () => {
    /* ... */
});

// Good: the key is tied to stable data.
await context.step(`fulfil-item-${item.id}`, async () => {
    /* ... */
});
```

**Looping over data fetched between steps.** Iterate over the workflow input, which is fixed for the run, or over a list you loaded inside a step. Do not iterate over a list fetched with an un-stepped call in `run`, because it can differ on resume and change the loop.

```ts
// Bad: re-fetched on resume; the loop shape can change.
const items = await inventory.listPending();
for (const item of items) {
    /* ... */
}

// Good: load the list inside a step, then loop over its saved result.
const items = await context.step("load-items", async () => inventory.listPending());
for (const item of items) {
    /* ... */
}
```

## A subtle trap: nested steps

There is one mistake that is easy to make when you mix the two authoring styles in a loop. It is worth understanding precisely.

A method marked with `@Step` **is already a step**. When you call it, the decorator wrapper runs `context.step` for you, using the method name as the key. So this call is one durable step named `fulfilItem`:

```ts
@Step()
async fulfilItem(itemId: string): Promise<{ shipped: true }> {
  await warehouse.ship(itemId);
  return { shipped: true };
}
```

Now look at what happens if you wrap that decorated method in another `context.step` inside a loop:

```ts
// Do NOT do this.
async run(context: WorkflowContext, input: OrderInput) {
  for (const item of input.items) {
    await context.step(`fulfil-item-${item.id}`, async () => this.fulfilItem(item.id));
    //                  ^ outer step (unique per item)      ^ inner step, always keyed "fulfilItem"
  }
}
```

This creates **nested steps**: an outer step `fulfil-item-<id>` whose body calls `this.fulfilItem`, which itself starts an inner step keyed `fulfilItem`. The outer keys are unique per item, but the inner key is the same on every iteration, because a decorated method always uses its method name as the key.

The result is a bug. The first item's inner step commits `fulfilItem` as completed. On the second item, the inner step finds `fulfilItem` already completed and returns the **first item's** saved result without shipping. Only the first item is ever shipped.

The rule that avoids this:

- To give each iteration its own key, use the **functional form** `context.step(key, fn)` with a computed key, and put plain logic (not a decorated method) in `fn`. This is the correct loop shown earlier.
- Call a **decorated `@Step` method** directly when you want exactly one durable step by that name in the workflow. Do not also wrap it in `context.step`, and do not call the same decorated method more than once per workflow, because every call reuses the method-name key and collides.

In short: a step is either the decorated method or your `context.step` call, never both at once. Nesting them double-wraps and reuses keys in ways that quietly skip work.

### Is nesting ever useful?

Mechanically, a `context.step` inside another `context.step` does run, as long as the keys are distinct. But there is no benefit to it: durability already applies at each `context.step` boundary, so wrapping one step inside another only adds a redundant checkpoint and a chance to reuse a key by mistake. Keep steps flat. If you find yourself nesting, it is a sign the inner work should either be its own top-level step in `run`, or plain code inside a single step.
