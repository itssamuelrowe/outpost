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

There are big, powerful systems for this kind of thing. They are great, but they usually need their own servers to run and a lot of setup. Outpost is deliberately small:

- **It runs inside your app.** There is no separate server to install or operate.
- **It uses a database you already have.** The first release supports MySQL.
- **It is honest about the hard cases.** When the outcome of a step is truly unknown, Outpost does not guess. It checks, and if it still cannot tell, it asks a human.
- **It lets you test failures on purpose.** The framework allows you to perform chaos testing by hooking into and breaking steps, so you can prove your recovery paths work before a real outage exercises them. See [Chaos testing](./concepts/chaos-testing.md).

## Who is this for

Outpost fits teams that:

- Run multi-step processes like checkout, onboarding, or billing.
- Already use MySQL and do not want to add new infrastructure.
- Have run into the "did that actually happen?" problem with an external service.

If that sounds like you, the [Quick Start](./getting-started/quick-start.md) will get you running in a few minutes. If you are new to the idea, start with [What is durable execution?](./getting-started/what-is-durable-execution.md). And if you are not yet sure Outpost is worth it, read the honest checklist in [Do you even need this?](./getting-started/do-you-need-this.md).
