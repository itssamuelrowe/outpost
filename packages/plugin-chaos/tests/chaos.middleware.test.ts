import { MemoryStorage, StepStatus, WorkflowEngine } from "@outpost/core";
import { describe, expect, it } from "vitest";

import { createChaosMiddleware } from "../src/middleware/chaos.middleware.js";
import { ChaosTiming } from "../src/enums/chaos-timing.enum.js";

function createFixedClock(): () => Date {
  const instant = new Date("2024-01-01T00:00:00.000Z");
  return () => instant;
}

describe("chaos middleware", () => {
  it("fails selected attempts and lets a later attempt succeed", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
      middleware: [
        createChaosMiddleware([
          {
            stepKey: "flaky",
            attempts: [1, 2],
            error: () => new Error("injected transient failure"),
          },
        ]),
      ],
    });

    let executionCount = 0;
    engine.defineWorkflow<null, string>("chaotic", async (context) =>
      context.step(
        "flaky",
        async () => {
          executionCount += 1;
          return "eventually-ok";
        },
        { maxAttempts: 3 },
      ),
    );

    // Attempts 1 and 2 are failed by the chaos middleware before the step runs.
    await expect(engine.run("chaotic", "workflow-1", null)).rejects.toThrow();
    await expect(engine.run("chaotic", "workflow-1", null)).rejects.toThrow();
    // Attempt 3 is allowed through.
    const output = await engine.run<null, string>("chaotic", "workflow-1", null);

    expect(output).toBe("eventually-ok");
    // The step function only actually ran on the third attempt, because the
    // first two were failed before execution.
    expect(executionCount).toBe(1);
    expect(storage.getStep("workflow-1", "flaky")?.status).toBe(StepStatus.COMPLETED);
  });

  it("simulates a crash after the side effect but before the commit", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      randomNumberGenerator: () => 0,
      middleware: [
        createChaosMiddleware([
          {
            stepKey: "commit-window",
            attempts: [1],
            timing: ChaosTiming.AFTER_EXECUTION,
            error: () => new Error("crash after side effect"),
          },
        ]),
      ],
    });

    let sideEffectCount = 0;
    engine.defineWorkflow<null, string>("crash", async (context) =>
      context.step(
        "commit-window",
        async () => {
          sideEffectCount += 1;
          return "committed";
        },
        { maxAttempts: 2 },
      ),
    );

    // Attempt 1 runs the side effect, then the injected crash prevents the commit.
    await expect(engine.run("crash", "workflow-1", null)).rejects.toThrow();
    expect(sideEffectCount).toBe(1);
    expect(storage.getStep("workflow-1", "commit-window")?.status).not.toBe(StepStatus.COMPLETED);

    // Attempt 2 completes normally; the side effect runs a second time, which is
    // the documented at-least-once behaviour for a non-probed step.
    const output = await engine.run<null, string>("crash", "workflow-1", null);
    expect(output).toBe("committed");
    expect(sideEffectCount).toBe(2);
  });

  it("matches steps by regular expression", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, {
      now: createFixedClock(),
      middleware: [
        createChaosMiddleware([
          { stepKeyPattern: /^payment-/, error: () => new Error("payment subsystem down") },
        ]),
      ],
    });

    engine.defineWorkflow<null, string>("regex", async (context) =>
      context.step("payment-charge", async () => "should not run"),
    );

    await expect(engine.run("regex", "workflow-1", null)).rejects.toThrow();
  });
});
