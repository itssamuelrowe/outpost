import type { SerializationRecipe } from "./serialization-registry.js";

/**
 * A collection of ready-made {@link SerializationRecipe}s for the JavaScript
 * built-in types that plain JSON cannot represent. Register the ones you need
 * on a {@link SerializationRegistry}, or take them all at once with
 * `SerializationRegistry.getAllBuiltInRecipes()`.
 *
 * These exist because `Date`, `Map`, `Set`, and `bigint` are extremely common
 * in ordinary application data yet are silently corrupted by `JSON.stringify`
 * (a `Date` becomes a string, a `Map` becomes `{}`). Rather than have every
 * project write the same four recipes, Outpost ships them.
 */

/**
 * Persists a `Date` as its epoch-millisecond value and restores it exactly.
 */
export const dateRecipe: SerializationRecipe<Date, number> = {
    name: "Date",
    test: (value): value is Date => value instanceof Date,
    serialize: (value) => value.getTime(),
    deserialize: (data) => new Date(data),
};

/**
 * Persists a `Map` as an array of `[key, value]` pairs. Both keys and values
 * are themselves passed back through the codec, so a `Map<string, Date>`
 * restores its `Date` values correctly.
 */
export const mapRecipe: SerializationRecipe<Map<unknown, unknown>, Array<[unknown, unknown]>> = {
    name: "Map",
    test: (value): value is Map<unknown, unknown> => value instanceof Map,
    serialize: (value) => [...value.entries()],
    deserialize: (data) => new Map(data),
};

/**
 * Persists a `Set` as an array of its members, restored back into a `Set`.
 */
export const setRecipe: SerializationRecipe<Set<unknown>, unknown[]> = {
    name: "Set",
    test: (value): value is Set<unknown> => value instanceof Set,
    serialize: (value) => [...value.values()],
    deserialize: (data) => new Set(data),
};

/**
 * Persists a `bigint` as its decimal string form, since JSON has no bigint type
 * and a `number` would lose precision beyond 2^53.
 */
export const bigintRecipe: SerializationRecipe<bigint, string> = {
    name: "BigInt",
    test: (value): value is bigint => typeof value === "bigint",
    serialize: (value) => value.toString(),
    deserialize: (data) => BigInt(data),
};
