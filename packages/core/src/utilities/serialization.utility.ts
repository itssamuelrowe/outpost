/**
 * Thrown when a value that must be persisted is found to be non-serializable at
 * run time. The message names the offending path so the developer can locate
 * it.
 */
export class NonSerializableValueError extends Error {
    public constructor(description: string, path: string, reason: string) {
        super(`The ${description} is not serializable: value at ${path} ${reason}.`);
        this.name = "NonSerializableValueError";
    }
}

/**
 * Verifies at run time that a value can be safely persisted and restored.
 *
 * This is the runtime counterpart to the compile-time `Serializable` type. It
 * is used only when the engine is configured with `validateSerializable: true`,
 * as a safety net for values that slipped past the type system (for example
 * through an `as` cast). It walks the value and rejects anything that JSON
 * persistence cannot faithfully round-trip: functions, symbols, `undefined`,
 * `bigint`, and common non-plain objects such as `Date`, `Map`, `Set`, and
 * class instances.
 *
 * @param value The value about to be persisted.
 * @param description A human-readable name for what is being checked, used in
 *   error messages (for example, `result of step "charge-card"`).
 */
export function assertSerializable(value: unknown, description: string): void {
    walk(value, "$", description, new Set());
}

/**
 * Recursively validates a value, tracking the path and guarding against cycles.
 */
function walk(value: unknown, path: string, description: string, seen: Set<object>): void {
    // Primitives that round-trip cleanly.
    if (value === null) {
        return;
    }
    const valueType = typeof value;
    if (valueType === "boolean" || valueType === "string") {
        return;
    }
    if (valueType === "number") {
        // NaN and Infinity are silently turned into null by JSON, which loses
        // information, so reject them explicitly.
        if (!Number.isFinite(value as number)) {
            throw new NonSerializableValueError(description, path, "is a non-finite number");
        }
        return;
    }

    // Everything below here is a rejectable non-serializable type.
    if (valueType === "undefined") {
        throw new NonSerializableValueError(description, path, "is undefined");
    }
    if (valueType === "function") {
        throw new NonSerializableValueError(description, path, "is a function");
    }
    if (valueType === "symbol") {
        throw new NonSerializableValueError(description, path, "is a symbol");
    }
    if (valueType === "bigint") {
        throw new NonSerializableValueError(description, path, "is a bigint");
    }

    const objectValue = value as object;

    // Reject cycles, which JSON cannot represent.
    if (seen.has(objectValue)) {
        throw new NonSerializableValueError(description, path, "is part of a circular reference");
    }
    seen.add(objectValue);

    if (Array.isArray(objectValue)) {
        objectValue.forEach((element, index) => {
            walk(element, `${path}[${index}]`, description, seen);
        });
        seen.delete(objectValue);
        return;
    }

    // Only plain objects are allowed. A plain object has either the Object
    // prototype or a null prototype; anything else (Date, Map, Set, RegExp, a
    // class instance) does not round-trip as data.
    const prototype = Object.getPrototypeOf(objectValue);
    if (prototype !== Object.prototype && prototype !== null) {
        const constructorName = objectValue.constructor?.name ?? "a non-plain object";
        throw new NonSerializableValueError(
            description,
            path,
            `is an instance of ${constructorName}`,
        );
    }

    for (const [key, propertyValue] of Object.entries(objectValue)) {
        walk(propertyValue, `${path}.${key}`, description, seen);
    }
    seen.delete(objectValue);
}
