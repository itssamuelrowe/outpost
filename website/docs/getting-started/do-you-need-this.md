---
id: do-you-need-this
title: Do you even need this?
---

# Do you even need this?

Outpost is useful, but it is not free: it adds a library, a database table set, and a new way of thinking. Before you adopt it, it is worth checking whether a simpler tool already solves your problem. We would rather you skip Outpost than add it where it earns nothing.

Two simpler tools cover a lot of ground. Let's see where they are enough, and where they run out.

## Tool 1: Idempotency keys

An **idempotency key** is a unique value you attach to a request so the receiver can recognize a repeat and avoid doing the work twice. Many payment providers support this. If you retry the same charge with the same key, you are charged once.

This is perfect when your problem is **one call to one service that must happen once**.

Where it runs out: an idempotency key makes a single call safe to repeat, but it does not **remember how far you got** in a longer process. If your program does five things and crashes after the third, the key on the second call cannot tell the next run "steps one to three are done, start at four." You would still have to build that progress tracking yourself, which is most of what Outpost is.

## Tool 2: Database transactions

A **transaction** lets you group several database changes so they all succeed or all undo together (a **rollback**). If anything fails partway, the database puts everything back as if nothing happened.

This is perfect when all your changes live in **one database**.

Where it runs out: a transaction can only undo things inside that one database. The moment your process reaches out to other systems, the guarantee is gone. You cannot wrap "charge Stripe, create a Shopify order, send an email" in a single rollback. Stripe and Shopify do not take part in your database's transaction. If the email fails, the database can roll back its own rows, but the Stripe charge has already happened.

## So when do you actually need durable execution?

You need it when **finishing a multi-step process correctly, across time and failures, is the hard part.** Signs that this is you:

- Your process has several steps that each must happen exactly once.
- The steps touch more than one system (a payment provider, a shipping API, your database, an email service).
- You need to survive crashes and restarts and pick up where you left off.
- There are waits in the middle (for example, "hold for two hours, then ship").
- You have hit the "did that actually happen?" problem, where a service failed but may have already done the work.

If several of these are true, you are otherwise going to hand-write a fragile progress tracker, a retry loop, and a recovery routine. That is exactly what Outpost provides, tested and ready.

## If idempotency keys and transaction rollback solve it, why durable execution?

This is the most common objection, so let's answer it with a single concrete example and watch the simpler tools run out one at a time.

**The task:** when a customer checks out, we must

1. create the order in our database,
2. charge their card at a payment provider,
3. send a WhatsApp message confirming the order,
4. send a confirmation email.

### Attempt 1: one transaction

Your first instinct is a database transaction around all four steps, so if anything fails, everything rolls back.

```ts
await database.transaction(async (trx) => {
  await createOrder(trx, input);
  await paymentProvider.charge(input.total); // not part of trx!
  await whatsapp.send(input.phone, "Your order is confirmed");
  await email.send(input.email, "Your order is confirmed");
});
```

The problem: only `createOrder` is inside the transaction. The card charge, the WhatsApp message, and the email happen at other companies. If the email step throws, `ROLLBACK` erases the order row, but the customer has already been **charged** and has already received a **WhatsApp message** saying their order is confirmed. The rollback made things worse: now there is money taken and a confirmation for an order that no longer exists.

A transaction cannot undo an action at a company that never joined the transaction. That is the ceiling of rollback.

### Attempt 2: add idempotency keys

"Fine," you say, "I will make each call idempotent and just retry the whole thing on failure." So you attach an idempotency key to the charge, and you retry the function from the top when it fails.

```ts
async function checkout(input) {
  await createOrder(input);
  await paymentProvider.charge(input.total, { idempotencyKey: input.orderId });
  await whatsapp.send(input.phone, "Your order is confirmed");
  await email.send(input.email, "Your order is confirmed");
}
```

Now imagine the WhatsApp step fails and the whole function retries from the top. The charge is safe (the idempotency key prevents a double charge). But:

- `createOrder` runs again. Unless you also made it idempotent, you get a duplicate order.
- The WhatsApp message might have actually been sent before the error (an ambiguous failure). Retrying sends a **second** WhatsApp message.
- The customer now has two "order confirmed" messages, and maybe two orders.

Idempotency keys made **one** call safe. They did nothing to remember that step 1 and step 2 already succeeded, so the retry redoes them. You would have to add a key and a "did this already run?" check to every single step by hand. At that point you are building a progress tracker, which is most of what durable execution is.

### A real incident: the container restarts mid-call

Before the next attempt, here is a concrete failure we have actually seen, because it shows why this is not a theoretical worry.

A consumer picks up a checkout message and calls the Shopify API to create the order. **While that API call is in flight, the container restarts.** Maybe a deployment rolled out, maybe the orchestrator moved the pod. The process is gone before it ever learns whether Shopify created the order.

The message was never acknowledged, so the queue redelivers it. A fresh container picks it up and calls Shopify again. If the first call had in fact created the order, the customer now has **two** orders. The restart turned one intent into two side effects, and nothing in the code noticed.

