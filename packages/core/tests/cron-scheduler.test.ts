import { describe, expect, it } from "vitest";

import { CronScheduleStatus } from "../src/enums/cron-schedule-status.enum.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";
import { Scheduler } from "../src/scheduler/scheduler.js";
import type { CronFireHandler } from "../src/scheduler/scheduler.js";
import {
    InvalidCronExpressionError,
    InvalidTimeZoneError,
    applyCronJitter,
    computeNextCronRun,
    enumerateMissedCronRuns,
} from "../src/utilities/cron.utility.js";

/**
 * A mutable clock so tests can move time forward deterministically.
 */
function createControllableClock(startIso: string): {
    now: () => Date;
    advance: (milliseconds: number) => void;
    set: (iso: string) => void;
} {
    let current = new Date(startIso);
    return {
        now: () => current,
        advance: (milliseconds: number) => {
            current = new Date(current.getTime() + milliseconds);
        },
        set: (iso: string) => {
            current = new Date(iso);
        },
    };
}

/**
 * Builds a scheduler with jitter disabled so fires happen at the exact instant.
 */
function buildScheduler(storage: MemoryStorage, now: () => Date): Scheduler {
    return new Scheduler(storage, { now, cronJitterMilliseconds: 0 });
}

describe("cron utilities", () => {
    it("computes the next occurrence in UTC", () => {
        const next = computeNextCronRun("0 9 * * *", new Date("2026-01-01T00:00:00.000Z"));
        expect(next.toISOString()).toBe("2026-01-01T09:00:00.000Z");
    });

    it("evaluates the expression in the given time zone across DST", () => {
        // 9am America/New_York. Before the 2026 spring-forward (EST, UTC-5) that is
        // 14:00 UTC; after it (EDT, UTC-4) it is 13:00 UTC. The wall-clock time
        // stays 9am either way, which is the whole point of a time zone.
        const beforeDst = computeNextCronRun(
            "0 9 * * *",
            new Date("2026-03-01T00:00:00.000Z"),
            "America/New_York",
        );
        expect(beforeDst.toISOString()).toBe("2026-03-01T14:00:00.000Z");

        const afterDst = computeNextCronRun(
            "0 9 * * *",
            new Date("2026-03-09T00:00:00.000Z"),
            "America/New_York",
        );
        expect(afterDst.toISOString()).toBe("2026-03-09T13:00:00.000Z");
    });

    it("enumerates missed occurrences within a window, capped by the limit", () => {
        const missed = enumerateMissedCronRuns(
            "0 * * * *", // hourly
            new Date("2026-01-01T00:00:00.000Z"),
            new Date("2026-01-01T05:00:00.000Z"),
            null,
            10,
        );
        expect(missed.map((date) => date.toISOString())).toEqual([
            "2026-01-01T01:00:00.000Z",
            "2026-01-01T02:00:00.000Z",
            "2026-01-01T03:00:00.000Z",
            "2026-01-01T04:00:00.000Z",
            "2026-01-01T05:00:00.000Z",
        ]);

        const capped = enumerateMissedCronRuns(
            "0 * * * *",
            new Date("2026-01-01T00:00:00.000Z"),
            new Date("2026-01-01T10:00:00.000Z"),
            null,
            3,
        );
        expect(capped).toHaveLength(3);
    });

    it("keeps jitter within [0, ceiling]", () => {
        const base = new Date("2026-01-01T00:00:00.000Z");
        expect(applyCronJitter(base, 10_000, () => 0).getTime()).toBe(base.getTime());
        expect(applyCronJitter(base, 10_000, () => 0.999).getTime()).toBe(base.getTime() + 9_990);
        expect(applyCronJitter(base, 0, () => 0.5).getTime()).toBe(base.getTime());
    });

    it("rejects malformed expressions and unknown time zones", async () => {
        const scheduler = new Scheduler(new MemoryStorage());
        await expect(
            scheduler.registerCron({
                name: "bad-expr",
                cronExpression: "not a cron",
                workflowName: "w",
            }),
        ).rejects.toBeInstanceOf(InvalidCronExpressionError);
        await expect(
            scheduler.registerCron({
                name: "bad-zone",
                cronExpression: "0 9 * * *",
                workflowName: "w",
                timeZone: "Mars/Phobos",
            }),
        ).rejects.toBeInstanceOf(InvalidTimeZoneError);
    });
});

