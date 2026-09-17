---
id: circuit-breakers
title: "Protecting a dependency with a circuit breaker"
---

# Protecting a dependency with a circuit breaker

When an outside service is down, hammering it with requests makes things worse and slows your app down while every call waits to fail. A **circuit breaker** notices repeated failures and starts failing fast, giving the service room to recover.

## The traffic-light idea

A circuit breaker has three states, like a traffic light:

- **Closed (green)**: calls flow through normally. This is the starting state.
- **Open (red)**: too many calls failed, so new calls are rejected immediately without touching the service.
- **Half-open (amber)**: after a cooldown, one test call is allowed through. If it works, the light turns green. If it fails, it goes back to red.

## Using it

Install the resilience plugin.

```bash
yarn add @outpost/plugin-resilience
```

Create a breaker and attach it to a step as middleware. Here we guard the card charge in our checkout workflow.

```ts
import { Workflow, Step } from "@outpost/core";
import { CircuitBreaker, createCircuitBreakerMiddleware } from "@outpost/plugin-resilience";

const paymentBreaker = new CircuitBreaker({
    name: "payment-provider",
    failureThreshold: 5, // open after 5 failures in a row
    resetTimeoutMilliseconds: 30000, // wait 30 seconds before a test call
});

@Workflow({ name: "create-order-and-notify" })
class CreateOrderAndNotify {
    @Step({
        maxAttempts: 4,
        middleware: [createCircuitBreakerMiddleware(paymentBreaker)],
    })
    async chargeCard(input: OrderInput) {
        return await paymentProvider.charge(input.totalInCents);
    }

    // ... createOrder, notifyWhatsApp, notifyEmail ...
}
```

## Grouping steps behind one breaker

If several steps all call the same service, share **one** breaker between them by passing the same instance to each. In our example the WhatsApp and email notifications go through different providers, so they would each get their own breaker; but if you had, say, an authorize step and a capture step that both hit the payment provider, they should share the payment breaker.

```ts
const paymentMiddleware = [createCircuitBreakerMiddleware(paymentBreaker)];

@Step({ middleware: paymentMiddleware })
async authorize(input: OrderInput) { /* ... */ }

@Step({ middleware: paymentMiddleware })
async capture(input: OrderInput) { /* ... */ }
```

## When the circuit is open

A guarded step whose circuit is open throws a `CircuitOpenError` right away, without calling the service. You can recognize this error and, for example, treat it as a temporary failure worth retrying later.

## A word of caution

This breaker lives in one process. It reflects what a single process has seen, not the whole fleet. That is usually fine and keeps things simple. Just do not read it as a fleet-wide health signal.
