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
