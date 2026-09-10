---
id: ambiguous-state-and-probes
title: Ambiguous state and probes
---

# Ambiguous state and probes

This is the idea at the heart of Outpost, so we will go slowly and use our running example: the checkout that creates an order, charges the card, and sends a WhatsApp and email confirmation.

## The "did it actually happen?" problem

Your workflow calls the WhatsApp provider to send the confirmation. The provider sends the message, but while replying to you, the connection times out and you get an error instead of a success.

From your side, all you saw was an error. But the message **was** sent. If you simply retry, you send a **second** WhatsApp message. If you give up, you might mark the notification as failed when it actually reached the customer. Neither is quite right.

We call this an **ambiguous** outcome: the step failed, but its real-world effect may or may not have happened. The same thing can happen when creating the order on an external commerce platform, or charging a card: the write succeeds, then a `500` or a timeout hides the result from you.

## How Outpost thinks about failures

Outpost sorts failures into two kinds:

- **Definite**: the effect certainly did not happen. Safe to retry. Example: the request was rejected before it did anything.
- **Ambiguous**: the effect may have happened. Not safe to blindly retry. Example: a timeout, or a `5xx` response.

You tell Outpost which is which with a **classifier**. In the class style, the neatest way is a method named `classifyErrorFor<StepName>`, which Outpost discovers automatically. For a step method `notifyWhatsApp`, that is `classifyErrorForNotifyWhatsApp`:

```ts
import { FailureKind } from "@outpost/core";

classifyErrorForNotifyWhatsApp(error: unknown): FailureKind {
  const message = error instanceof Error ? error.message : String(error);
  // Treat timeouts and 5xx responses as ambiguous.
  return /timeout|5\d\d/i.test(message) ? FailureKind.AMBIGUOUS : FailureKind.DEFINITE;
}
```

You can also pass `classifyError` inline in `@Step({ ... })`, or use `@ClassifyError("notifyWhatsApp")` on a differently named method. The convention is just the zero-configuration default.

## The probe: checking before acting

When a step failed ambiguously, Outpost does not guess on the next attempt. Instead, it calls a function you provide called a **probe**. The probe's only job is to answer one question: **did the effect already happen?**

- If the probe returns a value, the effect happened. Outpost records that value as the step's result and does **not** run the step again.
- If the probe returns `null`, the effect did not happen. Outpost runs the step normally.

Here it is on the WhatsApp step. Like the classifier, the probe is discovered by convention: for step `notifyWhatsApp`, name the probe method `probeNotifyWhatsApp`. It sits right next to the step and shares the same `this`, so it can use the same injected clients.

```ts
@Step({ maxAttempts: 5 })
async notifyWhatsApp(input: OrderInput): Promise<{ sent: true }> {
  await this.whatsApp.sendMessage(input.customerPhone, `Order ${input.orderId} confirmed!`, {
    reference: this.messageReference,
  });
  return { sent: true };
}

// Discovered automatically as the probe for `notifyWhatsApp`.
async probeNotifyWhatsApp(): Promise<{ sent: true } | null> {
  const alreadySent = await this.whatsApp.wasDelivered(this.messageReference);
  return alreadySent ? { sent: true } : null; // value means "it happened"; null means "it did not"
}
```

You can optionally add `@Probe()` above `probeNotifyWhatsApp` as a visible marker that it belongs to the workflow; with no argument, the step it serves is inferred from the name. If you prefer a different method name, pass the step: `@Probe("notifyWhatsApp")`. You can also keep the probe inline in `@Step({ probe })`.

## How to make a good probe

A probe needs a way to recognize the effect. The reliable pattern is:

1. Attach an identifier **you** choose to the request (a "correlation id" or reference), for example `order-<id>-whatsapp`.
2. In the probe, ask the outside service whether something with that identifier exists.

If you find it, the effect happened. If you do not, it did not.

## When Outpost cannot tell

If a step is ambiguous and you did **not** provide a probe, Outpost refuses to guess. It marks the step as **needs review** and stops, so a person can decide. This is deliberate: a silent wrong guess is worse than a clear stop.

For a notification, you might decide the opposite trade-off is fine: a rare duplicate WhatsApp is not harmful, so you skip the probe and accept an occasional repeat. For a **charge** or an **order**, always prefer a probe or a provider-side idempotency key.

## A probe is not a freshness check

It is worth drawing one boundary clearly. A probe answers *"did this side effect already happen?"* after an ambiguous failure. It does not answer *"is the value this step produced still valid?"*. Those are different questions. A step that returns a payment link succeeded, so it is `COMPLETED`, not `AMBIGUOUS`, and its probe never runs, yet the link can still expire while the workflow waits. That problem is handled by workflow structure, not by a probe. See [Time-sensitive resources](./expirable-resources.md).

## Why this matters

Most libraries just say "make your operations idempotent" and leave the rest to you. Outpost gives you a specific, testable place to solve the ambiguous case: the probe.
