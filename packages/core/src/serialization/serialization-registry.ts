/**
 * A pluggable serialization system that lets values which are not plain JSON
 * data — such as `Date`, `Map`, `Set`, `bigint`, or a domain class instance —
 * be persisted and restored faithfully across the durability boundary.
 *
 * The default behaviour of Outpost is deliberately strict: only plain JSON data
 * round-trips, and everything else is rejected (see the {@link Serializable}
 * type and `assertSerializable`). That strictness is the right default because
 * a silently lossy round-trip is a subtle correctness bug. But real workflows
 * do carry richer values, and rewriting them into plain objects by hand is
 * tedious and error prone.
 *
 * A {@link SerializationRegistry} closes that gap. You register a
 * {@link SerializationRecipe} for each rich type: a predicate that recognises
 * the value, a `serialize` that turns it into plain JSON data, and a
 * `deserialize` that reconstructs it. The registry then encodes any value by
 * walking it, tagging each recognised instance with the recipe that handled it,
 * and decodes by replaying those tags in reverse.
 *
 * The wire format is intentionally simple and self-describing: a recognised
 * value becomes `{ "$outpost": "<recipe-name>", value: <serialized data> }`. A
 * literal object that happens to carry a `$outpost` key is escaped so it cannot
 * be mistaken for a tag, which keeps the format lossless for arbitrary data.
 */

import { bigintRecipe, dateRecipe, mapRecipe, setRecipe } from "./built-in-recipes.js";

/**
 * A recipe describing how one rich type is serialized and restored.
 *
 * `T` is the runtime type being handled (for example `Date`). `S` is the plain,
 * JSON-serializable shape it is stored as (for example the epoch milliseconds
 * as a `number`). Keeping `S` constrained to JSON-native data is what
 * guarantees the serialized form itself round-trips through the underlying JSON
 * codec.
 */
export interface SerializationRecipe<T = unknown, S = unknown> {
    /**
     * A stable, unique name written into the persisted tag. Changing it later
     * breaks the ability to read values written under the old name, so treat it
     * as part of your durable schema.
     */
    readonly name: string;
    /**
     * Recognises whether this recipe handles a value. It must be precise: two
     * recipes must never both claim the same value, or which one wins is
     * decided by registration order rather than intent.
     */
    test(value: unknown): value is T;
    /**
     * Converts a recognised value into plain, JSON-serializable data.
     */
    serialize(value: T): S;
    /**
     * Reconstructs the original value from the data produced by
     * {@link serialize}.
     */
    deserialize(data: S): T;
}

/**
 * The reserved key that marks a serialized rich value on the wire.
 */
const TAG_KEY = "$outpost";

/**
 * The escaped form used when a literal data object itself contains a `$outpost`
 * key, so it is not later mistaken for a tag.
 */
const ESCAPE_KEY = "$outpostEscaped";

/**
 * The tagged wire representation of a value handled by a recipe.
 */
interface TaggedValue {
    [TAG_KEY]: string;
    value: unknown;
}

/**
 * The escaped wire representation of a plain object that collides with the tag.
 */
interface EscapedValue {
    [ESCAPE_KEY]: Record<string, unknown>;
}

/**
 * Holds a set of {@link SerializationRecipe}s and encodes/decodes values to and
 * from binary buffers, applying those recipes so rich types survive the round
 * trip.
 *
 * A registry with no recipes behaves exactly like the engine's default JSON
 * codec, so adopting it is free until you register something. Recipes are
 * consulted in registration order; register the most specific first when two
 * could overlap.
 *
 * You should register (and any unregister) every recipe before running a
 * workflow whose data depends on it: a value written under one set of recipes
 * must be readable under the same set later. Removing a recipe that earlier
 * data was written with will make that data undecodable.
 */
export class SerializationRegistry {
    private readonly recipes: SerializationRecipe[] = [];
    private readonly recipesByName = new Map<string, SerializationRecipe>();

