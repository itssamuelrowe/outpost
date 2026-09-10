---
id: workflows
title: Workflows
---

# Workflows

A **workflow** is a process from beginning to end, such as a checkout, an onboarding, or a billing run. In Outpost you write a workflow as a class marked with `@Workflow`, and give it a name.

```ts
import { Workflow, Step } from "@outpost/core";
import type { WorkflowContext } from "@outpost/core";

@Workflow({ name: "process-order" })
class ProcessOrder {
  async run(context: WorkflowContext, input: OrderInput) {
    // ... steps go here ...
  }
}
```

Think of the class as a recipe. Defining it does not cook anything; you cook when you call `run`.

## The `run` method

Every workflow has a `run` method. It receives the workflow context and the input, and it orchestrates the workflow's [steps](./steps.md) in order. Its return value becomes the workflow's final output.

```ts
async run(context: WorkflowContext, input: OrderInput) {
  const payment = await this.chargeCard(input.total);
  const shipment = await this.shipOrder(input.items);
  return { paymentId: payment.id, trackingNumber: shipment.tracking };
}
```

The `run` method is ordinary code, but it re-executes from the top whenever a workflow resumes. That has important consequences for how you write the logic around your steps. See [Writing deterministic steps](./writing-deterministic-steps.md).

## Starting a workflow

You start a workflow by calling `engine.run` with the workflow, a **workflow identifier**, and the input.

```ts
await engine.run(ProcessOrder, "order-1001", { total: 5000, items: ["A", "B"] });
```

The identifier (`"order-1001"`) uniquely names this one execution. Use something natural from your domain, such as the order number. It is how Outpost recognizes the same run if it is started again later, which is exactly what makes crash recovery and memoization work.

## Passing a class or an instance

You can hand `run` either the class itself or an instance you built. Passing an instance is how you give a workflow its dependencies.

```ts
// Outpost builds the instance for you.
await engine.run(ProcessOrder, "order-1001", input);

// Or build it yourself and inject what it needs.
await engine.run(new ProcessOrder(paymentClient, warehouseClient), "order-1001", input);
```

## Workflow input and output

The input you pass and the output `run` returns are both **persisted**, so they must be serializable: numbers, strings, booleans, `null`, arrays, and plain objects made of those. Avoid values that cannot be faithfully saved, such as a `Date`, a `Map`, or a class instance. (Steps follow the same rule for their results; see [Steps](./steps.md#what-a-step-can-return).)

Input and output use a slightly looser type than step results so that ordinary `interface` declarations work without changes. If you enable the engine's `validateSerializable` option, the values are also checked at run time.

## A complete example

```ts
@Workflow({ name: "process-order" })
class ProcessOrder {
  @Step()
  async chargeCard(total: number): Promise<{ id: string }> {
    return await paymentProvider.charge(total);
  }

  @Step()
  async shipOrder(items: string[]): Promise<{ tracking: string }> {
    return await warehouse.ship(items);
  }

  async run(context: WorkflowContext, input: OrderInput) {
    const payment = await this.chargeCard(input.total);
    const shipment = await this.shipOrder(input.items);
    return { paymentId: payment.id, trackingNumber: shipment.tracking };
  }
}
```

If the process crashes after `chargeCard` but before `shipOrder`, restarting the run skips the charge (its result is already saved) and continues straight to shipping. The customer is charged once. To understand exactly how that recovery works, read the [Workflow lifecycle](./workflow-lifecycle.md).

## Prefer plain functions?

If you would rather not use classes, Outpost has an equivalent [functional style](./functional-style.md). It behaves identically; choose whichever reads better for you.

Next: the building block of every workflow, the [Step](./steps.md).
