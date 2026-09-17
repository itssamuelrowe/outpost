---
id: serialization
title: Serialization
---

# Serialization

Every value that crosses a durability boundary in Outpost is stored as data and read back on a later run. That includes a workflow's input and output, and every step's result. Because those values are persisted and restored, sometimes minutes later, sometimes after a crash and restart, Outpost is careful about exactly what is allowed to make the trip and how it is encoded. This page explains the whole model: the strict default, why it exists, and how the serialization registry lets you extend it to rich types.

## The default: plain JSON data only

By default, Outpost encodes values as UTF-8 JSON. Only plain JSON-native data round-trips safely through that: `null`, booleans, finite numbers, strings, arrays of those, and plain objects whose properties are those.

This is enforced at two levels.

### Compile time: the `Serializable` type

Step results are typed with the `Serializable` type, a structural, recursive type that permits exactly the values above. It is a strong compile-time nudge: returning a `Date`, a `Map`, a class instance, or a function from a step does not compile.

```ts
// Compiles: plain data.
await context.step("total", async () => ({ amount: 42, currency: "USD" }));

// Does NOT compile: Date is not Serializable.
await context.step("stamp", async () => new Date());
```

Workflow input and output use a looser companion type, `SerializableInput`, which accepts any object or array shape. This is a pragmatic concession: TypeScript does not give ordinary `interface` declarations an implicit index signature, so requiring the strict type at the workflow boundary would force every consumer to rewrite their input interfaces. The looser type still rejects the obviously-wrong top-level values (functions, `undefined`, `bigint`, `symbol`), and deep serializability is checked at runtime when you opt in (below).

### Runtime: `validateSerializable`

The compile-time type can be bypassed with an `as` cast. As a safety net, the engine has an opt-in runtime check:

```ts
const engine = new WorkflowEngine(storage, { validateSerializable: true });
```

With this on, every value about to be persisted is walked before it is encoded, and a non-serializable value (a `Date`, a cycle, a non-finite number, a class instance) throws a clear error naming the offending path, rather than silently corrupting persisted state or failing on a later resume. It is off by default to avoid the traversal cost on every step; turning it on in development and tests is a good habit.

### Why so strict?

A silently lossy round-trip is one of the nastiest bugs in a durable system. `JSON.stringify(new Date())` produces a string; parse it back and you have a string, not a `Date`. `JSON.stringify(new Map())` produces `{}`; your data is simply gone. None of this errors at the time. It surfaces much later, on a resume, as a workflow that behaves subtly wrong. Outpost refuses that class of bug by default and asks you to be explicit when you want more.

## Extending it: the serialization registry

Real application data carries `Date`s, `Map`s, `Set`s, `bigint`s, and domain value objects all the time. Rewriting each into plain data by hand at every boundary is tedious and easy to get wrong. A `SerializationRegistry` lets you teach Outpost how to persist and restore those types once, centrally.

Register the recipes you need and hand the registry to the engine:

```ts
import { SerializationRegistry, WorkflowEngine } from "@outpost/core";

const serialization = new SerializationRegistry();
for (const recipe of SerializationRegistry.getAllBuiltInRecipes()) {
    serialization.register(recipe);
}

const engine = new WorkflowEngine(storage, { serialization });
```

From then on the engine uses the registry to encode and decode every persisted value. A registry with no recipes behaves exactly like the default JSON codec, so adopting one costs nothing until you register something.

The `serialization` option is mutually exclusive with the lower-level `encode`/`decode` options: they configure the same slot. Use `encode`/`decode` only for a wholly custom format (a binary codec, say); use `serialization` for the recipe-based approach.

## Built-in recipes

Outpost ships recipes for the common JavaScript built-ins that JSON cannot represent:

| Recipe         | Handles  | Stored as                     |
| -------------- | -------- | ----------------------------- |
| `dateRecipe`   | `Date`   | epoch milliseconds            |
| `mapRecipe`    | `Map`    | array of `[key, value]` pairs |
| `setRecipe`    | `Set`    | array of members              |
| `bigintRecipe` | `bigint` | decimal string                |

