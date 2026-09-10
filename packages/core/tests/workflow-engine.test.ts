import { describe, expect, it } from "vitest";

import { EventType } from "../src/enums/event-type.enum.js";
import { FailureKind } from "../src/enums/failure-kind.enum.js";
import { StepStatus } from "../src/enums/step-status.enum.js";
import { StepNeedsReviewError } from "../src/errors/durable-execution.error.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

/** Produces a fixed clock so tests are deterministic. */
function createFixedClock(): () => Date {
  const instant = new Date("2024-01-01T00:00:00.000Z");
  return () => instant;
}

/** Classifies timeout and 5xx errors as ambiguous, as an HTTP wrapper would. */
function classifyHttpError(error: unknown): FailureKind {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|5\d\d/i.test(message) ? FailureKind.AMBIGUOUS : FailureKind.DEFINITE;
}

describe("WorkflowEngine", () => {
  it("completes a durable step and persists its result", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, { now: createFixedClock() });
    engine.defineWorkflow<{ value: number }, number>("multiplier", async (context, input) =>
      context.step("double", async () => input.value * 2),
    );

    const output = await engine.run<{ value: number }, number>("multiplier", "workflow-1", {
      value: 21,
    });

    expect(output).toBe(42);
    expect(storage.getStep("workflow-1", "double")?.status).toBe(StepStatus.COMPLETED);
  });

  it("memoizes a completed step and does not execute it again on resume", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, { now: createFixedClock() });
    let executionCount = 0;
    engine.defineWorkflow<null, number>("single", async (context) =>
      context.step("once", async () => {
        executionCount += 1;
        return 7;
      }),
    );

    await engine.run("single", "workflow-1", null);
    await engine.run("single", "workflow-1", null);

    expect(executionCount).toBe(1);
  });

  it("retries a definite failure and then fails terminally", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
    });
    let executionCount = 0;
    engine.defineWorkflow<null, number>("flaky", async (context) =>
      context.step(
        "attempt",
        async () => {
          executionCount += 1;
          throw new Error("permanent problem");
        },
        { maxAttempts: 2 },
      ),
    );

    await expect(engine.run("flaky", "workflow-1", null)).rejects.toThrow();
    await expect(engine.run("flaky", "workflow-1", null)).rejects.toThrow();
    expect(executionCount).toBe(2);
    expect(storage.getStep("workflow-1", "attempt")?.status).toBe(StepStatus.FAILED);
  });

  it("returns the fallback value when an optional step fails terminally", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, { now: createFixedClock() });
    engine.defineWorkflow<null, string>("optional", async (context) =>
      context.step("fraud-check", async () => {
        throw new Error("service unavailable");
      }, { optional: true, fallbackValue: "UNVERIFIED" }),
    );

    const output = await engine.run<null, string>("optional", "workflow-1", null);

    expect(output).toBe("UNVERIFIED");
    expect(storage.getStep("workflow-1", "fraud-check")?.status).toBe(StepStatus.FAILED_OPTIONAL);
  });

  it("resolves an ambiguous step through a probe without executing again", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
    });
    let executionCount = 0;
    let sideEffectOccurred = false;

    engine.defineWorkflow<null, { orderIdentifier: string }>("shopify", async (context) =>
      context.step<{ orderIdentifier: string }>(
        "create-order",
        async () => {
          executionCount += 1;
          sideEffectOccurred = true;
          throw new Error("503 Service Unavailable");
        },
        {
          maxAttempts: 2,
          classifyError: classifyHttpError,
          probe: async () => (sideEffectOccurred ? { orderIdentifier: "SHOP-1" } : null),
        },
      ),
    );

    await expect(engine.run("shopify", "workflow-1", null)).rejects.toThrow();
    expect(storage.getStep("workflow-1", "create-order")?.status).toBe(StepStatus.AMBIGUOUS);

    const output = await engine.run<null, { orderIdentifier: string }>(
      "shopify",
      "workflow-1",
      null,
    );
    expect(output).toEqual({ orderIdentifier: "SHOP-1" });
    expect(executionCount).toBe(1);
    expect(storage.events.some((event) => event.eventType === EventType.STEP_PROBE_RESOLVED)).toBe(
      true,
    );
  });

  it("executes again when the probe reports the effect did not occur", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
    });
    let executionCount = 0;

    engine.defineWorkflow<null, string>("retryable", async (context) =>
      context.step<string>(
        "call",
        async () => {
          executionCount += 1;
          if (executionCount === 1) {
            throw new Error("timeout");
          }
          return "succeeded-on-second-attempt";
        },
        { maxAttempts: 2, classifyError: classifyHttpError, probe: async () => null },
      ),
    );

    await expect(engine.run("retryable", "workflow-1", null)).rejects.toThrow();
    const output = await engine.run<null, string>("retryable", "workflow-1", null);
    expect(output).toBe("succeeded-on-second-attempt");
    expect(executionCount).toBe(2);
  });

  it("parks an ambiguous step for review when no probe is available", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, { now: createFixedClock() });
    engine.defineWorkflow<null, string>("no-probe", async (context) =>
      context.step<string>("call", async () => {
        throw new Error("500 error");
      }, { maxAttempts: 1, classifyError: classifyHttpError }),
    );

    await expect(engine.run("no-probe", "workflow-1", null)).rejects.toBeInstanceOf(
      StepNeedsReviewError,
    );
  });

  it("applies middleware around step execution in order", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const trace: string[] = [];
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      middleware: [
        async (_context, next) => {
          trace.push("outer-before");
          const result = await next();
          trace.push("outer-after");
          return result;
        },
      ],
    });
    engine.defineWorkflow<null, string>("with-middleware", async (context) =>
      context.step(
        "guarded",
        async () => {
          trace.push("inner");
          return "ok";
        },
        {
          middleware: [
            async (_context, next) => {
              trace.push("inner-before");
              const result = await next();
              trace.push("inner-after");
              return result;
            },
          ],
        },
      ),
    );

    const output = await engine.run<null, string>("with-middleware", "workflow-1", null);

    expect(output).toBe("ok");
    expect(trace).toEqual([
      "outer-before",
      "inner-before",
      "inner",
      "inner-after",
      "outer-after",
    ]);
  });
});
