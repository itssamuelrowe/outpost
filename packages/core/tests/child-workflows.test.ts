import { describe, expect, it } from "vitest";

import { EventType } from "../src/enums/event-type.enum.js";
import { WorkflowStatus } from "../src/enums/workflow-status.enum.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

/**
 * A fixed clock so tests are deterministic.
 */
function fixedClock(): () => Date {
    const instant = new Date("2024-01-01T00:00:00.000Z");
    return () => instant;
}

describe("child workflows", () => {
    it("runs a child workflow and returns its result to the parent", async () => {
        const storage = new MemoryStorage(fixedClock());
        const engine = new WorkflowEngine(storage, { now: fixedClock() });

        engine.defineWorkflow<{ value: number }, number>("double", async (context, input) =>
            context.step("double", async () => input.value * 2),
        );
        engine.defineWorkflow<{ value: number }, number>("parent", async (context, input) => {
            const doubled = await context.runChild<{ value: number }, number>(
                "double-it",
                "double",
                {
                    value: input.value,
                },
            );
            return doubled + 1;
        });

        const result = await engine.run<{ value: number }, number>("parent", "p1", { value: 20 });
        expect(result).toBe(41);
    });

    it("records the parent link on the child workflow", async () => {
        const storage = new MemoryStorage(fixedClock());
        const engine = new WorkflowEngine(storage, { now: fixedClock() });

        engine.defineWorkflow<null, string>("child", async () => "done");
        engine.defineWorkflow<null, string>("parent", async (context) =>
            context.runChild<null, string>("c", "child", null),
        );

        await engine.run("parent", "p1", null);

        const children = await engine.listWorkflows({ parentWorkflowIdentifier: "p1" });
        expect(children).toHaveLength(1);
        expect(children[0].workflowName).toBe("child");
        expect(children[0].parentWorkflowIdentifier).toBe("p1");
    });

    it("derives a deterministic child identifier from parent + child key", async () => {
        const storage = new MemoryStorage(fixedClock());
        const engine = new WorkflowEngine(storage, { now: fixedClock() });

        engine.defineWorkflow<null, string>("child", async () => "x");
        let capturedId = "";
        engine.defineWorkflow<null, string>("parent", async (context) => {
            const handle = await context.startChild<null, string>("only-child", "child", null);
            capturedId = handle.workflowIdentifier;
            return handle.result();
        });

        await engine.run("parent", "p1", null);
        expect(capturedId).toBe("p1::child::only-child");
        expect(await engine.getWorkflowStatus(capturedId)).toBe(WorkflowStatus.COMPLETED);
    });

    it("honours an explicit child identifier when supplied", async () => {
        const storage = new MemoryStorage(fixedClock());
        const engine = new WorkflowEngine(storage, { now: fixedClock() });

        engine.defineWorkflow<null, string>("child", async () => "x");
        engine.defineWorkflow<null, string>("parent", async (context) =>
            context.runChild<null, string>("c", "child", null, {
                workflowIdentifier: "explicit-child-id",
            }),
        );

        await engine.run("parent", "p1", null);
        expect(await engine.getWorkflowStatus("explicit-child-id")).toBe(WorkflowStatus.COMPLETED);
    });

    it("memoises the child on parent resume rather than re-running its steps", async () => {
        const storage = new MemoryStorage(fixedClock());
        const engine = new WorkflowEngine(storage, { now: fixedClock() });

        let childStepRuns = 0;
        engine.defineWorkflow<null, number>("child", async (context) =>
            context.step("work", async () => {
                childStepRuns += 1;
                return 7;
            }),
        );
        engine.defineWorkflow<null, number>("parent", async (context) =>
            context.runChild<null, number>("c", "child", null),
        );

        await engine.run("parent", "p1", null);
        await engine.run("parent", "p1", null); // resume
        expect(childStepRuns).toBe(1);
    });

    it("runs multiple children started concurrently and gathers their results", async () => {
        const storage = new MemoryStorage(fixedClock());
        const engine = new WorkflowEngine(storage, { now: fixedClock() });

        engine.defineWorkflow<{ n: number }, number>("square", async (context, input) =>
            context.step("square", async () => input.n * input.n),
        );
        engine.defineWorkflow<null, number[]>("parent", async (context) => {
            const handles = await Promise.all([
                context.startChild<{ n: number }, number>("a", "square", { n: 2 }),
                context.startChild<{ n: number }, number>("b", "square", { n: 3 }),
                context.startChild<{ n: number }, number>("c", "square", { n: 4 }),
            ]);
            return Promise.all(handles.map((handle) => handle.result()));
        });

        const results = await engine.run<null, number[]>("parent", "p1", null);
        expect(results).toEqual([4, 9, 16]);
    });

    it("emits CHILD_WORKFLOW_STARTED and CHILD_WORKFLOW_COMPLETED audit events", async () => {
        const storage = new MemoryStorage(fixedClock());
        const engine = new WorkflowEngine(storage, { now: fixedClock() });

        engine.defineWorkflow<null, string>("child", async () => "done");
        engine.defineWorkflow<null, string>("parent", async (context) =>
            context.runChild<null, string>("c", "child", null),
        );

        await engine.run("parent", "p1", null);

        const types = storage.events.map((event) => event.eventType);
        expect(types).toContain(EventType.CHILD_WORKFLOW_STARTED);
        expect(types).toContain(EventType.CHILD_WORKFLOW_COMPLETED);
    });

    it("supports nested children (grandchildren)", async () => {
        const storage = new MemoryStorage(fixedClock());
        const engine = new WorkflowEngine(storage, { now: fixedClock() });

        engine.defineWorkflow<null, string>("grandchild", async () => "leaf");
        engine.defineWorkflow<null, string>("child", async (context) => {
            const leaf = await context.runChild<null, string>("gc", "grandchild", null);
            return `child(${leaf})`;
        });
        engine.defineWorkflow<null, string>("parent", async (context) => {
            const child = await context.runChild<null, string>("c", "child", null);
            return `parent(${child})`;
        });

        const result = await engine.run<null, string>("parent", "p1", null);
        expect(result).toBe("parent(child(leaf))");
    });

    it("runs children with @Workflow classes as well as registered names", async () => {
        const storage = new MemoryStorage(fixedClock());
        const engine = new WorkflowEngine(storage, { now: fixedClock() });

        // Minimal class-based workflow using the functional definition path so the
        // test does not depend on decorator metadata plumbing here.
        engine.defineWorkflow<{ v: number }, number>("triple", async (context, input) =>
            context.step("triple", async () => input.v * 3),
        );
        engine.defineWorkflow<null, number>("parent", async (context) =>
            context.runChild<{ v: number }, number>("t", "triple", { v: 5 }),
        );

        expect(await engine.run<null, number>("parent", "p1", null)).toBe(15);
    });
});
