import { describe, expect, it } from "vitest";

import { StepStatus } from "../src/enums/step-status.enum.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

function createFixedClock(): () => Date {
  const instant = new Date("2024-01-01T00:00:00.000Z");
  return () => instant;
}

describe("manual lease release", () => {
  it("releaseStep returns a running step to a claimable state, guarded by fence token", async () => {
    const storage = new MemoryStorage(createFixedClock());
    await storage.ensureWorkflow("workflow-1", "w", null);

    // Claim the step: it is now RUNNING under a live lease.
    const claim = await storage.claimStep("workflow-1", "step", 1, 30_000);
    expect(claim.claimed).toBe(true);

    // A stale fence token cannot release it.
    expect(await storage.releaseStep("workflow-1", "step", claim.fenceToken + 1)).toBe(false);

    // The current holder can. The step becomes claimable again without bumping
    // the attempt count beyond the next claim.
    expect(await storage.releaseStep("workflow-1", "step", claim.fenceToken)).toBe(true);
    expect(storage.getStep("workflow-1", "step")?.status).toBe(StepStatus.PENDING);

    // Another worker can now immediately claim it.
    const reclaim = await storage.claimStep("workflow-1", "step", 1, 30_000);
    expect(reclaim.claimed).toBe(true);
  });

  it("releaseInFlightSteps frees a step interrupted mid-execution", async () => {
    const storage = new MemoryStorage(createFixedClock());
    const engine = new WorkflowEngine(storage, { now: createFixedClock() });

    // A workflow whose step blocks until we decide to release, simulating a
    // long-running step interrupted by a shutdown. The step signals when it has
    // started so the test knows the lease has been claimed and tracked.
    let releaseNow: (() => void) | undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseNow = resolve;
    });
    let signalStarted: (() => void) | undefined;
    const started = new Promise<void>((resolve) => {
      signalStarted = resolve;
    });

    engine.defineWorkflow<null, void>("blocker", async (context) => {
      await context.step("long-step", async () => {
        signalStarted?.(); // the lease is now held
        await blocked; // hold it open
      });
    });

    // Start the workflow but do not await it yet; it parks inside the step.
    const running = engine.run("blocker", "workflow-1", null);

    // Wait until the step has actually started and its lease is tracked.
    await started;

    // The lease is held; release all in-flight leases as a shutdown would.
    await engine.releaseInFlightSteps();
    expect(storage.getStep("workflow-1", "long-step")?.status).toBe(StepStatus.PENDING);

    // Unblock the original step so the run finishes and does not leak.
    releaseNow?.();
    await running.catch(() => undefined);
  });
});
