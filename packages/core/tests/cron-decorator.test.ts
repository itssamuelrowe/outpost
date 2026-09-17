import { describe, expect, it } from "vitest";

import { Cron, Step, Workflow } from "../src/decorators/workflow.decorator.js";
import type { WorkflowContext } from "../src/interfaces/workflow-context.interface.js";
import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import { registerCronWorkflows } from "../src/scheduler/register-cron-workflows.js";
import { readWorkflowMetadata } from "../src/decorators/workflow-metadata.js";

/**
 * A mutable clock so tests can move time forward deterministically.
 */
function createControllableClock(startIso: string): {
    now: () => Date;
    set: (iso: string) => void;
} {
    let current = new Date(startIso);
    return {
        now: () => current,
        set: (iso: string) => {
            current = new Date(iso);
        },
    };
}

describe("@Cron decorator", () => {
    it("records cron metadata on the class", () => {
        @Workflow({ name: "nightly-report" })
        @Cron({ expression: "0 2 * * *", timeZone: "America/New_York", catchUp: true })
        class NightlyReport {
            async run(): Promise<void> {}
        }

        const metadata = readWorkflowMetadata(NightlyReport);
        expect(metadata?.cron).toEqual({
            name: undefined,
            cronExpression: "0 2 * * *",
            timeZone: "America/New_York",
            catchUp: true,
            payload: undefined,
        });
    });

    it("registers a cron workflow and runs the class when it fires", async () => {
        const clock = createControllableClock("2026-01-01T01:30:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const engine = new WorkflowEngine(storage, { now: clock.now });
        const scheduler = new Scheduler(storage, { now: clock.now, cronJitterMilliseconds: 0 });

        const runsFor: string[] = [];

        @Workflow({ name: "hourly-job" })
        @Cron({ expression: "0 * * * *" })
        class HourlyJob {
            // Step methods take their own arguments; the decorator adds durability,
            // so no context parameter is required.
            @Step()
            async record(scheduledFor: string): Promise<{ ok: true }> {
                runsFor.push(scheduledFor);
                return { ok: true };
            }

            async run(context: WorkflowContext, input: { scheduledFor: string }): Promise<void> {
                await this.record(input.scheduledFor);
            }
        }

        const registered = await registerCronWorkflows(scheduler, engine, [HourlyJob]);
        expect(registered).toHaveLength(1);
        expect(registered[0].name).toBe("hourly-job");
        expect(registered[0].workflowName).toBe("hourly-job");

        // Fire the 02:00 occurrence.
        clock.set("2026-01-01T02:00:00.000Z");
        const dispatched = await scheduler.tickCron();

        expect(dispatched).toBe(1);
        expect(runsFor).toEqual(["2026-01-01T02:00:00.000Z"]);

        // The started workflow used the deterministic per-occurrence identifier.
        const workflow = await storage.getWorkflow("cron-hourly-job-2026-01-01T02:00:00.000Z");
        expect(workflow?.workflowName).toBe("hourly-job");
    });

    it("uses an explicit schedule name when given", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const engine = new WorkflowEngine(storage, { now: clock.now });
        const scheduler = new Scheduler(storage, { now: clock.now, cronJitterMilliseconds: 0 });

        @Workflow({ name: "report-workflow" })
        @Cron({ name: "nightly", expression: "0 2 * * *" })
        class Report {
            async run(): Promise<void> {}
        }

        const [schedule] = await registerCronWorkflows(scheduler, engine, [Report]);
        // The schedule is named "nightly" but runs the "report-workflow" workflow.
        expect(schedule.name).toBe("nightly");
        expect(schedule.workflowName).toBe("report-workflow");
        expect((await scheduler.listCronSchedules())[0].name).toBe("nightly");
    });

    it("replays missed occurrences when catchUp is set on the decorator", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const engine = new WorkflowEngine(storage, { now: clock.now });
        const scheduler = new Scheduler(storage, { now: clock.now, cronJitterMilliseconds: 0 });

        const runsFor: string[] = [];

        @Workflow({ name: "metering" })
        @Cron({ expression: "0 * * * *", catchUp: true })
        class Metering {
            async run(context: WorkflowContext, input: { scheduledFor: string }): Promise<void> {
                runsFor.push(input.scheduledFor);
            }
        }

        await registerCronWorkflows(scheduler, engine, [Metering]);

        // Down for three hours, then a single recovery tick replays each miss.
        clock.set("2026-01-01T03:00:00.000Z");
        const dispatched = await scheduler.tickCron();

        expect(dispatched).toBe(3);
        expect(runsFor).toEqual([
            "2026-01-01T01:00:00.000Z",
            "2026-01-01T02:00:00.000Z",
            "2026-01-01T03:00:00.000Z",
        ]);
    });

    it("rejects a class that is missing the decorators", async () => {
        const storage = new MemoryStorage();
        const engine = new WorkflowEngine(storage);
        const scheduler = new Scheduler(storage);

        class NotAWorkflow {
            async run(): Promise<void> {}
        }
        await expect(registerCronWorkflows(scheduler, engine, [NotAWorkflow])).rejects.toThrow(
            /not a workflow/i,
        );

        @Workflow({ name: "plain" })
        class PlainWorkflow {
            async run(): Promise<void> {}
        }
        await expect(registerCronWorkflows(scheduler, engine, [PlainWorkflow])).rejects.toThrow(
            /no @Cron/i,
        );
    });

    it("propagates an invalid cron expression at registration", async () => {
        const storage = new MemoryStorage();
        const engine = new WorkflowEngine(storage);
        const scheduler = new Scheduler(storage);

        @Workflow({ name: "broken" })
        @Cron({ expression: "not a cron" })
        class Broken {
            async run(): Promise<void> {}
        }

        await expect(registerCronWorkflows(scheduler, engine, [Broken])).rejects.toThrow(
            /Invalid cron expression/i,
        );
    });
});
