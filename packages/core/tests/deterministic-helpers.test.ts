import { describe, expect, it } from "vitest";

import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";

/**
 * A clock the test can advance so we can prove `now` is recorded, not re-read.
 */
function controllableClock(): { now: () => Date; advance: (ms: number) => void } {
    let current = new Date("2024-01-01T00:00:00.000Z");
    return {
        now: () => current,
        advance: (ms) => {
            current = new Date(current.getTime() + ms);
        },
    };
}

describe("deterministic helpers", () => {
    describe("ctx.now", () => {
        it("returns the current instant as epoch milliseconds", async () => {
            const clock = controllableClock();
            const storage = new MemoryStorage(clock.now);
            const engine = new WorkflowEngine(storage, { now: clock.now });

            engine.defineWorkflow<null, number>("w", async (context) => context.now("start"));

            const result = await engine.run<null, number>("w", "w1", null);
            expect(result).toBe(new Date("2024-01-01T00:00:00.000Z").getTime());
        });

        it("records the instant once and returns the same value on resume", async () => {
            const clock = controllableClock();
            const storage = new MemoryStorage(clock.now);
            const engine = new WorkflowEngine(storage, { now: clock.now });

            engine.defineWorkflow<null, number>("w", async (context) => context.now("start"));

            const first = await engine.run<null, number>("w", "w1", null);
            clock.advance(60_000); // an hour of wall-clock movement between resumes
            const second = await engine.run<null, number>("w", "w1", null);
            expect(second).toBe(first);
        });

        it("keeps distinct keys independent", async () => {
            const clock = controllableClock();
            const storage = new MemoryStorage(clock.now);
            const engine = new WorkflowEngine(storage, { now: clock.now });

            let firstReadDone = false;
            engine.defineWorkflow<null, { a: number; b: number }>("w", async (context) => {
                const a = await context.now("a");
                if (!firstReadDone) {
                    firstReadDone = true;
                    clock.advance(5_000);
                }
                const b = await context.now("b");
                return { a, b };
            });

            const result = await engine.run<null, { a: number; b: number }>("w", "w1", null);
            expect(result.b - result.a).toBe(5_000);
        });
    });

    describe("ctx.randomUUID", () => {
        it("returns a UUID from the injected generator", async () => {
            const storage = new MemoryStorage();
            const ids = ["11111111-1111-4111-8111-111111111111"];
            let index = 0;
            const engine = new WorkflowEngine(storage, { uuid: () => ids[index++] });

            engine.defineWorkflow<null, string>("w", async (context) => context.randomUUID("id"));

            expect(await engine.run<null, string>("w", "w1", null)).toBe(ids[0]);
        });

        it("records the id once and returns the same value on resume", async () => {
            const storage = new MemoryStorage();
            let counter = 0;
            const engine = new WorkflowEngine(storage, {
                uuid: () => `id-${(counter += 1)}`,
            });

            engine.defineWorkflow<null, string>("w", async (context) => context.randomUUID("id"));

            const first = await engine.run<null, string>("w", "w1", null);
            const second = await engine.run<null, string>("w", "w1", null);
            expect(first).toBe("id-1");
            expect(second).toBe("id-1"); // not id-2: the generator was not called again
        });

        it("produces distinct ids for distinct keys", async () => {
            const storage = new MemoryStorage();
            let counter = 0;
            const engine = new WorkflowEngine(storage, { uuid: () => `id-${(counter += 1)}` });

            engine.defineWorkflow<null, [string, string]>("w", async (context) => {
                const a = await context.randomUUID("a");
                const b = await context.randomUUID("b");
                return [a, b];
            });

            const [a, b] = await engine.run<null, [string, string]>("w", "w1", null);
            expect(a).not.toBe(b);
        });

        it("falls back to a UUID-shaped value when no generator is injected", async () => {
            const storage = new MemoryStorage();
            const engine = new WorkflowEngine(storage);
            engine.defineWorkflow<null, string>("w", async (context) => context.randomUUID("id"));

            const id = await engine.run<null, string>("w", "w1", null);
            expect(id).toMatch(
                /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
            );
        });
    });
});