Register them individually, or take them all with `SerializationRegistry.getAllBuiltInRecipes()`. Recipes compose: a `Map<string, Date>` restores its `Date` values correctly because the map's serialized entries are themselves passed back through the registry.

## Writing a custom recipe

A recipe is three things: a stable `name`, a `test` that recognises the value, and a `serialize`/`deserialize` pair converting to and from plain data.

```ts
import type { SerializationRecipe } from "@outpost/core";

class Money {
    constructor(
        readonly cents: number,
        readonly currency: string,
    ) {}
}

interface MoneyData {
    cents: number;
    currency: string;
}

const moneyRecipe: SerializationRecipe<Money, MoneyData> = {
    name: "Money",
    test: (value): value is Money => value instanceof Money,
    serialize: (money) => ({ cents: money.cents, currency: money.currency }),
    deserialize: (data) => new Money(data.cents, data.currency),
};

serialization.register(moneyRecipe);
```

The serialized shape (`MoneyData` here) must itself be plain JSON data, which guarantees it round-trips through the underlying JSON layer. It may contain other rich values that other recipes handle; the registry walks it.

### Rules for a good recipe

- **The `name` is durable schema.** It is written into the persisted data as a tag. Changing it, or removing the recipe, makes values written under it unreadable. Treat it like a database column name.
- **`test` must be precise.** Two recipes must never both claim the same value; if they can overlap, register the more specific one first, since recipes are consulted in registration order.
- **Register every recipe before running any workflow whose data needs it.** A value written under one set of recipes must be readable under the same set later. Decoding a value whose recipe is absent raises a clear error rather than guessing.

## Inspecting and removing recipes

The registry exposes a few management calls:

```ts
serialization.registeredRecipeNames; // ["Date", "Map", "Set", "BigInt", "Money"]
serialization.has("Money"); // true

serialization.unregister("Money"); // true (removed); false if it was not registered
serialization.has("Money"); // false
```

`unregister(name)` removes a recipe so its type is no longer specially encoded and frees the name to be registered again. Two common uses:

- **Swapping an implementation.** Unregister the old recipe, then register a replacement under the same name (for example, changing how a `Date` is stored). New encodes use the replacement.
- **Reusing a registry across tests.** Reset between cases without building a new registry each time.

Be deliberate about unregistering in production. Decoding routes on the recipe name recorded in each persisted value, so any data already written with a recipe becomes undecodable once that recipe is removed. Only remove a recipe when you are sure no live workflow data depends on it, or when you are immediately registering a compatible replacement under the same name.

## The wire format

You do not normally need to think about the encoding, but it is not a mystery. A value a recipe recognises is stored as:

```json
{ "$outpost": "<recipe-name>", "value": <serialized data> }
```

If one of your own plain objects happens to contain a `$outpost` key, it is escaped on the way in and unwrapped on the way out, so it is never mistaken for a tag. This keeps the format lossless for arbitrary data: any object you can express, you can persist.

## Recipes and the `Serializable` type, together

A registry changes what is safe **at runtime**, not what the `Serializable` type accepts **at compile time**. In practice:

- **Workflow input and output** already accept object shapes (`SerializableInput`), so rich values flow through them naturally once a recipe exists.
- **Step results** are typed strictly with `Serializable`. Keep step results as plain data where you can; it is the safest default and reads clearly. When you deliberately return a rich value from a step, opt out of the strict type at that one call and let the registry carry it, ideally with `validateSerializable` on in development so a genuine mistake still surfaces.

A good pattern is to keep steps returning plain data and construct rich values in the workflow body for the output, where the looser input/output typing accepts them.

## A complete example

See [`examples/order-processing/src/serialization-recipes.ts`](https://github.com/) for a runnable example that registers the built-in recipes plus a custom `Money` recipe, shows `Date`, `Map`, `Set`, and `Money` values round-tripping through storage as their real types, and demonstrates `unregister`.
