---
id: alerts
title: "Sending alerts when things go wrong"
---

# Sending alerts when things go wrong

When a workflow fails for good, someone usually needs to know. The alerts plugin lets you send a notification to one or more places (a webhook, a chat channel, a pager) without tying your core logic to any particular service.

## The pieces

- An **alert** is a plain description of an incident: how serious it is, a title, a message, and some context.
- A **destination** is somewhere an alert can be delivered, such as a webhook.
- The **dispatcher** sends one alert to all your destinations.

## Setting it up

Install the plugin.

```bash
yarn add @outpost/plugin-alerts
```

Create a dispatcher with a destination.

```ts
import { AlertDispatcher, AlertSeverity, WebhookDestination } from "@outpost/plugin-alerts";

const alerts = new AlertDispatcher([
    new WebhookDestination({ url: "https://hooks.example.com/incidents" }),
]);
```

## Sending an alert

```ts
await alerts.dispatch({
    severity: AlertSeverity.CRITICAL,
    title: "Checkout workflow failed",
    message: "Order order-1001 could not be created and confirmed after all retries.",
    workflowIdentifier: "order-1001",
    occurredAt: new Date(),
});
```

A natural place to send this alert is when the checkout workflow fails for good. For example, in the queue consumer that runs the `create-order-and-notify` workflow, dispatch an alert from the failure handler so someone is paged when an order cannot be completed.

## Failures never break your app

This is an important promise: **a failing alert never disrupts your workflows.** If a destination is unreachable, the dispatcher catches the error, still delivers to the other destinations, and reports the failure through a callback you can watch:

```ts
const alerts = new AlertDispatcher(destinations, {
    onDeliveryError: (outcome) => {
        console.error("Could not deliver alert to", outcome.destinationName, outcome.error);
    },
});
```

The `dispatch` call itself never throws. Sending an alert is best-effort by design, because losing an alert should never mean losing a workflow.

## Writing your own destination

A destination is anything with a `name` and a `deliver` method. To send to Slack, PagerDuty, or an internal system, shape the alert into that service's format and post it.

```ts
const slackDestination = {
    name: "slack",
    async deliver(alert) {
        await fetch(process.env.SLACK_WEBHOOK_URL, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: `${alert.title}: ${alert.message}` }),
        });
    },
};
```

Pass it to the dispatcher alongside any others.
