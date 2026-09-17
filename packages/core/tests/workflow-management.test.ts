import { describe, expect, it } from "vitest";

import { EventType } from "../src/enums/event-type.enum.js";
import { WorkflowStatus } from "../src/enums/workflow-status.enum.js";
import { WorkflowCancelledError } from "../src/errors/durable-execution.error.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

function fixedClock(): () => Date {
    const instant = new Date("2024-01-01T00:00:00.000Z");
    return () => instant;
}

describe("workflow lifecycle management API", () => {
    describe("getWorkflowStatus", () => {
        it("returns null for an unknown workflow", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            expect(await engine.getWorkflowStatus("nope")).toBeNull();
        });

        it("reports COMPLETED after a successful run", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            engine.defineWorkflow<null, number>("w", async (context) =>
                context.step("s", async () => 1),
            );
            await engine.run("w", "w1", null);
            expect(await engine.getWorkflowStatus("w1")).toBe(WorkflowStatus.COMPLETED);
        });

        it("reports FAILED after a terminal failure", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            engine.defineWorkflow<null, number>("w", async (context) =>
                context.step("s", async () => {
                    throw new Error("boom");
                }),
            );
            await expect(engine.run("w", "w1", null)).rejects.toThrow();
            expect(await engine.getWorkflowStatus("w1")).toBe(WorkflowStatus.FAILED);
        });
    });

    describe("describeWorkflow", () => {
        it("returns a decoded snapshot including input and output", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            engine.defineWorkflow<{ x: number }, { y: number }>("w", async (context, input) => {
                await context.step("s", async () => input.x);
                return { y: input.x + 1 };
            });
            await engine.run<{ x: number }, { y: number }>("w", "w1", { x: 10 });

            const description = await engine.describeWorkflow<{ x: number }, { y: number }>("w1");
            expect(description).not.toBeNull();
            expect(description?.workflowName).toBe("w");
            expect(description?.status).toBe(WorkflowStatus.COMPLETED);
            expect(description?.input).toEqual({ x: 10 });
            expect(description?.output).toEqual({ y: 11 });
            expect(description?.parentWorkflowIdentifier).toBeNull();
        });

        it("returns null for an unknown workflow", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            expect(await engine.describeWorkflow("nope")).toBeNull();
        });
    });

    describe("getWorkflowResult", () => {
        it("returns the decoded output of a completed workflow", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            engine.defineWorkflow<null, string>("w", async () => "result");
            await engine.run("w", "w1", null);
            expect(await engine.getWorkflowResult<string>("w1")).toBe("result");
        });

        it("returns null for an incomplete workflow by default", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            engine.defineWorkflow<null, string>("w", async () => "x");
            // Never run it; the record does not exist, so result is null.
            expect(await engine.getWorkflowResult<string>("w1")).toBeNull();
        });

        it("throws for a failed workflow when throwIfNotComplete is set", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            engine.defineWorkflow<null, number>("w", async (context) =>
                context.step("s", async () => {
                    throw new Error("kaboom");
                }),
            );
            await expect(engine.run("w", "w1", null)).rejects.toThrow();
            await expect(
                engine.getWorkflowResult("w1", { throwIfNotComplete: true }),
            ).rejects.toThrow(/kaboom/);
        });
    });

    describe("listWorkflows", () => {
        async function seed(engine: WorkflowEngine): Promise<void> {
            engine.defineWorkflow<null, string>("alpha", async () => "a");
            engine.defineWorkflow<null, number>("beta", async (context) =>
                context.step("s", async () => {
                    throw new Error("fail");
                }),
            );
            await engine.run("alpha", "a1", null);
            await engine.run("alpha", "a2", null);
            await expect(engine.run("beta", "b1", null)).rejects.toThrow();
        }

        it("lists all workflows when no filter is given", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            await seed(engine);
            const all = await engine.listWorkflows();
            expect(all).toHaveLength(3);
        });

        it("filters by status", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            await seed(engine);
            const failed = await engine.listWorkflows({ statuses: [WorkflowStatus.FAILED] });
            expect(failed.map((w) => w.workflowIdentifier)).toEqual(["b1"]);
        });

        it("filters by workflow name", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            await seed(engine);
            const alphas = await engine.listWorkflows({ workflowName: "alpha" });
            expect(alphas).toHaveLength(2);
            expect(alphas.every((w) => w.workflowName === "alpha")).toBe(true);
        });

        it("respects the limit", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            await seed(engine);
            const limited = await engine.listWorkflows({ limit: 1 });
            expect(limited).toHaveLength(1);
        });
    });

    describe("cancelWorkflow", () => {
        it("cancels a running/suspended workflow and prevents future resumes", async () => {
            const storage = new MemoryStorage(fixedClock());
            const engine = new WorkflowEngine(storage, { now: fixedClock() });

            let runs = 0;
            engine.defineWorkflow<null, number>("w", async (context) =>
                context.step("s", async () => {
                    runs += 1;
                    return 1;
                }),
            );

            // Create the record without completing it by pre-seeding via ensureWorkflow.
            await storage.ensureWorkflow("w1", "w", null);

            expect(await engine.cancelWorkflow("w1")).toBe(true);
            expect(await engine.getWorkflowStatus("w1")).toBe(WorkflowStatus.CANCELLED);

            await expect(engine.run("w", "w1", null)).rejects.toBeInstanceOf(
                WorkflowCancelledError,
            );
            expect(runs).toBe(0);
        });

        it("emits a WORKFLOW_CANCELLED audit event", async () => {
            const storage = new MemoryStorage(fixedClock());
            const engine = new WorkflowEngine(storage, { now: fixedClock() });
            await storage.ensureWorkflow("w1", "w", null);
            await engine.cancelWorkflow("w1");
            expect(storage.events.map((e) => e.eventType)).toContain(EventType.WORKFLOW_CANCELLED);
        });

        it("returns false when cancelling an unknown workflow", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            expect(await engine.cancelWorkflow("nope")).toBe(false);
        });

        it("returns false when cancelling an already-completed workflow", async () => {
            const engine = new WorkflowEngine(new MemoryStorage(fixedClock()), {
                now: fixedClock(),
            });
            engine.defineWorkflow<null, number>("w", async () => 1);
            await engine.run("w", "w1", null);
            expect(await engine.cancelWorkflow("w1")).toBe(false);
            expect(await engine.getWorkflowStatus("w1")).toBe(WorkflowStatus.COMPLETED);
        });
    });
});
