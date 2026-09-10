---
id: retries-and-backoff
title: Retries and backoff
---

# Retries and backoff

Sometimes a step fails for a reason that will pass on its own, like a brief network glitch. Trying again a moment later often works. This is called a **retry**.

We will use one running example: a checkout workflow that creates an order, charges the card, and then sends a WhatsApp and an email confirmation.

## Turning on retries

By default a step runs once. To allow more attempts, set `maxAttempts` in the `@Step` decorator.

```ts
@Step({ maxAttempts: 5 })
async notifyWhatsApp(input: OrderInput): Promise<void> {
  await whatsApp.sendMessage(input.customerPhone, `Order ${input.orderId} confirmed!`);
}
```

Now the WhatsApp step may run up to five times before giving up. This is a good fit for notifications, which often fail briefly and then recover.

## Why wait between attempts?

If a service is briefly overloaded and every client retries instantly, they all pile back on at once and keep it overloaded. So we wait a little longer before each attempt. This growing wait is called **exponential backoff**.

With a base of one second and a doubling factor, the waits grow like this:

- After attempt 1 fails: wait about 1 second.
- After attempt 2 fails: wait about 2 seconds.
- After attempt 3 fails: wait about 4 seconds.

You can configure it:

```ts
@Step({
  maxAttempts: 5,
  backoff: {
    baseMilliseconds: 1000, // start at one second
    maximumMilliseconds: 30000, // never wait more than 30 seconds
    factor: 2, // double each time
  },
})
async notifyEmail(input: OrderInput): Promise<void> {
  await email.send(input.customerEmail, "Your order is confirmed", `Order ${input.orderId}`);
}
```

## Jitter: adding a little randomness

Even with backoff, many clients that failed together might retry at the same moment. To spread them out, Outpost adds **jitter**: it picks a random wait between zero and the computed delay. This is on by default. You rarely need to change it.

## What happens when attempts run out?

If a step uses up all its attempts, it fails for good. What happens next depends on whether the step is required:

- A normal (required) step failing stops the workflow and reports the error. You would want this for `chargeCard`: if payment cannot go through, there is no order to confirm.
- An **optional** step can fail without stopping the workflow. You give it a fallback value to use instead. This can be a good fit for a non-critical enrichment step:

```ts
@Step({
  optional: true,
  fallbackValue: { score: 0, status: "UNVERIFIED" },
})
async fraudCheck(input: OrderInput): Promise<{ score: number; status: string }> {
  return await fraudService.score(input);
}
```

If the fraud check keeps failing, the workflow continues with the fallback rather than stopping the whole order.

## A note on timing

Retries are not busy-waiting. When a step schedules a retry, Outpost records a timer in the database. The scheduler wakes the workflow when the wait is over, even if the original process has since restarted.

Next: the most important idea for real-world reliability, [Ambiguous state and probes](./ambiguous-state-and-probes.md).
