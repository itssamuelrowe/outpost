/**
 * Describes the set of values that can be safely persisted and later restored.
 *
 * Everything that crosses a durability boundary in Outpost — a workflow's input
 * and output, and every step's arguments and result — is stored as data and
 * read back on a later run. Only values that survive that round trip are
 * allowed. This type expresses that constraint so the compiler rejects values
 * that would otherwise fail silently at persistence time, such as `Date`
 * objects, `Map`s, class instances, and functions.
 *
 * The type is deliberately structural and recursive: primitives, arrays of
 * serializable values, and plain objects whose properties are serializable.
 *
 * Note that this is a strong compile-time nudge rather than an absolute
 * guarantee: code can still bypass it with `as` casts. For a runtime safety
 * net, enable {@link WorkflowEngineOptions.validateSerializable}.
 */
export type Serializable =
    | null
    | boolean
    | number
    | string
    | readonly Serializable[]
    | { readonly [key: string]: Serializable };

/**
 * A looser serializability constraint used for workflow input and output.
 *
 * The strict {@link Serializable} type is ideal for values you construct inline,
 * such as a step's return object, because the compiler can check every
 * property. However, it rejects ordinary `interface` declarations: TypeScript
 * does not give interfaces an implicit index signature, so `interface
 * OrderInput { ... }` does not match `{ [key: string]: Serializable }` even
 * when every field is in fact serializable.
 *
 * To avoid forcing every consumer to rewrite their input interfaces as `type`
 * aliases, workflow input and output are constrained to this friendlier type.
 * It still rejects the values that are obviously wrong to persist at the top
 * level (functions, `undefined`, `bigint`, `symbol`), while accepting any
 * object or array shape. Deep serializability of these values is verified at
 * run time by the engine's optional `validateSerializable` check.
 */
export type SerializableInput = null | boolean | number | string | readonly unknown[] | object;
