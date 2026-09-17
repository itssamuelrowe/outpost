import { describe, expect, it } from "vitest";

import { MemoryStorage } from "../src/storage/memory-storage.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import type { CronFireHandler } from "../src/scheduler/scheduler.js";
import { InvalidCronExpressionError } from "../src/utilities/cron.utility.js";

/**
 * A mutable clock so tests can position "now" deterministically.
 */
function controllableClock(startIso: string): {
    now: () => Date;
    set: (iso: string) => void;
} {
    let current = new Date(startIso);
    return {
        now: () => current,
        set: (iso) => {
            current = new Date(iso);
        },
    };
}

/**
 * Builds a scheduler with jitter off so fires land on the exact instant.
 */
function build(storage: MemoryStorage, now: () => Date): Scheduler {
    return new Scheduler(storage, { now, cronJitterMilliseconds: 0 });
}

/**
 * Records every fire the handler receives.
 */
function recordingHandler(): {
    handler: CronFireHandler;
    fires: Array<{ scheduledFor: string; workflowIdentifier: string }>;
} {
    const fires: Array<{ scheduledFor: string; workflowIdentifier: string }> = [];
    const handler: CronFireHandler = async (fire) => {
        fires.push({
            scheduledFor: fire.scheduledFor.toISOString(),
            workflowIdentifier: fire.workflowIdentifier,
        });
    };
    return { handler, fires };
}

describe("Scheduler.backfillCron", () => {
    it("fires every occurrence in the [start, end] window, inclusive of both ends", async () => {
        const clock = controllableClock("2026-01-10T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = build(storage, clock.now);
        const { handler, fires } = recordingHandler();
        scheduler.onCronFire(handler);

        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "report",
        });

        const dispatched = await scheduler.backfillCron(
            "hourly",
            new Date("2026-01-01T01:00:00.000Z"),
            new Date("2026-01-01T04:00:00.000Z"),
        );

        expect(fires.map((f) => f.scheduledFor)).toEqual([
            "2026-01-01T01:00:00.000Z",
            "2026-01-01T02:00:00.000Z",
            "2026-01-01T03:00:00.000Z",
            "2026-01-01T04:00:00.000Z",
        ]);
        expect(dispatched).toHaveLength(4);
    });

    it("uses distinct, deterministic backfill identifiers per occurrence", async () => {
        const clock = controllableClock("2026-01-10T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = build(storage, clock.now);
        const { handler, fires } = recordingHandler();
        scheduler.onCronFire(handler);

        await scheduler.registerCron({
            name: "daily",
            cronExpression: "0 0 * * *",
            workflowName: "report",
        });

        const first = await scheduler.backfillCron(
            "daily",
            new Date("2026-01-01T00:00:00.000Z"),
            new Date("2026-01-02T00:00:00.000Z"),
        );
        const second = await scheduler.backfillCron(
            "daily",
            new Date("2026-01-01T00:00:00.000Z"),
            new Date("2026-01-02T00:00:00.000Z"),
        );

        // Idempotent: the same window yields the same identifiers both times, and
        // every id carries the "backfill" marker.
        expect(first).toEqual(second);
        expect(fires.every((f) => f.workflowIdentifier.includes("backfill"))).toBe(true);
    });

    it("does not disturb the schedule's live nextRunAt", async () => {
        const clock = controllableClock("2026-01-10T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = build(storage, clock.now);
        scheduler.onCronFire(recordingHandler().handler);

        const before = await scheduler.registerCron({
            name: "daily",
            cronExpression: "0 0 * * *",
            workflowName: "report",
        });

        await scheduler.backfillCron(
            "daily",
            new Date("2026-01-01T00:00:00.000Z"),
            new Date("2026-01-05T00:00:00.000Z"),
        );

        const after = await storage.getCronSchedule("daily");
        expect(after?.nextRunAt.toISOString()).toBe(before.nextRunAt.toISOString());
    });

    it("returns an empty array for an unknown schedule", async () => {
        const clock = controllableClock("2026-01-10T00:00:00.000Z");
        const scheduler = build(new MemoryStorage(clock.now), clock.now);
        scheduler.onCronFire(recordingHandler().handler);
        expect(await scheduler.backfillCron("missing", new Date(0), new Date(1000))).toEqual([]);
    });

    it("throws when start is after end", async () => {
        const clock = controllableClock("2026-01-10T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = build(storage, clock.now);
        scheduler.onCronFire(recordingHandler().handler);
        await scheduler.registerCron({
            name: "daily",
            cronExpression: "0 0 * * *",
            workflowName: "report",
        });

        await expect(
            scheduler.backfillCron(
                "daily",
                new Date("2026-01-05T00:00:00.000Z"),
                new Date("2026-01-01T00:00:00.000Z"),
            ),
        ).rejects.toThrow(/must not be after end/);
    });
});

describe("Scheduler.updateCron", () => {
    it("changes the cron expression and recomputes nextRunAt from now", async () => {
        const clock = controllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = build(storage, clock.now);

        await scheduler.registerCron({
            name: "s",
            cronExpression: "0 0 * * *", // midnight daily
            workflowName: "report",
        });

        const updated = await scheduler.updateCron("s", { cronExpression: "0 12 * * *" }); // noon daily
        expect(updated?.cronExpression).toBe("0 12 * * *");
        expect(updated?.nextRunAt.toISOString()).toBe("2026-01-01T12:00:00.000Z");
    });

    it("updates the payload and catchUp without touching nextRunAt", async () => {
        const clock = controllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = build(storage, clock.now);

        const before = await scheduler.registerCron({
            name: "s",
            cronExpression: "0 0 * * *",
            workflowName: "report",
            payload: "old",
            catchUp: false,
        });

        const updated = await scheduler.updateCron("s", { payload: "new", catchUp: true });
        expect(updated?.payload).toBe("new");
        expect(updated?.catchUp).toBe(true);
        expect(updated?.nextRunAt.toISOString()).toBe(before.nextRunAt.toISOString());
    });

    it("preserves firing history (lastRunAt) across an update", async () => {
        const clock = controllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = build(storage, clock.now);

        await scheduler.registerCron({
            name: "s",
            cronExpression: "0 * * * *",
            workflowName: "report",
        });
        scheduler.onCronFire(recordingHandler().handler);

        // Advance so an occurrence is due, then fire it to set lastRunAt.
        clock.set("2026-01-01T01:00:00.000Z");
        await scheduler.tickCron();
        const afterFire = await storage.getCronSchedule("s");
        expect(afterFire?.lastRunAt).not.toBeNull();

        const updated = await scheduler.updateCron("s", { payload: "x" });
        expect(updated?.lastRunAt?.toISOString()).toBe(afterFire?.lastRunAt?.toISOString());
    });

    it("validates a new expression and leaves the schedule untouched on error", async () => {
        const clock = controllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = build(storage, clock.now);

        await scheduler.registerCron({
            name: "s",
            cronExpression: "0 0 * * *",
            workflowName: "report",
        });

        await expect(
            scheduler.updateCron("s", { cronExpression: "not a cron" }),
        ).rejects.toBeInstanceOf(InvalidCronExpressionError);

        const unchanged = await storage.getCronSchedule("s");
        expect(unchanged?.cronExpression).toBe("0 0 * * *");
    });

    it("returns null when updating an unknown schedule", async () => {
        const clock = controllableClock("2026-01-01T00:00:00.000Z");
        const scheduler = build(new MemoryStorage(clock.now), clock.now);
        expect(await scheduler.updateCron("missing", { payload: "x" })).toBeNull();
    });
});
