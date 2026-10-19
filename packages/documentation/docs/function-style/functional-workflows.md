---
id: functional-workflows
title: Functional workflows
---

# Functional workflows

Throughout these docs we write workflows as classes with decorators, because it keeps a workflow's steps and their settings neatly together. But some people prefer plain functions, with no decorators at all. Outpost supports both, and they behave identically: the class style is just a thin wrapper over the functional style described here. Pick whichever reads better to you.

Scheduling functional workflows on a recurring basis works the same way; see [Functional durable cron](./durable-cron.md).

## Defining a workflow as a function

Instead of a class, you register a named function with `defineWorkflow`. Inside it, wrap each durable action in `context.step(...)`. Here is the checkout example (create order, charge card, notify by WhatsApp and email) in functional form.

```ts
engine.defineWorkflow("create-order-and-notify", async (context, input) => {
    await context.step("create-order", async () => orders.create(input));

    await context.step("charge-card", async () => paymentProvider.charge(input.totalInCents), {
        maxAttempts: 4,
    });

    await context.step(
        "notify-whatsapp",
        async () => whatsApp.sendMessage(input.customerPhone, `Order ${input.orderId} confirmed!`),
        { maxAttempts: 5 },
    );

    await context.step(
        "notify-email",
        async () =>
            email.send(input.customerEmail, "Your order is confirmed", `Order ${input.orderId}`),
        { maxAttempts: 5 },
    );

    return { orderId: input.orderId };
});
```

## Running it

Because the workflow was registered by name, you run it by name.

```ts
await engine.run("create-order-and-notify", input.orderId, input);
```

## How the two styles line up

Everything you can express with decorators has a direct functional equivalent:

| Class style                                            | Functional style                                             |
| ------------------------------------------------------ | ------------------------------------------------------------ |
| `@Workflow({ name: "create-order-and-notify" })` class | `engine.defineWorkflow("create-order-and-notify", ...)`      |
| `@Step()` method `chargeCard`                          | `context.step("chargeCard", fn)`                             |
| `@Step({ id: "charge-card" })`                         | `context.step("charge-card", fn)`                            |
| `@Step({ maxAttempts: 3, probe })`                     | `context.step("charge-card", fn, { maxAttempts: 3, probe })` |
| `run(TheClass, id, input)`                             | `run("create-order-and-notify", id, input)`                  |

## Passing step options

The third argument to `context.step` is the same options object the `@Step` decorator accepts: `maxAttempts`, `backoff`, `optional`, `fallbackValue`, `classifyError`, `probe`, and per-step `middleware`.

```ts
await context.step(
    "notify-whatsapp",
    async () => whatsApp.sendMessage(input.customerPhone, `Order ${input.orderId} confirmed!`),
    {
        maxAttempts: 5,
        classifyError,
        probe: async () =>
            (await whatsApp.wasDelivered(messageReference)) ? { sent: true } : null,
    },
);
```

Whichever style you choose, the durability, retries, leasing, and probe behaviour are exactly the same, because it is the same engine underneath.
