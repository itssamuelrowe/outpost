/**
 * Naming conventions that tie a step method to its probe and error-classifier
 * methods, and that recover the step name from a convention-named helper.
 *
 * These are grouped as static members so the forward mapping (step to helper
 * name) used by the engine and the reverse inference (helper name to step) used
 * by the {@link Probe} and {@link ClassifyError} decorators stay together with
 * the single source of truth for the prefixes.
 */
export class StepNaming {
    /**
     * Derives the conventional probe method name for a step method: `probe`
     * followed by the capitalized step method name (for example, `createOrder`
     * becomes `probeCreateOrder`).
     */
    static conventionalProbeName(stepMethodName: string): string {
        return `probe${StepNaming.capitalize(stepMethodName)}`;
    }

    /**
     * Derives the conventional classifier method name for a step method:
     * `classifyErrorFor` followed by the capitalized step method name (for
     * example, `createOrder` becomes `classifyErrorForCreateOrder`).
     */
    static conventionalClassifierName(stepMethodName: string): string {
        return `classifyErrorFor${StepNaming.capitalize(stepMethodName)}`;
    }

    /**
     * Infers the step method name from a probe method that follows the
     * `probe<Step>` convention (for example, `probeCreateOrder` becomes
     * `createOrder`).
     *
     * @throws Error when the method name does not start with `probe` followed by
     *   a capitalized character, because there is then no unambiguous step to
     *   infer.
     */
    static inferStepFromProbeName(methodName: string): string {
        const remainder = StepNaming.stripPrefix(methodName, "probe");
        if (remainder === null) {
            throw new Error(
                `@Probe() was used on "${methodName}", whose name does not follow the "probe<Step>" convention. ` +
                    `Rename it (for example "probeCreateOrder") or pass the step name explicitly, e.g. @Probe("createOrder").`,
            );
        }
        return StepNaming.lowercaseFirst(remainder);
    }

    /**
     * Infers the step method name from a classifier method that follows the
     * `classifyErrorFor<Step>` convention (for example,
     * `classifyErrorForCreateOrder` becomes `createOrder`).
     *
     * @throws Error when the method name does not start with `classifyErrorFor`
     *   followed by a capitalized character.
     */
    static inferStepFromClassifierName(methodName: string): string {
        const remainder = StepNaming.stripPrefix(methodName, "classifyErrorFor");
        if (remainder === null) {
            throw new Error(
                `@ClassifyError() was used on "${methodName}", whose name does not follow the ` +
                    `"classifyErrorFor<Step>" convention. Rename it (for example "classifyErrorForCreateOrder") ` +
                    `or pass the step name explicitly, e.g. @ClassifyError("createOrder").`,
            );
        }
        return StepNaming.lowercaseFirst(remainder);
    }

    /**
     * Capitalizes the first character of a string.
     */
    private static capitalize(value: string): string {
        return value.length === 0 ? value : value.charAt(0).toUpperCase() + value.slice(1);
    }

    /**
     * Lowercases the first character of a string.
     */
    private static lowercaseFirst(value: string): string {
        return value.length === 0 ? value : value.charAt(0).toLowerCase() + value.slice(1);
    }

    /**
     * Returns the remainder of `value` after `prefix` when `value` starts with
     * the prefix followed by an uppercase letter (so there is a distinct
     * capitalized step name to recover). Returns `null` otherwise.
     */
    private static stripPrefix(value: string, prefix: string): string | null {
        if (!value.startsWith(prefix) || value.length <= prefix.length) {
            return null;
        }
        const remainder = value.slice(prefix.length);
        const firstChar = remainder.charAt(0);
        if (firstChar !== firstChar.toUpperCase()) {
            return null;
        }
        return remainder;
    }
}
