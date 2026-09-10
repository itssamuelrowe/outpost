import { describe, expect, it } from "vitest";

import {
  ClassifyError,
  Probe,
  Step,
  Workflow,
} from "../src/decorators/workflow.decorator.js";
import { FailureKind } from "../src/enums/failure-kind.enum.js";
import { StepStatus } from "../src/enums/step-status.enum.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";
import type { WorkflowContext } from "../src/interfaces/workflow-context.interface.js";

function createFixedClock(): () => Date {
  const instant = new Date("2024-01-01T00:00:00.000Z");
  return () => instant;
}

function classifyHttpError(error: unknown): FailureKind {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|5\d\d/i.test(message) ? FailureKind.AMBIGUOUS : FailureKind.DEFINITE;
}

describe("decorator-based authoring", () => {
  it("runs a workflow passed as a class and memoizes its steps", async () => {
    const executionCounts = { double: 0 };

    @Workflow({ name: "multiplier" })
    class Multiplier {
      // Step methods take their own arguments; durability is added by the
      // decorator, so no context parameter is required.
      @Step()
      async double(value: number): Promise<number> {
        executionCounts.double += 1;
        return value * 2;
      }

      async run(_context: WorkflowContext, input: { value: number }): Promise<number> {
        return this.double(input.value);
      }
    }

    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, { now: createFixedClock() });

    const first = await engine.run<{ value: number }, number>(Multiplier, "workflow-1", {
      value: 21,
    });
    const second = await engine.run<{ value: number }, number>(Multiplier, "workflow-1", {
      value: 21,
    });

    expect(first).toBe(42);
    expect(second).toBe(42);
    // The step ran once; the second run returned the memoized result.
    expect(executionCounts.double).toBe(1);
    expect(storage.getStep("workflow-1", "double")?.status).toBe(StepStatus.COMPLETED);
  });

  it("runs a workflow passed as an instance with injected dependencies", async () => {
    // A dependency the workflow needs, supplied through the constructor.
    class GreetingService {
      public greet(name: string): string {
        return `Hello, ${name}!`;
      }
    }

    @Workflow({ name: "greeter" })
    class Greeter {
      public constructor(private readonly greetingService: GreetingService) {}

      @Step({ id: "compose-greeting" })
      async compose(name: string): Promise<string> {
        // The injected dependency is available on `this`.
        return this.greetingService.greet(name);
      }

      async run(_context: WorkflowContext, input: { name: string }): Promise<string> {
        return this.compose(input.name);
      }
    }

    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, { now: createFixedClock() });

    const output = await engine.run<{ name: string }, string>(
      new Greeter(new GreetingService()),
      "workflow-1",
      { name: "Sam" },
    );

    expect(output).toBe("Hello, Sam!");
    // The custom step id from the decorator is used as the durable step key.
    expect(storage.getStep("workflow-1", "compose-greeting")?.status).toBe(StepStatus.COMPLETED);
  });

  it("honours step options such as retries from the decorator", async () => {
    const attempts = { charge: 0 };

    @Workflow()
    class Payment {
      @Step({ maxAttempts: 2 })
      async charge(): Promise<string> {
        attempts.charge += 1;
        throw new Error("temporary failure");
      }

      async run(_context: WorkflowContext): Promise<string> {
        return this.charge();
      }
    }

    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
    });

    // First run schedules a retry; second run exhausts the attempts.
    await expect(engine.run(Payment, "workflow-1", null)).rejects.toThrow();
    await expect(engine.run(Payment, "workflow-1", null)).rejects.toThrow();
    expect(attempts.charge).toBe(2);
  });

  it("resolves an ambiguous step through a probe declared in the decorator", async () => {
    const state = { executions: 0, sideEffectOccurred: false };

    @Workflow({ name: "shopify" })
    class CreateOrder {
      @Step({
        maxAttempts: 2,
        classifyError: classifyHttpError,
        // The probe reports whether the order already exists.
        probe: async () => (state.sideEffectOccurred ? { orderIdentifier: "SHOP-1" } : null),
      })
      async createOrder(): Promise<{ orderIdentifier: string }> {
        state.executions += 1;
        state.sideEffectOccurred = true;
        throw new Error("503 Service Unavailable");
      }

      async run(_context: WorkflowContext): Promise<{ orderIdentifier: string }> {
        return this.createOrder();
      }
    }

    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
    });

    await expect(engine.run(CreateOrder, "workflow-1", null)).rejects.toThrow();
    expect(storage.getStep("workflow-1", "createOrder")?.status).toBe(StepStatus.AMBIGUOUS);

    const output = await engine.run<null, { orderIdentifier: string }>(
      CreateOrder,
      "workflow-1",
      null,
    );
    expect(output).toEqual({ orderIdentifier: "SHOP-1" });
    // The probe resolved it; the step body never ran a second time.
    expect(state.executions).toBe(1);
  });

  it("discovers a probe and classifier by naming convention", async () => {
    const state = { executions: 0, sideEffectOccurred: false };

    @Workflow({ name: "shopify-convention" })
    class CreateOrder {
      @Step({ maxAttempts: 2 })
      async createOrder(): Promise<{ orderIdentifier: string }> {
        state.executions += 1;
        state.sideEffectOccurred = true;
        throw new Error("503 Service Unavailable");
      }

      // Discovered automatically as the classifier for `createOrder`.
      classifyErrorForCreateOrder(error: unknown): FailureKind {
        return classifyHttpError(error);
      }

      // Discovered automatically as the probe for `createOrder`.
      async probeCreateOrder(): Promise<{ orderIdentifier: string } | null> {
        return state.sideEffectOccurred ? { orderIdentifier: "SHOP-9" } : null;
      }

      async run(): Promise<{ orderIdentifier: string }> {
        return this.createOrder();
      }
    }

    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
    });

    // First run: the classifier marks the 503 ambiguous, so a retry is scheduled.
    await expect(engine.run(CreateOrder, "workflow-1", null)).rejects.toThrow();
    expect(storage.getStep("workflow-1", "createOrder")?.status).toBe(StepStatus.AMBIGUOUS);

    // Second run: the probe resolves it without executing the body again.
    const output = await engine.run<null, { orderIdentifier: string }>(
      CreateOrder,
      "workflow-1",
      null,
    );
    expect(output).toEqual({ orderIdentifier: "SHOP-9" });
    expect(state.executions).toBe(1);
  });

  it("associates a probe and classifier through explicit decorators", async () => {
    const state = { executions: 0, sideEffectOccurred: false };

    @Workflow({ name: "shopify-explicit" })
    class CreateOrder {
      @Step({ maxAttempts: 2 })
      async createOrder(): Promise<{ orderIdentifier: string }> {
        state.executions += 1;
        state.sideEffectOccurred = true;
        throw new Error("timeout");
      }

      // Differently named methods, wired up explicitly.
      @ClassifyError("createOrder")
      classifyHttp(error: unknown): FailureKind {
        return classifyHttpError(error);
      }

      @Probe("createOrder")
      async lookUpExistingOrder(): Promise<{ orderIdentifier: string } | null> {
        return state.sideEffectOccurred ? { orderIdentifier: "SHOP-EXP" } : null;
      }

      async run(): Promise<{ orderIdentifier: string }> {
        return this.createOrder();
      }
    }

    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
    });

    await expect(engine.run(CreateOrder, "workflow-1", null)).rejects.toThrow();
    const output = await engine.run<null, { orderIdentifier: string }>(
      CreateOrder,
      "workflow-1",
      null,
    );
    expect(output).toEqual({ orderIdentifier: "SHOP-EXP" });
    expect(state.executions).toBe(1);
  });

  it("accepts @Probe() and @ClassifyError() with no argument on convention-named methods", async () => {
    const state = { executions: 0, sideEffectOccurred: false };

    @Workflow({ name: "shopify-marked-convention" })
    class CreateOrder {
      @Step({ maxAttempts: 2 })
      async createOrder(): Promise<{ orderIdentifier: string }> {
        state.executions += 1;
        state.sideEffectOccurred = true;
        throw new Error("503 Service Unavailable");
      }

      // Convention-named, but explicitly marked. The target step is inferred
      // from the method name.
      @ClassifyError()
      classifyErrorForCreateOrder(error: unknown): FailureKind {
        return classifyHttpError(error);
      }

      @Probe()
      async probeCreateOrder(): Promise<{ orderIdentifier: string } | null> {
        return state.sideEffectOccurred ? { orderIdentifier: "SHOP-MARK" } : null;
      }

      async run(): Promise<{ orderIdentifier: string }> {
        return this.createOrder();
      }
    }

    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
    });

    await expect(engine.run(CreateOrder, "workflow-1", null)).rejects.toThrow();
    const output = await engine.run<null, { orderIdentifier: string }>(
      CreateOrder,
      "workflow-1",
      null,
    );
    expect(output).toEqual({ orderIdentifier: "SHOP-MARK" });
    expect(state.executions).toBe(1);
  });

  it("throws when @Probe() with no argument is used on a non-convention name", () => {
    expect(() => {
      @Workflow({ name: "bad-probe-name" })
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      class BadProbe {
        @Step()
        async createOrder(): Promise<{ ok: true }> {
          return { ok: true };
        }

        // Does not follow the `probe<Step>` convention and no argument was given.
        @Probe()
        async lookUpOrder(): Promise<{ ok: true } | null> {
          return null;
        }

        async run(): Promise<{ ok: true }> {
          return this.createOrder();
        }
      }
    }).toThrow(/probe<Step>/);
  });

  it("throws a clear error when the class is not a workflow", async () => {
    class NotAWorkflow {
      async run(): Promise<void> {}
    }

    const engine = new WorkflowEngine(new MemoryStorage());
    await expect(engine.run(NotAWorkflow, "workflow-1", null)).rejects.toThrow(
      /not a workflow/i,
    );
  });
});