    /**
     * Returns every built-in {@link SerializationRecipe} (for `Date`, `Map`,
     * `Set`, and `bigint`), in a sensible registration order. Convenient for
     * the common case of "just let me use Dates and Maps in my workflow data":
     *
     * ```ts
     * const serialization = new SerializationRegistry();
     * for (const recipe of SerializationRegistry.getAllBuiltInRecipes()) {
     *     serialization.register(recipe);
     * }
     * ```
     *
     * A fresh array is returned each call, so callers may filter or reorder it
     * without affecting anyone else.
     */
    public static getAllBuiltInRecipes(): SerializationRecipe[] {
        // Imported lazily to avoid a load-order cycle with the recipe module, which
        // depends on this file for the SerializationRecipe type.
        return [dateRecipe, mapRecipe, setRecipe, bigintRecipe];
    }

    /**
     * Registers a recipe. Registering two recipes with the same name is an
     * error, because the name is the durable tag used to route decoding.
     *
     * @returns The registry, so registrations can be chained.
     */
    public register<T, S>(recipe: SerializationRecipe<T, S>): this {
        if (this.recipesByName.has(recipe.name)) {
            throw new Error(`A serialization recipe named "${recipe.name}" is already registered.`);
        }
        // Store as the erased type; the type parameters exist only to check the
        // recipe's own internal consistency at the call site.
        const erased = recipe as unknown as SerializationRecipe;
        this.recipes.push(erased);
        this.recipesByName.set(recipe.name, erased);
        return this;
    }

    /**
     * Removes a previously registered recipe by name, so values of its type are
     * no longer specially encoded and the name is freed to be registered
     * again.
     *
     * This is useful when swapping one recipe for another (unregister, then
     * register the replacement) or when a registry is reused across tests. Be
     * deliberate about it in production: any persisted value that was written
     * with this recipe becomes undecodable once it is gone, since decoding
     * routes on the recipe name recorded in the data.
     *
     * @param name The recipe name passed to
     *   {@link SerializationRegistry.register}.
     * @returns `true` if a recipe was removed, `false` if none had that name.
     */
    public unregister(name: string): boolean {
        const existing = this.recipesByName.get(name);
        if (!existing) {
            return false;
        }
        this.recipesByName.delete(name);
        const index = this.recipes.indexOf(existing);
        if (index !== -1) {
            this.recipes.splice(index, 1);
        }
        return true;
    }

    /**
     * Whether a recipe with the given name is currently registered.
     */
    public has(name: string): boolean {
        return this.recipesByName.has(name);
    }

    /**
     * The names of every registered recipe, in registration order.
     */
    public get registeredRecipeNames(): string[] {
        return this.recipes.map((recipe) => recipe.name);
    }

    /**
     * Encodes a value to a UTF-8 JSON buffer, applying recipes as it walks the
     * value. This is a drop-in for the engine's `encode` option.
     */
    public encode(value: unknown): Buffer {
        const transformed = this.applyRecipes(value, new Set());
        return Buffer.from(JSON.stringify(transformed ?? null), "utf8");
    }

    /**
     * Decodes a buffer produced by {@link SerializationRegistry.encode},
     * replaying the recipe tags to reconstruct rich values. This is a drop-in
     * for the engine's `decode` option.
     */
    public decode(raw: Buffer): unknown {
        const parsed = JSON.parse(raw.toString("utf8"));
        return this.reviveRecipes(parsed);
    }

