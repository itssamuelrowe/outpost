---
id: child-workflows
title: Child workflows
---

# Child workflows

A workflow does not have to be a single flat sequence of steps. It can start other workflows as **children**: durable sub-executions that run, produce a result, and hand it back to the parent. Each child is a first-class workflow in its own right, with its own memoised steps, its own recovery, and its own record in storage, linked back to the parent that started it.

Reach for child workflows when a unit of work is meaningful on its own, is reused across parents, or fans out (one order fans out into one fulfilment per line item). If the work is just a couple of sequential actions with no independent identity, a plain step is simpler.

## Starting a child

There are two calls on the workflow context. Use `runChild` when you want to start a child and use its result right away:

```ts
engine.defineWorkflow("fulfil-order", async (context, order) => {
    const receipt = await context.runChild("charge", "charge-card", {
        amount: order.total,
    });
    return { receiptId: receipt.id };
});
```

Use `startChild` when you want to launch several children, let them run, and gather their results afterwards. It returns a handle immediately; awaiting `handle.result()` runs the child to completion:

```ts
engine.defineWorkflow("fulfil-order", async (context, order) => {
    const handles = await Promise.all(
        order.items.map((item, index) => context.startChild(`item-${index}`, "fulfil-item", item)),
    );
    const fulfilments = await Promise.all(handles.map((handle) => handle.result()));
    return { fulfilments };
});
```

`runChild(key, name, input)` is exactly `startChild(...).then((handle) => handle.result())`; it exists because awaiting a single child inline is the common case.

## The child key and the child identifier

The first argument to both calls is a **child key**: a stable string that names this child _within the parent_. It matters because it is how a resume of the parent finds the same child again instead of starting a new one.

By default the child's own workflow identifier is derived deterministically from the parent identifier and the child key:

```
<parentIdentifier>::child::<childKey>
```

So a parent `order-1001` starting a child with key `item-0` produces the child identifier `order-1001::child::item-0`. Because the derivation is pure, running the parent again addresses that exact child execution, which the engine then memoises rather than re-running.

Supply an explicit identifier only when you need to address the child from outside the parent (for example, to look up its status by a known id):

```ts
await context.runChild("charge", "charge-card", input, {
    workflowIdentifier: "charge-for-order-1001",
});
```

## What "durable" means for a child

A child is durable in the same way any workflow is:

- **Its steps are memoised.** Re-running the parent does not re-run a child's committed steps. If the parent crashes after a child completed step two of three, resuming the parent resumes that child at step three.
- **It survives restarts.** The child's state lives in storage, not in the parent's process memory.
- **It is recorded and linked.** The child's workflow record carries a `parentWorkflowIdentifier`, and the parent emits `CHILD_WORKFLOW_STARTED` and `CHILD_WORKFLOW_COMPLETED` audit events. You can list a parent's children through the [management API](../guides/managing-workflows.md):

```ts
const children = await engine.listWorkflows({
    parentWorkflowIdentifier: "order-1001",
});
```

## Nesting

Children can start their own children. A parent can call a child that calls a grandchild, and each level is durable and memoised independently. There is no special API for nesting; a child workflow's body uses `context.runChild` and `context.startChild` exactly like any other workflow.

## Choosing between a child workflow and a step

| Use a step when…                                           | Use a child workflow when…                                    |
| ---------------------------------------------------------- | ------------------------------------------------------------- |
| The action is a single external call or local computation. | The unit is a multi-step process worth resuming on its own.   |
| It has no identity outside its parent.                     | You want to look it up, cancel it, or audit it independently. |
| You never reuse it elsewhere.                              | The same logic runs under several different parents.          |
| The result feeds straight into the next line.              | You fan out into many concurrent sub-executions.              |

## A complete example

See [`examples/order-processing/src/child-workflows.ts`](https://github.com/) for a runnable example that fans an order out into one child per line item, runs them concurrently, and shows memoisation across a resume.
