import { describe, expect, it } from "vitest";

import { MemoryStorage } from "../src/storage/memory-storage.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

/** A mutable clock so tests can move time forward deterministically. */
function createControllableClock(): { now: () => Date; advance: (milliseconds: number) => void } {
  let current = new Date("2024-01-01T00:00:00.000Z");
  return {
    now: () => current,
    advance: (milliseconds: number) => {
      current = new Date(current.getTime() + milliseconds);
    },
  };
}

describe("Scheduler", () => {
  it("dispatches only timers whose due time has passed", async () => {
    const clock = createControllableClock();
    const storage = new MemoryStorage(clock.now);
    // A timer due one second from now.
    await storage.scheduleTimer("workflow-1", "wake", new Date(clock.now().getTime() + 1_000), null);

    const scheduler = new Scheduler(storage, { now: clock.now });
    const dispatched: string[] = [];
    const handler = async (timer: { workflowIdentifier: string }) => {
      dispatched.push(timer.workflowIdentifier);
    };

    // Before the due time nothing is dispatched.
    expect(await scheduler.tick(handler)).toBe(0);
    expect(dispatched).toEqual([]);

    // After the due time the timer fires exactly once.
    clock.advance(1_000);
    expect(await scheduler.tick(handler)).toBe(1);
    expect(dispatched).toEqual(["workflow-1"]);

    // A second tick does not redispatch the processed timer.
    expect(await scheduler.tick(handler)).toBe(0);
  });

  it("reports a handler failure without halting the batch", async () => {
    const clock = createControllableClock();
    const storage = new MemoryStorage(clock.now);
    await storage.scheduleTimer("workflow-a", null, clock.now(), null);
    await storage.scheduleTimer("workflow-b", null, clock.now(), null);

    const reportedFailures: string[] = [];
    const succeeded: string[] = [];
    const scheduler = new Scheduler(storage, {
      now: clock.now,
      onHandlerError: (workflowIdentifier) => reportedFailures.push(workflowIdentifier),
    });

    await scheduler.tick(async (timer) => {
      if (timer.workflowIdentifier === "workflow-a") {
        throw new Error("resume failed");
      }
      succeeded.push(timer.workflowIdentifier);
    });

    // The failing timer is reported; the sibling still gets handled.
    expect(reportedFailures).toEqual(["workflow-a"]);
    expect(succeeded).toEqual(["workflow-b"]);
  });

  it("runs and stops the background loop cleanly", async () => {
    const storage = new MemoryStorage();
    await storage.scheduleTimer("workflow-loop", null, new Date(Date.now() - 1_000), null);

    const scheduler = new Scheduler(storage, { pollIntervalMilliseconds: 5 });
    const dispatched: string[] = [];
    scheduler.start(async (timer) => {
      dispatched.push(timer.workflowIdentifier);
    });

    // Give the loop a moment to run at least one tick.
    await new Promise((resolve) => setTimeout(resolve, 30));
    await scheduler.stop();

    expect(dispatched).toContain("workflow-loop");
  });
});