### Attempt 3: remember the API calls in a table

A reasonable next idea: keep our own record of which external calls we have made, so we can check before calling again. Combine that with an idempotency key and a transaction.

```ts
async function createOrderOnce(input: OrderInput) {
  const callKey = `shopify-create-order:${input.orderId}`;

  // Have we already recorded that this call was made?
  const existing = await database.query(
    "SELECT externalId FROM externalCalls WHERE callKey = ?",
    [callKey],
  );
  if (existing) {
    return existing.externalId; // already done; do not call again
  }

  // Make the call with an idempotency key as a second line of defence.
  const order = await shopify.createOrder(input, { idempotencyKey: callKey });

  // Record that it happened, in a transaction with any local changes.
  await database.transaction(async (trx) => {
    await trx.insert("externalCalls", { callKey, externalId: order.id });
    await trx.update("orders", { status: "created" });
  });

  return order.id;
}
```

This is genuinely better, and it is worth understanding **why**, because it is exactly what durable execution automates. But look closely at the gap that remains.

The dangerous window is **between the API call returning and the row being written.** Trace the restart again: we call Shopify, Shopify creates the order and returns, and then the container restarts *before* the `externalCalls` row is committed. On redelivery we check the table, find nothing, and call Shopify a second time. Duplicate order, despite all our care. The idempotency key saves us **only if Shopify honours one for order creation**, which many storefront setups do not.

You can shrink that window, but you cannot close it by hand for every call, in every workflow, forever. And notice what you have built: a table that remembers which steps ran, a check before each step, and a recovery path on redelivery. That is a durable execution engine, written by hand, one call at a time. This is the point where adopting one pays off.

### Attempt 4: durable execution

With Outpost, each step is recorded the moment it finishes. A retry does not start from the top; it resumes at the first unfinished step.

```ts
@Workflow({ name: "checkout" })
class Checkout {
  @Step()
  async createOrder(input: OrderInput) {
    return await orders.create(input);
  }

  @Step({ maxAttempts: 4 })
  async chargeCard(input: OrderInput) {
    return await paymentProvider.charge(input.total);
  }

  @Step({ maxAttempts: 5 })
  async notifyWhatsApp(input: OrderInput) {
    return await whatsapp.send(input.phone, "Your order is confirmed");
  }

  @Step({ maxAttempts: 5 })
  async notifyEmail(input: OrderInput) {
    return await email.send(input.email, "Your order is confirmed");
  }

  async run(context: WorkflowContext, input: OrderInput) {
    await this.createOrder(input);
    await this.chargeCard(input);
    await this.notifyWhatsApp(input);
    await this.notifyEmail(input);
  }
}
```

Now trace the same failure. WhatsApp fails on the first run. Outpost has already saved that `createOrder` and `chargeCard` finished. When the workflow resumes:

- `createOrder` is skipped (saved). No duplicate order.
- `chargeCard` is skipped (saved). No double charge, without you even needing an idempotency key here.
- `notifyWhatsApp` runs again, and only it.
- `notifyEmail` runs after it succeeds.

The customer gets exactly one order, one charge, one WhatsApp message, and one email, even though the process ran twice.

### What about the in-flight restart from earlier?

Being honest: the same dangerous window from Attempt 3 still exists at the boundary of a single step. If the container restarts **while `createOrder` is calling Shopify**, before the result is committed, a resume will re-run `createOrder`. Outpost does not make that window vanish; no library can, because the information lives at Shopify.

What Outpost does is give you one clear, tested place to handle it: the step is recorded as [ambiguous](../concepts/ambiguous-state-and-probes.md), and on resume its **probe** runs first to ask Shopify "does this order already exist?" If yes, the step completes without calling create again. So the difference from the hand-rolled version is not magic. It is that the recovery logic is a first-class, reusable feature instead of something you reinvent per call. See [Ambiguous state and probes](../concepts/ambiguous-state-and-probes.md) for how the probe works in full.

### The point

Idempotency keys and transactions are about making **one action** safe. Durable execution is about making a **sequence of actions across different systems** finish correctly, once each, even through crashes and retries. In fact Outpost happily uses the simpler tools inside itself: a step's [probe](../concepts/ambiguous-state-and-probes.md) often relies on an idempotency key or a lookup to decide whether an ambiguous action already happened. Durable execution does not replace those tools; it orchestrates them across the whole job.

## The honest summary

| Your situation | Best tool |
| --- | --- |
| One call to one service, safe to repeat | Idempotency key |
| Several changes in one database, all-or-nothing | A transaction |
| Several steps, across systems, surviving crashes and waits | Durable execution (Outpost) |

Notice that the simpler tools do not disappear when you use Outpost. Idempotency keys, for instance, become an ingredient: Outpost uses them inside a [probe](../concepts/ambiguous-state-and-probes.md) to check whether a step already happened. Outpost does not replace these tools; it coordinates them across the whole process.

If your problem really is a single idempotent call in a single transaction, use those and move on. If "did we finish, and how far did we get?" is a question your code keeps having to answer, read on.
