/**
 * "Hello, world" for Outpost.
 *
 * This is the smallest useful example. It defines a two-step workflow, runs it
 * twice with the same workflow identifier, and then prints the complete durable
 * state left behind in memory. The goal is to make three ideas concrete:
 *
 * 1. A workflow is an ordinary class; each durable action is a method.
 * 2. Running the same workflow identifier again does not repeat completed steps —
 *    their results are memoised and reused.
 * 3. Every material transition is recorded, which you can see in the dumped state
 *    and audit events at the end.
 *
 * It uses the in-memory storage adapter, so there is nothing to install or
 * configure. Run it with:
 *
 * yarn tsx src/hello.ts
 */

import { MemoryStorage, Step, Workflow, WorkflowEngine } from "@outpost/core";
import type { WorkflowContext } from "@outpost/core";

/**
 * The input the greeting workflow expects.
 */
interface RunInput {
    name: string;
}

/**
 * A minimal workflow that builds a greeting and then "sends" it.
 *
 * The class is marked with `@Workflow`, and each durable step is a method
 * marked with `@Step`. The `run` method is the lifecycle method: it calls the
 * steps in order and returns the workflow's final result.
 */
@Workflow({ name: "greet-user" })
class GreetUser {
    /**
     * The first durable step. It builds the greeting text.
     *
     * Because it is a step, its return value is persisted. If the workflow is
     * run again with the same identifier, this method will not execute a second
     * time; the stored greeting is returned instead.
     */
    @Step()
    public async buildGreeting(name: string): Promise<string> {
        return `Hello, ${name}!`;
    }

    /**
     * The second durable step. In a real application this might send an email
     * or a message; here it simply prints the greeting to show the step ran.
     */
    @Step()
    public async sendGreeting(greeting: string): Promise<void> {
        console.log(`  [sendGreeting] ${greeting}`);
    }

    /**
     * The lifecycle method. It orchestrates the steps and returns the result.
     *
     * The `context` parameter carries the workflow identity and durable
     * primitives. This simple workflow does not need it directly, because the
     * decorated step methods already route through the engine, but it is always
     * available for durable sleeps or manual `context.step` calls.
     */
    public async run(context: WorkflowContext, input: RunInput): Promise<string> {
        const greeting = await this.buildGreeting(input.name);
        await this.sendGreeting(greeting);
        return greeting;
    }
}

/**
 * Decodes a persisted value for display.
 *
 * The engine stores workflow input and output, and step results, as binary
 * buffers produced by its codec (JSON by default). To print them in a readable
 * form we decode the buffer back into text and parse it.
 */
function decodeForDisplay(value: Buffer | null): unknown {
    if (value === null) {
        return null;
    }
    return JSON.parse(value.toString("utf8"));
}

const main = async (): Promise<void> => {
    // The in-memory adapter keeps all state in this process. It is ideal for
    // examples and tests; production would use a durable adapter such as MySQL.
    const storage = new MemoryStorage();
    const engine = new WorkflowEngine(storage);
    const workflowId = "greet-1";

    // First run: both steps execute for the first time.
    console.log(`Running workflow with ID: ${workflowId}`);
    const firstResult = await engine.run(new GreetUser(), workflowId, { name: "Samuel" });
    console.log(`  Result: ${firstResult}`);

    // Second run with the same identifier: the engine recognises this as the same
    // execution. Both steps are already completed, so their stored results are
    // reused and the step methods do not run again. Notice there is no second
    // "[sendGreeting] ..." line printed below.
    console.log(`\nRunning workflow with ID: ${workflowId} (duplicate)`);
    const secondResult = await engine.run(new GreetUser(), workflowId, { name: "Samuel" });
    console.log(`  Result: ${secondResult}`);

    // Finally, dump the complete durable state left in memory. This shows the
    // workflow record, each step's status and memoised output, any schedules, and
    // the append-only audit log of everything that happened.
    const snapshot = storage.dump();

    console.log(`\n=== Final memory storage state ===`);

    console.log(`\nWorkflows (${snapshot.workflows.length}):`);
    for (const workflow of snapshot.workflows) {
        console.log(`  - ${workflow.workflowIdentifier} [${workflow.status}]`, {
            name: workflow.workflowName,
            input: decodeForDisplay(workflow.input),
            output: decodeForDisplay(workflow.output),
        });
    }

    console.log(`\nSteps (${snapshot.steps.length}):`);
    for (const step of snapshot.steps) {
        console.log(`  - ${step.stepKey} [${step.status}]`, {
            attempts: step.attempts,
            output: decodeForDisplay(step.output),
        });
    }

    console.log(`\nSchedules (${snapshot.schedules.length}):`);
    for (const schedule of snapshot.schedules) {
        console.log(
            `  - #${schedule.scheduleIdentifier} [${schedule.status}] for ${schedule.stepKey ?? "workflow"}`,
        );
    }

    console.log(`\nAudit events (${snapshot.events.length}):`);
    for (const event of snapshot.events) {
        const scope = event.stepKey ? `${event.stepKey}` : "workflow";
        console.log(`  - ${event.eventType} (${scope})`);
    }
};

main().catch((error) => {
    console.error("hello example failed:", error);
    process.exitCode = 1;
});
