import { describe, expect, it } from "vitest";

import { StepResultExpiredError } from "../src/errors/durable-execution.error.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

/** A clock the test can advance to age a memoized result. */
function createControllableClock(): { now: () => Date; advance: (ms: number) => void } {
  let current = new Date("2024-01-01T00:00:00.000Z");
  return {
    now: () => current,
    advance: (ms: number) => {
      current = new Date(current.getTime() + ms);
    },
  };
}

describe("opt-in step result expiry", () => {
  it("raises StepResultExpiredError when a TTL result is read after it expires", async () => {
    const clock = createControllableClock();
    const storage = new MemoryStorage(clock.now);
    const engine = new WorkflowEngine(storage, { now: clock.now });

    let creations = 0;
    engine.defineWorkflow<null, string>("perishable", async (context) => {
      const link = await context.step(
        "create-link",
        async () => {
          creations += 1;
          return `link-${creations}`;
        },
        { resultTtlMilliseconds: 15 * 60 * 1000 }, // 15 minutes
      );
      return link;
    });

    // First run creates and returns the link.
    expect(await engine.run<null, string>("perishable", "workflow-1", null)).toBe("link-1");
    expect(creations).toBe(1);

    // Within the TTL, a resume returns the memoised link without re-creating it.
    clock.advance(5 * 60 * 1000);
    expect(await engine.run<null, string>("perishable", "workflow-1", null)).toBe("link-1");
    expect(creations).toBe(1);

    // Past the TTL, the engine raises rather than returning a stale value or
    // silently re-running the step.
    clock.advance(20 * 60 * 1000);
    await expect(engine.run("perishable", "workflow-1", null)).rejects.toBeInstanceOf(
      StepResultExpiredError,
    );
    expect(creations).toBe(1); // NOT re-run automatically
  });

  it("raises when a revalidate predicate returns false", async () => {
    const storage = new MemoryStorage();
    let valid = true;
    const engine = new WorkflowEngine(storage);

    engine.defineWorkflow<null, string>("revalidated", async (context) => {
      return context.step("token", async () => "token-abc", {
        revalidate: () => valid,
      });
    });

    expect(await engine.run<null, string>("revalidated", "workflow-1", null)).toBe("token-abc");

    // The downstream declares the saved token no longer valid.
    valid = false;
    await expect(engine.run("revalidated", "workflow-1", null)).rejects.toBeInstanceOf(
      StepResultExpiredError,
    );
  });

  it("does not affect steps that opt into neither TTL nor revalidate", async () => {
    const clock = createControllableClock();
    const storage = new MemoryStorage(clock.now);
    const engine = new WorkflowEngine(storage, { now: clock.now });

    let creations = 0;
    engine.defineWorkflow<null, string>("normal", async (context) => {
      return context.step("plain", async () => {
        creations += 1;
        return "value";
      });
    });

    await engine.run("normal", "workflow-1", null);
    // Even a very long time later, an ordinary step's result never expires.
    clock.advance(365 * 24 * 60 * 60 * 1000);
    expect(await engine.run<null, string>("normal", "workflow-1", null)).toBe("value");
    expect(creations).toBe(1);
  });
});
