import { describe, expect, it } from "vitest";

import {
    SerializationRegistry,
    type SerializationRecipe,
} from "../src/serialization/serialization-registry.js";
import {
    bigintRecipe,
    dateRecipe,
    mapRecipe,
    setRecipe,
} from "../src/serialization/built-in-recipes.js";

/**
 * Round-trips a value through a registry and returns the decoded result.
 */
function roundTrip(registry: SerializationRegistry, value: unknown): unknown {
    return registry.decode(registry.encode(value));
}

describe("SerializationRegistry", () => {
    it("round-trips plain JSON data unchanged with no recipes", () => {
        const registry = new SerializationRegistry();
        const value = { a: 1, b: "two", c: [true, null, { d: 3 }] };
        expect(roundTrip(registry, value)).toEqual(value);
    });

    it("round-trips primitives and null", () => {
        const registry = new SerializationRegistry();
        expect(roundTrip(registry, null)).toBeNull();
        expect(roundTrip(registry, 42)).toBe(42);
        expect(roundTrip(registry, "hello")).toBe("hello");
        expect(roundTrip(registry, true)).toBe(true);
    });

    it("restores a Date to an equal Date instance", () => {
        const registry = new SerializationRegistry().register(dateRecipe);
        const date = new Date("2024-06-01T12:34:56.000Z");
        const decoded = roundTrip(registry, date);
        expect(decoded).toBeInstanceOf(Date);
        expect((decoded as Date).getTime()).toBe(date.getTime());
    });

    it("restores a Map, including rich values nested inside it", () => {
        const registry = new SerializationRegistry().register(dateRecipe).register(mapRecipe);
        const map = new Map<string, Date>([
            ["a", new Date("2024-01-01T00:00:00.000Z")],
            ["b", new Date("2024-02-02T00:00:00.000Z")],
        ]);
        const decoded = roundTrip(registry, map) as Map<string, Date>;
        expect(decoded).toBeInstanceOf(Map);
        expect(decoded.get("a")).toBeInstanceOf(Date);
        expect(decoded.get("a")?.getTime()).toBe(map.get("a")?.getTime());
        expect(decoded.get("b")?.getTime()).toBe(map.get("b")?.getTime());
    });

    it("restores a Set", () => {
        const registry = new SerializationRegistry().register(setRecipe);
        const set = new Set([1, 2, 3]);
        const decoded = roundTrip(registry, set) as Set<number>;
        expect(decoded).toBeInstanceOf(Set);
        expect([...decoded]).toEqual([1, 2, 3]);
    });

    it("restores a bigint without precision loss", () => {
        const registry = new SerializationRegistry().register(bigintRecipe);
        const value = 9_007_199_254_740_993n; // 2^53 + 1, beyond safe integer range
        const decoded = roundTrip(registry, value);
        expect(typeof decoded).toBe("bigint");
        expect(decoded).toBe(value);
    });

    it("handles rich values nested inside plain objects and arrays", () => {
        const registry = new SerializationRegistry();
        for (const recipe of SerializationRegistry.getAllBuiltInRecipes()) {
            registry.register(recipe);
        }
        const value = {
            when: new Date("2024-03-03T03:03:03.000Z"),
            tags: new Set(["x", "y"]),
            counts: new Map<string, bigint>([["big", 10n]]),
            list: [new Date(0), { nested: new Date(1000) }],
        };
        const decoded = roundTrip(registry, value) as typeof value;
        expect(decoded.when).toBeInstanceOf(Date);
        expect(decoded.tags).toBeInstanceOf(Set);
        expect(decoded.counts.get("big")).toBe(10n);
        expect((decoded.list[0] as Date).getTime()).toBe(0);
        expect((decoded.list[1] as { nested: Date }).nested.getTime()).toBe(1000);
    });

    it("escapes literal objects that collide with the reserved tag key", () => {
        const registry = new SerializationRegistry().register(dateRecipe);
        // A user's own data legitimately contains the reserved key. It must survive
        // the round trip as ordinary data rather than being read back as a tag.
        const value = { $outpost: "not-a-tag", other: 1 };
        expect(roundTrip(registry, value)).toEqual(value);
    });

    it("escapes nested objects that carry the reserved key", () => {
        const registry = new SerializationRegistry().register(dateRecipe);
        const value = { outer: { $outpost: "still-data", when: new Date(5000) } };
        const decoded = roundTrip(registry, value) as {
            outer: { $outpost: string; when: Date };
        };
        expect(decoded.outer.$outpost).toBe("still-data");
        expect(decoded.outer.when).toBeInstanceOf(Date);
        expect(decoded.outer.when.getTime()).toBe(5000);
    });

    it("supports a custom recipe for a domain class instance", () => {
        class Money {
            public constructor(
                public readonly cents: number,
                public readonly currency: string,
            ) {}
        }
        const moneyRecipe: SerializationRecipe<Money, { cents: number; currency: string }> = {
            name: "Money",
            test: (value): value is Money => value instanceof Money,
            serialize: (value) => ({ cents: value.cents, currency: value.currency }),
            deserialize: (data) => new Money(data.cents, data.currency),
        };
        const registry = new SerializationRegistry().register(moneyRecipe);
        const decoded = roundTrip(registry, new Money(1999, "USD")) as Money;
        expect(decoded).toBeInstanceOf(Money);
        expect(decoded.cents).toBe(1999);
        expect(decoded.currency).toBe("USD");
    });

    it("exposes registered recipe names in registration order", () => {
        const registry = new SerializationRegistry().register(dateRecipe).register(mapRecipe);
        expect(registry.registeredRecipeNames).toEqual(["Date", "Map"]);
    });

    it("reports whether a recipe name is registered via has()", () => {
        const registry = new SerializationRegistry().register(dateRecipe);
        expect(registry.has("Date")).toBe(true);
        expect(registry.has("Map")).toBe(false);
    });

    it("rejects two recipes registered under the same name", () => {
        const registry = new SerializationRegistry().register(dateRecipe);
        expect(() => registry.register({ ...dateRecipe })).toThrow(/already registered/);
    });

    it("throws when decoding a value whose recipe is not registered", () => {
        const writer = new SerializationRegistry().register(dateRecipe);
        const encoded = writer.encode(new Date(0));
        const reader = new SerializationRegistry(); // no recipes
        expect(() => reader.decode(encoded)).toThrow(/No serialization recipe named "Date"/);
    });

    it("rejects a circular reference during encoding", () => {
        const registry = new SerializationRegistry();
        const cyclic: Record<string, unknown> = {};
        cyclic.self = cyclic;
        expect(() => registry.encode(cyclic)).toThrow(/circular reference/);
    });

    describe("unregister", () => {
        it("removes a recipe so its type is no longer specially encoded", () => {
            const registry = new SerializationRegistry().register(dateRecipe);
            expect(registry.unregister("Date")).toBe(true);
            expect(registry.has("Date")).toBe(false);
            expect(registry.registeredRecipeNames).toEqual([]);

            // With the recipe gone, a Date is no longer recognised, so it is walked
            // as an ordinary object and no longer round-trips as a Date instance.
            const decoded = roundTrip(registry, new Date("2024-01-01T00:00:00.000Z"));
            expect(decoded).not.toBeInstanceOf(Date);
        });

        it("returns false when unregistering a name that was never registered", () => {
            const registry = new SerializationRegistry();
            expect(registry.unregister("Nope")).toBe(false);
        });

        it("frees the name so it can be registered again", () => {
            const registry = new SerializationRegistry().register(dateRecipe);
            expect(() => registry.register({ ...dateRecipe })).toThrow(/already registered/);
            registry.unregister("Date");
            expect(() => registry.register({ ...dateRecipe })).not.toThrow();
            expect(registry.has("Date")).toBe(true);
        });

        it("supports swapping one recipe implementation for another", () => {
            // First recipe stores a Date as epoch ms; the replacement stores it as an
            // ISO string. After the swap, new encodes use the replacement.
            const isoDateRecipe: SerializationRecipe<Date, string> = {
                name: "Date",
                test: (value): value is Date => value instanceof Date,
                serialize: (value) => value.toISOString(),
                deserialize: (data) => new Date(data),
            };
            const registry = new SerializationRegistry().register(dateRecipe);
            registry.unregister("Date");
            registry.register(isoDateRecipe);

            const date = new Date("2024-05-05T05:05:05.000Z");
            const decoded = roundTrip(registry, date) as Date;
            expect(decoded).toBeInstanceOf(Date);
            expect(decoded.getTime()).toBe(date.getTime());
        });

        it("only removes the named recipe, leaving the rest intact", () => {
            const registry = new SerializationRegistry()
                .register(dateRecipe)
                .register(mapRecipe)
                .register(setRecipe);
            registry.unregister("Map");
            expect(registry.registeredRecipeNames).toEqual(["Date", "Set"]);

            const decoded = roundTrip(registry, {
                when: new Date(0),
                tags: new Set([1]),
            }) as { when: Date; tags: Set<number> };
            expect(decoded.when).toBeInstanceOf(Date);
            expect(decoded.tags).toBeInstanceOf(Set);
        });
    });
});
