---
id: quick-start
title: Quick Start
---

# Quick Start

This page gets a tiny workflow running in about five minutes. We will use the built-in in-memory storage so you do not need a database yet.

## Step 1: Install

Add the core package to your project.

```bash
yarn add @outpost/core
```

Outpost uses decorators, so enable them in your `tsconfig.json`:

```json
{
    "compilerOptions": {
        "experimentalDecorators": true,
        "emitDecoratorMetadata": true
    }
}
```

## Step 2: Create the engine

The engine is the thing that runs your workflows. For now, give it the in-memory storage, which keeps everything in memory. It is perfect for learning and testing.

```ts
import { WorkflowEngine, MemoryStorage } from "@outpost/core";

const storage = new MemoryStorage();
const engine = new WorkflowEngine(storage);
```

## Step 3: Define a workflow

A workflow is a class marked with `@Workflow`. Each durable action is a method marked with `@Step`. The `run` method is where you call the steps in order.

:::note
This guide uses the class-and-decorator style, which is what we recommend. If you prefer plain functions with no decorators, Outpost supports that too, and it behaves identically. See [Functional workflows](../function-style/functional-workflows.md).
:::

```ts
import { Workflow, Step } from "@outpost/core";
import type { WorkflowContext } from "@outpost/core";

@Workflow({ name: "greet-user" })
class GreetUser {
    // Step one: build a greeting.
    @Step()
    async buildGreeting(name: string): Promise<string> {
        return `Hello, ${name}!`;
    }

    // Step two: pretend to send it somewhere.
    @Step()
    async sendGreeting(greeting: string): Promise<void> {
        console.log(greeting);
    }

    // The run method orchestrates the steps.
    async run(context: WorkflowContext, input: { name: string }): Promise<string> {
        const greeting = await this.buildGreeting(input.name);
        await this.sendGreeting(greeting);
        return greeting;
    }
}
```

Notice the step methods take their normal arguments. You call them like ordinary methods; the `@Step` decorator adds the durability.

## Step 4: Run it

Give the run a **workflow identifier**. This is any stable, unique string for this particular run, such as an order number or a user id. It is how Outpost recognizes the same run if you start it again later.

```ts
const result = await engine.run(GreetUser, "user-42", { name: "Sam" });
console.log(result); // "Hello, Sam!"
```

You can also pass an instance you built yourself, which is handy when the workflow needs dependencies: `engine.run(new GreetUser(), "user-42", { name: "Sam" })`.

## What just happened

- You defined a workflow class with two steps.
- Each step's result was saved in storage under the workflow identifier `user-42`.
- If you call `engine.run(GreetUser, "user-42", ...)` again, Outpost sees both steps already finished and returns the saved result **without running them again**.

Try it: call `run` twice and add a `console.log` inside `buildGreeting`. You will see it print only once.

## Next steps

- Learn the vocabulary properly, starting with [Workflows](../concepts/workflows.md) and [Steps](../concepts/steps.md).
- Prefer plain functions over classes? See [Functional workflows](../function-style/functional-workflows.md).
- When you are ready for real persistence, switch `MemoryStorage` for the MySQL adapter. The workflow code does not change.