describe("Scheduler cron scheduling", () => {
    const noopTimerHandler = async () => undefined;

    it("fires a due schedule once and advances to the next occurrence", async () => {
        const clock = createControllableClock("2026-01-01T08:30:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);

        const fired: string[] = [];
        scheduler.onCronFire(async ({ scheduledFor, workflowIdentifier }) => {
            fired.push(workflowIdentifier);
            expect(scheduledFor.toISOString()).toBe("2026-01-01T09:00:00.000Z");
        });

        await scheduler.registerCron({
            name: "daily-report",
            cronExpression: "0 9 * * *",
            workflowName: "report",
        });

        // Not due yet at 08:30.
        expect(await scheduler.tickCron()).toBe(0);
        expect(fired).toEqual([]);

        // At 09:00 it fires exactly once.
        clock.set("2026-01-01T09:00:00.000Z");
        expect(await scheduler.tickCron()).toBe(1);
        expect(fired).toEqual(["cron-daily-report-2026-01-01T09:00:00.000Z"]);

        // The next occurrence is the following day; it does not re-fire now.
        expect(await scheduler.tickCron()).toBe(0);
        const [schedule] = await scheduler.listCronSchedules();
        expect(schedule.nextRunAt.toISOString()).toBe("2026-01-02T09:00:00.000Z");
        expect(schedule.lastRunAt?.toISOString()).toBe("2026-01-01T09:00:00.000Z");
    });

    it("derives a deterministic workflow identifier per occurrence", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);

        const identifiers: string[] = [];
        scheduler.onCronFire(async ({ workflowIdentifier }) => {
            identifiers.push(workflowIdentifier);
        });
        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "job",
        });

        clock.set("2026-01-01T01:00:00.000Z");
        await scheduler.tickCron();
        clock.set("2026-01-01T02:00:00.000Z");
        await scheduler.tickCron();

        expect(identifiers).toEqual([
            "cron-hourly-2026-01-01T01:00:00.000Z",
            "cron-hourly-2026-01-01T02:00:00.000Z",
        ]);
    });

    it("skips missed windows when catch-up is off", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);

        const fired: string[] = [];
        scheduler.onCronFire(async ({ scheduledFor }) => {
            fired.push(scheduledFor.toISOString());
        });
        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "job",
            catchUp: false,
        });

        // Jump forward three hours as if the process was down, then tick once.
        clock.set("2026-01-01T03:00:00.000Z");
        const dispatched = await scheduler.tickCron();

        // Only the single occurrence that came due fires; misses are dropped.
        expect(dispatched).toBe(1);
        expect(fired).toEqual(["2026-01-01T01:00:00.000Z"]);
    });

    it("replays missed windows when catch-up is on", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);

        const fired: string[] = [];
        scheduler.onCronFire(async ({ scheduledFor }) => {
            fired.push(scheduledFor.toISOString());
        });
        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "job",
            catchUp: true,
        });

        // Down for three hours, then a single recovery tick replays each miss.
        clock.set("2026-01-01T03:00:00.000Z");
        const dispatched = await scheduler.tickCron();

        expect(dispatched).toBe(3);
        expect(fired).toEqual([
            "2026-01-01T01:00:00.000Z",
            "2026-01-01T02:00:00.000Z",
            "2026-01-01T03:00:00.000Z",
        ]);
    });

    it("pauses and resumes a schedule", async () => {
        const clock = createControllableClock("2026-01-01T00:30:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);

        let fires = 0;
        scheduler.onCronFire(async () => {
            fires += 1;
        });
        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "job",
        });

        await scheduler.pauseCron("hourly");
        clock.set("2026-01-01T01:00:00.000Z");
        expect(await scheduler.tickCron()).toBe(0);
        expect(fires).toBe(0);

        const paused = await storage.getCronSchedule("hourly");
        expect(paused?.status).toBe(CronScheduleStatus.PAUSED);

        await scheduler.resumeCron("hourly");
        expect(await scheduler.tickCron()).toBe(1);
        expect(fires).toBe(1);
    });

    it("removes a schedule so it no longer fires", async () => {
        const clock = createControllableClock("2026-01-01T00:30:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);

        scheduler.onCronFire(async () => undefined);
        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "job",
        });

        expect(await scheduler.removeCron("hourly")).toBe(true);
        expect(await scheduler.removeCron("hourly")).toBe(false);
        clock.set("2026-01-01T01:00:00.000Z");
        expect(await scheduler.tickCron()).toBe(0);
        expect(await scheduler.listCronSchedules()).toEqual([]);
    });

    it("triggers a schedule immediately without disturbing its cadence", async () => {
        const clock = createControllableClock("2026-01-01T00:30:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);

        const fired: string[] = [];
        const handler: CronFireHandler = async ({ workflowIdentifier }) => {
            fired.push(workflowIdentifier);
        };
        scheduler.onCronFire(handler);
        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "job",
        });

        const before = await storage.getCronSchedule("hourly");
        const manualId = await scheduler.triggerCron("hourly");
        expect(manualId).toBe("cron-hourly-2026-01-01T00:30:00.000Z-manual");
        expect(fired).toEqual([manualId]);

        // The manual fire must not move the schedule's next occurrence.
        const after = await storage.getCronSchedule("hourly");
        expect(after?.nextRunAt.toISOString()).toBe(before?.nextRunAt.toISOString());
    });

    it("re-registering by name preserves firing history", async () => {
        const clock = createControllableClock("2026-01-01T00:30:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);

        scheduler.onCronFire(async () => undefined);
        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "job",
        });
        clock.set("2026-01-01T01:00:00.000Z");
        await scheduler.tickCron();
        const afterFirst = await storage.getCronSchedule("hourly");

        // Re-register (as if on a fresh boot) with a changed payload.
        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "job",
            payload: "v2",
        });
        const afterReregister = await storage.getCronSchedule("hourly");

        expect(afterReregister?.payload).toBe("v2");
        // History (lastRunAt/nextRunAt) is preserved, not reset.
        expect(afterReregister?.lastRunAt?.toISOString()).toBe(
            afterFirst?.lastRunAt?.toISOString(),
        );
        expect(afterReregister?.nextRunAt.toISOString()).toBe(afterFirst?.nextRunAt.toISOString());
    });

    it("dispatches cron fires from the combined tick alongside one-shot timers", async () => {
        const clock = createControllableClock("2026-01-01T08:59:59.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);

        // A one-shot timer already due.
        await storage.scheduleTimer("wf-1", "wake", new Date("2026-01-01T08:00:00.000Z"), null);

        let cronFires = 0;
        scheduler.onCronFire(async () => {
            cronFires += 1;
        });
        await scheduler.registerCron({
            name: "daily",
            cronExpression: "0 9 * * *",
            workflowName: "report",
        });

        const timerHandlerCalls: string[] = [];
        clock.set("2026-01-01T09:00:00.000Z");
        const timersDispatched = await scheduler.tick(async (timer) => {
            timerHandlerCalls.push(timer.workflowIdentifier);
        });

        expect(timersDispatched).toBe(1);
        expect(timerHandlerCalls).toEqual(["wf-1"]);
        expect(cronFires).toBe(1);
    });

    it("does nothing for cron when no handler is set", async () => {
        const clock = createControllableClock("2026-01-01T09:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const scheduler = buildScheduler(storage, clock.now);
        await scheduler.registerCron({
            name: "daily",
            cronExpression: "0 9 * * *",
            workflowName: "report",
        });
        // No onCronFire handler registered.
        expect(await scheduler.tick(noopTimerHandler)).toBe(0);
        expect(await scheduler.tickCron()).toBe(0);
    });

    it("reports a fire handler failure without stalling the tick", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const reported: string[] = [];
        const scheduler = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            onHandlerError: (name) => reported.push(name),
        });

        scheduler.onCronFire(async () => {
            throw new Error("fire failed");
        });
        await scheduler.registerCron({
            name: "hourly",
            cronExpression: "0 * * * *",
            workflowName: "job",
        });

        clock.set("2026-01-01T01:00:00.000Z");
        // The failing fire is reported, and the schedule still advances.
        await scheduler.tickCron();
        expect(reported).toEqual(["hourly"]);
        const schedule = await storage.getCronSchedule("hourly");
        expect(schedule?.nextRunAt.toISOString()).toBe("2026-01-01T02:00:00.000Z");
    });
});
