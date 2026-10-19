import { describe, expect, it } from "vitest";

import { WorkflowStatus } from "../src/enums/workflow-status.enum.js";
import { WorkflowSuspendedError } from "../src/errors/durable-execution.error.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

/**
 * A clock the test can advance to simulate time passing during a sleep.
 */
function createControllableClock(): { now: () => Date; advance: (ms: number) => void } {
    let current = new Date("2024-01-01T00:00:00.000Z");
    return {
        now: () => current,
        advance: (ms: number) => {
            current = new Date(current.getTime() + ms);
        },
    };
}

describe("durable sleep", () => {
    it("suspends the workflow until the sleep is due, then resumes past it", async () => {
        const clock = createControllableClock();
        const storage = new MemoryStorage(clock.now);
        const engine = new WorkflowEngine(storage, { now: clock.now });

        const executed: string[] = [];

        engine.defineWorkflow<null, string>("waiter", async (context) => {
            await context.step("before-sleep", async () => {
                executed.push("before");
                return "done";
            });

            await context.sleep("cooldown", 60 * 60 * 1000); // one hour

            await context.step("after-sleep", async () => {
                executed.push("after");
                return "done";
            });

            return "finished";
        });

        // First run: the step before the sleep runs, then the sleep suspends the
        // workflow because its due time is an hour away.
        await expect(engine.run("waiter", "workflow-1", null)).rejects.toBeInstanceOf(
            WorkflowSuspendedError,
        );
        expect(executed).toEqual(["before"]);
        expect((await storage.getWorkflow("workflow-1"))?.status).toBe(WorkflowStatus.SUSPENDED);

        // Resuming before the due time suspends again; the step after the sleep does
        // not run, and the step before it is not repeated (it is memoised).
        await expect(engine.run("waiter", "workflow-1", null)).rejects.toBeInstanceOf(
            WorkflowSuspendedError,
        );
        expect(executed).toEqual(["before"]);

        // Once the hour has passed, resuming lets the sleep return and the workflow
        // completes.
        clock.advance(60 * 60 * 1000);
        const result = await engine.run<null, string>("waiter", "workflow-1", null);
        expect(result).toBe("finished");
        expect(executed).toEqual(["before", "after"]);
        expect((await storage.getWorkflow("workflow-1"))?.status).toBe(WorkflowStatus.COMPLETED);
    });

    it("does not slide the due time forward on each resume", async () => {
        const clock = createControllableClock();
        const storage = new MemoryStorage(clock.now);
        const engine = new WorkflowEngine(storage, { now: clock.now });

        engine.defineWorkflow<null, void>("waiter", async (context) => {
            await context.sleep("wait", 10 * 60 * 1000); // ten minutes
        });

        // First run fixes the due time at T + 10 minutes and suspends.
        await expect(engine.run("waiter", "workflow-1", null)).rejects.toBeInstanceOf(
            WorkflowSuspendedError,
        );

        // Advance nine minutes and resume: still not due, because the due time was
        // fixed on the first call and is not pushed forward.
        clock.advance(9 * 60 * 1000);
        await expect(engine.run("waiter", "workflow-1", null)).rejects.toBeInstanceOf(
            WorkflowSuspendedError,
        );

        // One more minute reaches the original due time, so it now completes.
        clock.advance(1 * 60 * 1000);
        await expect(engine.run("waiter", "workflow-1", null)).resolves.toBeUndefined();
    });
});
