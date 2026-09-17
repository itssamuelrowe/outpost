import { describe, expect, it } from "vitest";

import { WorkflowEngine } from "../src/engine/workflow-engine.js";
import { MemoryStorage } from "../src/storage/memory-storage.js";
import {
    NonSerializableValueError,
    assertSerializable,
} from "../src/utilities/serialization.utility.js";

describe("assertSerializable", () => {
    it("accepts primitives, plain objects, and arrays", () => {
        expect(() => assertSerializable(null, "value")).not.toThrow();
        expect(() => assertSerializable(42, "value")).not.toThrow();
        expect(() => assertSerializable("text", "value")).not.toThrow();
        expect(() => assertSerializable([1, "two", { three: 3 }], "value")).not.toThrow();
        expect(() => assertSerializable({ a: { b: [true, false] } }, "value")).not.toThrow();
    });

    it("rejects common non-serializable values with a helpful path", () => {
        expect(() => assertSerializable(new Date(), "value")).toThrow(NonSerializableValueError);
        expect(() => assertSerializable(() => 1, "value")).toThrow(/is a function/);
        expect(() => assertSerializable(new Map(), "value")).toThrow(/instance of Map/);
        expect(() => assertSerializable({ when: new Date() }, "value")).toThrow(/\$\.when/);
        expect(() => assertSerializable(Number.NaN, "value")).toThrow(/non-finite/);
        expect(() => assertSerializable(10n, "value")).toThrow(/bigint/);
    });

    it("detects circular references", () => {
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(() => assertSerializable(cyclic, "value")).toThrow(/circular/);
    });
});

describe("runtime serialization validation in the engine", () => {
    it("throws when a step returns a non-serializable value and validation is on", async () => {
        const engine = new WorkflowEngine(new MemoryStorage(), { validateSerializable: true });
        engine.defineWorkflow("bad-step", async (context) =>
            context.step("returns-date", async () => ({ createdAt: new Date() }) as never),
        );

        await expect(engine.run("bad-step", "workflow-1", null)).rejects.toBeInstanceOf(
            NonSerializableValueError,
        );
    });

    it("does not validate when the option is off (default)", async () => {
        const engine = new WorkflowEngine(new MemoryStorage());
        // A Date survives the default JSON codec as a string, so with validation off
        // this does not throw at persistence time.
        engine.defineWorkflow("lenient", async (context) =>
            context.step("returns-date", async () => ({ createdAt: new Date().toISOString() })),
        );

        await expect(engine.run("lenient", "workflow-1", null)).resolves.toBeDefined();
    });
});
