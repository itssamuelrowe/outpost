---
id: introduction
title: Introduction
slug: /
---

# Welcome to Outpost

Outpost is a small library that helps your program **finish what it started**, even when things go wrong.

Imagine a checkout that creates an order, charges the customer's card, then sends a WhatsApp and an email confirmation. Halfway through, the server restarts. Without help, you are left guessing: did the card get charged? Did the order get created? Did the WhatsApp message go out? Should you try again and risk doing any of it twice?

Outpost takes that guesswork away. You write your steps once, and Outpost remembers which steps already finished. If your program stops and starts again, it picks up exactly where it left off, and it never repeats a step that already completed.

## What makes Outpost different

There are big, powerful systems for this kind of thing. They are great, but they usually need their own servers to run and a lot of setup, and they ask you to write workflow code under strict replay rules. Outpost is deliberately small and stays out of your way.

- **It runs inside your app.** There is no separate server, daemon, or cluster to operate. You add a library, and your own database is the coordination point. The first release ships a MySQL adapter, and there is an in-memory adapter so you can try everything with nothing installed.
- **It is ordinary code, not a replay engine.** You write a `run` method with normal `if`s and loops, and mark the durable actions with `@Step`. On recovery Outpost re-runs that method and hands back the saved results of the steps that already finished. There is no event log to reason about and no ban on `Date.now()` in your workflow body. Prefer plain functions? The [functional style](./function-style/functional-workflows.md) does the same thing without decorators.
- **It faces the "did that actually happen?" problem head on.** When an API call times out or returns a 500, the write may or may not have landed. Outpost marks that step *ambiguous* and, on recovery, runs a **probe** you supply (for example, "search the provider for an order tagged with this id") before it ever retries. If the probe finds the effect already happened, the step is not repeated. If it cannot tell, the step is parked for review rather than guessed. See [Ambiguous state and probes](./concepts/ambiguous-state-and-probes.md).
- **Waiting and scheduling are durable too.** A workflow can [sleep](./scheduling/durable-sleep.md) for two hours (the process can exit and resume elsewhere), run on a [recurring schedule](./scheduling/durable-cron.md) that survives restarts, [retry with backoff](./concepts/retries-and-backoff.md), and start [child workflows](./concepts/child-workflows.md), all persisted, none of it held in memory.
- **You can test failures on purpose.** Recovery code is the least-tested code you own. Outpost lets you inject crashes, transient errors, and lease expiry deterministically, so you prove your recovery paths work before a real outage exercises them. See [Chaos testing](./concepts/chaos-testing.md).

## Who is this for

Outpost is a good fit if you recognise yourself in any of these:

- **You run multi-step processes across systems.** A checkout that charges Stripe, creates a Shopify order, and emails a receipt. An onboarding that provisions an account, seeds data, and notifies a CRM. A billing run that meters usage and invoices. When any step can fail independently, you need to finish the sequence correctly, once each.
- **You have been bitten by an ambiguous failure.** A payment or order API returned a 5xx, your queue redelivered the message, and you ended up with a double charge or a duplicate order. This is the exact case Outpost is built to close.
- **Your process has to wait, or run on a schedule.** "Hold for two hours, then ship." "Send a reminder tomorrow." "Roll up usage every hour." A durable sleep or cron beats a hand-rolled timer table that forgets state on restart.
- **You want durability without new infrastructure.** You already run a database and would rather add a library than stand up and operate an orchestration cluster.

If that sounds like you, the [Quick Start](./getting-started/quick-start.md) will get you running in a few minutes. If you are new to the idea, start with [What is durable execution?](./getting-started/what-is-durable-execution.md). If your writes are already safe and you are wondering what a durable engine adds, see [What you get beyond safe writes](./getting-started/beyond-safe-writes.md). And if you are not yet sure Outpost is worth it, read the honest checklist in [Do you even need this?](./getting-started/do-you-need-this.md).
