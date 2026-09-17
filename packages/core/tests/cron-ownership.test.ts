import { describe, expect, it } from "vitest";

import { MemoryStorage } from "../src/storage/memory-storage.js";
import { Scheduler } from "../src/scheduler/scheduler.js";

/**
 * A mutable clock so tests can move time forward deterministically.
 */
function createControllableClock(startIso: string): {
    now: () => Date;
    advance: (ms: number) => void;
    set: (iso: string) => void;
} {
    let current = new Date(startIso);
    return {
        now: () => current,
        advance: (ms: number) => {
            current = new Date(current.getTime() + ms);
        },
        set: (iso: string) => {
            current = new Date(iso);
        },
    };
}

/**
 * Registers `count` hourly schedules named job-0..job-(count-1) on a shared
 * store.
 */
async function seedSchedules(control: Scheduler, count: number): Promise<void> {
    for (let i = 0; i < count; i += 1) {
        await control.registerCron({
            name: `job-${i}`,
            cronExpression: "0 * * * *",
            workflowName: `job-${i}`,
        });
    }
}

describe("cron schedule ownership", () => {
    it("requires an explicit capacity and rejects invalid values", () => {
        // A positive integer and "all" are valid.
        expect(
            () => new Scheduler(new MemoryStorage(), { ownership: { capacity: 5 } }),
        ).not.toThrow();
        expect(
            () => new Scheduler(new MemoryStorage(), { ownership: { capacity: "all" } }),
        ).not.toThrow();
        // Zero, negatives, and non-integers are rejected up front.
        expect(() => new Scheduler(new MemoryStorage(), { ownership: { capacity: 0 } })).toThrow(
            /capacity/i,
        );
        expect(() => new Scheduler(new MemoryStorage(), { ownership: { capacity: -1 } })).toThrow(
            /capacity/i,
        );
    });

    it("bounds a process to its capacity and never lets two own the same schedule", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const control = new Scheduler(storage, { now: clock.now });
        await seedSchedules(control, 10);

        const a = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            ownership: { processId: "A", capacity: 3, leaseTtlMilliseconds: 30_000 },
        });
        const b = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            ownership: { processId: "B", capacity: 3, leaseTtlMilliseconds: 30_000 },
        });
        a.onCronFire(async () => undefined);
        b.onCronFire(async () => undefined);

        await a.tickCron();
        await b.tickCron();

        const schedules = await storage.listCronSchedules();
        const ownedByA = schedules.filter((s) => s.leaseOwner === "A");
        const ownedByB = schedules.filter((s) => s.leaseOwner === "B");

        expect(ownedByA.length).toBeLessThanOrEqual(3);
        expect(ownedByB.length).toBeLessThanOrEqual(3);

        const namesA = new Set(ownedByA.map((s) => s.name));
        for (const s of ownedByB) {
            expect(namesA.has(s.name)).toBe(false);
        }
        expect(ownedByA.length + ownedByB.length).toBe(6);
    });

    it("with the safety net off, fires only the schedules a process owns", async () => {
        const clock = createControllableClock("2026-01-01T00:30:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const control = new Scheduler(storage, { now: clock.now });
        await seedSchedules(control, 4);

        const a = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            ownership: {
                processId: "A",
                capacity: 2,
                leaseTtlMilliseconds: 30_000,
                fireUnownedAsSafetyNet: false,
            },
        });
        const firedByA: string[] = [];
        a.onCronFire(async ({ schedule }) => {
            firedByA.push(schedule.name);
        });

        await a.tickCron();
        const owned = (await storage.listCronSchedules())
            .filter((s) => s.leaseOwner === "A")
            .map((s) => s.name)
            .sort();
        expect(owned).toHaveLength(2);

        clock.set("2026-01-01T01:00:00.000Z");
        const dispatched = await a.tickCron();
        expect(dispatched).toBe(2);
        expect(firedByA.sort()).toEqual(owned);
    });

    it("the safety net fires due-but-unowned schedules so none starve", async () => {
        // Two processes of capacity 50 for 101 schedules: 100 owned, 1 left over.
        const clock = createControllableClock("2026-01-01T00:30:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const control = new Scheduler(storage, { now: clock.now });
        await seedSchedules(control, 101);

        // Lease TTL comfortably longer than the gap between ticks so live owners
        // keep their slice across the jump to the due time; only the genuine
        // leftover is unowned.
        const ttl = 2 * 60 * 60 * 1000; // 2 hours
        let orphanReports = 0;
        const a = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            batchSize: 200,
            ownership: { processId: "A", capacity: 50, leaseTtlMilliseconds: ttl },
            onUnownedSchedulesDetected: (n) => (orphanReports += n),
        });
        const b = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            batchSize: 200,
            ownership: { processId: "B", capacity: 50, leaseTtlMilliseconds: ttl },
        });

        const fired = new Set<string>();
        const record = async ({ schedule }: { schedule: { name: string } }) => {
            fired.add(schedule.name);
        };
        a.onCronFire(record);
        b.onCronFire(record);

        // First tick at 00:30 lets each acquire its 50; nothing due yet.
        await a.tickCron();
        await b.tickCron();

        const owned = (await storage.listCronSchedules()).filter((s) => s.leaseOwner !== null);
        expect(owned).toHaveLength(100); // exactly one schedule remains unowned

        // At 01:00 everything is due. A owns 50 and, via the net, also sweeps the
        // one orphan; B owns its 50. Together all 101 fire.
        clock.set("2026-01-01T01:00:00.000Z");
        await a.tickCron();
        await b.tickCron();

        expect(fired.size).toBe(101);
        expect(orphanReports).toBe(1); // the leftover was detected and reported
    });

    it("capacity 'all' owns and fires every schedule", async () => {
        const clock = createControllableClock("2026-01-01T00:30:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const control = new Scheduler(storage, { now: clock.now });
        await seedSchedules(control, 5);

        const a = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            ownership: { processId: "A", capacity: "all", leaseTtlMilliseconds: 30_000 },
        });
        const fired: string[] = [];
        a.onCronFire(async ({ schedule }) => {
            fired.push(schedule.name);
        });

        await a.tickCron();
        expect(
            (await storage.listCronSchedules()).filter((s) => s.leaseOwner === "A"),
        ).toHaveLength(5);

        clock.set("2026-01-01T01:00:00.000Z");
        const dispatched = await a.tickCron();
        expect(dispatched).toBe(5);
        expect(fired).toHaveLength(5);
    });

    it("redistributes a crashed process's schedules after the lease expires", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const control = new Scheduler(storage, { now: clock.now });
        await seedSchedules(control, 4);

        const ttl = 30_000;
        const a = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            ownership: { processId: "A", capacity: 4, leaseTtlMilliseconds: ttl },
        });
        a.onCronFire(async () => undefined);

        await a.tickCron();
        expect(
            (await storage.listCronSchedules()).filter((s) => s.leaseOwner === "A"),
        ).toHaveLength(4);

        const b = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            ownership: { processId: "B", capacity: 4, leaseTtlMilliseconds: ttl },
        });
        b.onCronFire(async () => undefined);
        await b.tickCron();
        expect(
            (await storage.listCronSchedules()).filter((s) => s.leaseOwner === "B"),
        ).toHaveLength(0);

        clock.advance(ttl + 1);
        await b.tickCron();
        const ownedByB = (await storage.listCronSchedules()).filter((s) => s.leaseOwner === "B");
        expect(ownedByB).toHaveLength(4);
    });

    it("renews leases so a live owner keeps its schedules", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const control = new Scheduler(storage, { now: clock.now });
        await seedSchedules(control, 2);

        const ttl = 30_000;
        const a = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            ownership: { processId: "A", capacity: 2, leaseTtlMilliseconds: ttl },
        });
        a.onCronFire(async () => undefined);

        await a.tickCron();
        const firstExpiry = (await storage.getCronSchedule("job-0"))?.leaseExpiresAt?.getTime();

        clock.advance(ttl / 2);
        await a.tickCron();
        const renewedExpiry = (await storage.getCronSchedule("job-0"))?.leaseExpiresAt?.getTime();

        expect(renewedExpiry).toBeGreaterThan(firstExpiry ?? 0);

        const b = new Scheduler(storage, {
            now: clock.now,
            cronJitterMilliseconds: 0,
            ownership: { processId: "B", capacity: 2, leaseTtlMilliseconds: ttl },
        });
        b.onCronFire(async () => undefined);
        await b.tickCron();
        expect(
            (await storage.listCronSchedules()).filter((s) => s.leaseOwner === "B"),
        ).toHaveLength(0);
    });

    it("releases leases on stop so peers can take over immediately", async () => {
        const clock = createControllableClock("2026-01-01T00:00:00.000Z");
        const storage = new MemoryStorage(clock.now);
        const control = new Scheduler(storage, { now: clock.now });
        await seedSchedules(control, 3);

        const a = new Scheduler(storage, {
            now: clock.now,
            pollIntervalMilliseconds: 5,
            cronJitterMilliseconds: 0,
            ownership: { processId: "A", capacity: 3, leaseTtlMilliseconds: 60_000 },
        });
        a.onCronFire(async () => undefined);

        await a.tickCron();
        expect(
            (await storage.listCronSchedules()).filter((s) => s.leaseOwner === "A"),
        ).toHaveLength(3);

        a.start(async () => undefined);
        await a.stop();

        const stillOwned = (await storage.listCronSchedules()).filter((s) => s.leaseOwner !== null);
        expect(stillOwned).toHaveLength(0);
    });

    it("exposes the process id and defaults it when omitted", () => {
        const withId = new Scheduler(new MemoryStorage(), {
            ownership: { processId: "fixed", capacity: 1 },
        });
        expect(withId.processId).toBe("fixed");

        const generated = new Scheduler(new MemoryStorage(), {
            ownership: { capacity: 1 },
        });
        expect(generated.processId).toMatch(/^scheduler-/);

        const noOwnership = new Scheduler(new MemoryStorage());
        expect(noOwnership.processId).toBeNull();
    });
});