    /**
     * Walks a value, replacing every value a recipe recognises with its tagged
     * form and escaping any literal object that would collide with the tag.
     *
     * Recognition is attempted before descent so that a rich value is handled
     * as a unit; its serialized data is then itself walked, allowing recipes to
     * nest (for example a `Map` whose values are `Date`s).
     */
    private applyRecipes(value: unknown, seen: Set<object>): unknown {
        // Primitives (and null) pass straight through.
        if (value === null || typeof value !== "object") {
            // A recipe may still claim a non-object primitive (for example a bigint,
            // which is typeof "bigint", handled below in the recipe scan).
            const recipe = this.findRecipeFor(value);
            if (recipe) {
                return this.tag(recipe, value, seen);
            }
            return value;
        }

        const objectValue = value as object;
        if (seen.has(objectValue)) {
            throw new Error(
                "Cannot serialize a circular reference; break the cycle before persisting.",
            );
        }

        // A recipe takes precedence over structural walking, so rich objects like
        // Date or Map are handled as whole units rather than descended into raw.
        const recipe = this.findRecipeFor(value);
        if (recipe) {
            return this.tag(recipe, value, seen);
        }

        seen.add(objectValue);
        try {
            if (Array.isArray(objectValue)) {
                return objectValue.map((element) => this.applyRecipes(element, seen));
            }

            // A plain object carrying the reserved key is escaped so it is not later
            // read back as a tag. Everything else is walked property by property.
            const entries = Object.entries(objectValue);
            const transformed: Record<string, unknown> = {};
            for (const [key, propertyValue] of entries) {
                transformed[key] = this.applyRecipes(propertyValue, seen);
            }
            if (TAG_KEY in transformed || ESCAPE_KEY in transformed) {
                return { [ESCAPE_KEY]: transformed } satisfies EscapedValue;
            }
            return transformed;
        } finally {
            seen.delete(objectValue);
        }
    }

    /**
     * Produces the tagged wire form for a value handled by `recipe`.
     */
    private tag(recipe: SerializationRecipe, value: unknown, seen: Set<object>): TaggedValue {
        const serialized = recipe.serialize(value);
        // The serialized data may itself contain rich values, so walk it too.
        return { [TAG_KEY]: recipe.name, value: this.applyRecipes(serialized, seen) };
    }

    /**
     * Walks a decoded JSON value, reconstructing tagged values through their
     * recipes and unwrapping escaped objects.
     */
    private reviveRecipes(value: unknown): unknown {
        if (value === null || typeof value !== "object") {
            return value;
        }

        if (Array.isArray(value)) {
            return value.map((element) => this.reviveRecipes(element));
        }

        const record = value as Record<string, unknown>;

        // An escaped object is unwrapped by reviving each of its properties, but
        // the unwrapped object itself is NOT re-scanned as a tag: it was escaped
        // precisely because it carries the reserved key as ordinary data.
        if (ESCAPE_KEY in record) {
            const escaped = record[ESCAPE_KEY] as Record<string, unknown>;
            const revived: Record<string, unknown> = {};
            for (const [key, propertyValue] of Object.entries(escaped)) {
                revived[key] = this.reviveRecipes(propertyValue);
            }
            return revived;
        }

        // A tagged value is routed to its recipe. Its inner data is revived first so
        // nested rich values are reconstructed before the outer recipe runs.
        if (TAG_KEY in record) {
            const recipeName = record[TAG_KEY];
            if (typeof recipeName !== "string") {
                throw new Error("Encountered a malformed serialization tag.");
            }
            const recipe = this.recipesByName.get(recipeName);
            if (!recipe) {
                throw new Error(
                    `No serialization recipe named "${recipeName}" is registered, so the persisted value cannot be decoded. ` +
                        `Register the recipe before reading data written with it.`,
                );
            }
            const revivedData = this.reviveRecipes(record.value);
            return recipe.deserialize(revivedData);
        }

        const revived: Record<string, unknown> = {};
        for (const [key, propertyValue] of Object.entries(record)) {
            revived[key] = this.reviveRecipes(propertyValue);
        }
        return revived;
    }

    /**
     * Finds the first registered recipe that recognises a value, if any.
     */
    private findRecipeFor(value: unknown): SerializationRecipe | undefined {
        for (const recipe of this.recipes) {
            if (recipe.test(value)) {
                return recipe;
            }
        }
        return undefined;
    }
}
