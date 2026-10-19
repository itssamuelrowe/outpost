---
id: what-is-durable-execution
title: What is durable execution?
---

# What is durable execution?

Let's build up the idea with a simple story.

## The problem

Suppose a customer checks out. Your app does four things in order:

1. Create the order.
2. Charge the customer's card.
3. Send a WhatsApp confirmation.
4. Send an email confirmation.

Now imagine your server crashes right after step 2. When it restarts, how does it know the card was already charged? If it simply starts over, it charges the customer **again**. That is the problem.

## The idea

**Durable execution** means the system writes down what it has done, step by step, in a place that survives a crash (a database). Each time it is about to do a step, it first checks: "Have I already done this?" If yes, it skips it and uses the result it saved earlier. If no, it does the step and saves the result.

Because the record lives in the database, it survives restarts. So the checkout becomes:

1. Create the order, then **save "order created"**.
2. Charge the card, then **save "card charged"**.
3. Send WhatsApp, then **save "WhatsApp sent"**.
4. Send email, then **save "email sent"**.

If the server crashes after step 2 and restarts, it sees "order created" and "card charged" are already saved, skips them, and continues from the WhatsApp step. No double charge, no duplicate order.

## Some words you will see

Here are the few terms Outpost uses, in plain language:

- **Workflow**: the whole process, start to finish. "Check out an order" is a workflow.
- **Step**: one durable action inside a workflow. "Charge the card" is a step.
- **Memoization**: a long word for "remembering a step's result so it is not done twice."
- **Retry**: trying a step again after it fails.
- **Lease**: a short-lived "I am working on this" claim, so two workers do not do the same step at the same time.

You do not need to memorize these. Each one is explained again, with examples, when it first matters.

## What durable execution does not promise

Outpost cannot make an outside service (like a payment provider) magically do something exactly once. What it can do is remember your progress and, for the tricky cases, check with the outside service before trying again. The [Ambiguous state and probes](../concepts/ambiguous-state-and-probes.md) page explains how.

Next: try it yourself in the [Quick Start](./quick-start.md).
