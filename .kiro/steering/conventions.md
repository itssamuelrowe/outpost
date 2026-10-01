# Outpost project conventions

Conventions to follow when writing documentation and code in this repository.

## Documentation writing style

The docs live in `packages/documentation/docs/**` (Docusaurus) and are written as prose that teaches.

- **No em dashes.** Do not use the `—` character anywhere in documentation. Rephrase instead:
    - For a parenthetical aside, use a comma or parentheses: "Because those values are persisted, sometimes after a restart, Outpost is careful."
    - For a separator in a list item, use a colon: "- [Durable cron](./durable-cron.md): what it is and how to register one."
    - To join two clauses, use a colon, a semicolon, or split into two sentences.
- Prefer plain text over bold for emphasis; reserve bold for genuinely key terms.
- Use fenced code blocks for code and keep examples aligned with the real public API (see below).
- Cross-link related pages with a "Related" list at the end, using the colon separator style above.
- Every code example must match the actual exported API. When an API is renamed, update the docs in the same change.

## Code and API naming

- **Prefer descriptive methods over exported ALL_CAPS constant collections.** When a value is really "a computed set the caller iterates," expose it as a method rather than a top-level constant. For example, built-in serialization recipes are obtained with `SerializationRegistry.getAllBuiltInRecipes()`, not a `ALL_BUILT_IN_RECIPES` export. A method reads as an action, returns a fresh array callers can filter without side effects, and keeps the collection logic with its owning type.
- Return fresh arrays/objects from such accessors so callers cannot mutate shared state.

## Types and interfaces

- **Always declare a named interface or type alias instead of relying on inline/anonymous types.** Give the shape a name and reference it, rather than writing the object literal type inline at a parameter, return position, or variable annotation. Named types read better, are reusable, and surface in editor tooltips and errors. For example, prefer `function run(options: RunOptions)` with a declared `RunOptions` interface over `function run(options: { attempts: number; timeout: number })`.
- **Search the codebase for an existing type before creating a new one.** Before introducing a new interface or type alias, look under `packages/core/src/interfaces/`, `packages/core/src/entities/`, `packages/core/src/enums/`, and the rest of the package for a type that already models the shape you need. Reuse it rather than defining a redundant parallel type. Only add a new type when nothing suitable exists, and place it with its peers (interfaces in `interfaces/`, entities in `entities/`, enums in `enums/`).

## Utilities are classes, not loose functions

- **Group related utility functions as static members of a class** named for the concern, rather than exporting standalone functions. Call sites then read as `CronUtility.computeNextCronRun(...)`, `BackoffCalculator.computeBackoffMilliseconds(...)`, `MiddlewarePipeline.run(...)`, and `SerializationValidator.assertSerializable(...)`. This keeps the logic discoverable with its owning type and namespaces the call site.
- Related default values belong on the same class as `static readonly` members (for example `CronUtility.DEFAULT_CRON_JITTER_MILLISECONDS`, `BackoffCalculator.DEFAULT_BACKOFF_POLICY`), not as separate top-level constants.
- Keep helpers that are internal to the class `private static` (for example the recursive `walk` in `SerializationValidator`).
- One utility class per file under `packages/core/src/utilities/`, named `*.utility.ts`.

## Errors live in the errors directory

- **All error classes belong in `packages/core/src/errors/`,** never inline in a utility, engine, or scheduler file. Group them by concern in a `*.error.ts` file (for example `cron.error.ts` holds `InvalidCronExpressionError` and `InvalidTimeZoneError`; `serialization.error.ts` holds `NonSerializableValueError`).
- Import errors from the errors module where they are thrown, and re-export them from `packages/core/src/index.ts` under the "Errors" section so they stay part of the public API.

## Comments

- **Use multiline comments (`/* ... */`) for explanatory comments inside code,** not single-line `//` comments. This applies to inline commentary within method and function bodies. For example, in `packages/core/src/serialization/serialization-registry.ts` the explanatory notes inside methods are written as block comments:

    ```ts
    /*
     * A recipe takes precedence over structural walking, so rich objects like
     * Date or Map are handled as whole units rather than descended into raw.
     */
    const recipe = this.findRecipeFor(value);
    ```

- Keep using `/** ... */` JSDoc blocks for documenting exported types, classes, methods, and properties.

## Iteration

- **Prefer `for...of` over `Array.prototype.forEach`.** Iterate with `for (const item of items) { ... }` rather than `items.forEach((item) => { ... })`. A `for...of` loop supports `await` in the loop body without wrapping every iteration in a promise, honors `break`/`continue`/`return` for early exit, keeps stack traces flat for easier debugging, and avoids allocating a callback per call. Reserve `map`/`filter`/`reduce` for when you genuinely need the transformed value they return; use `for...of` for side-effecting iteration.

## Module imports

The packages are ESM (`"type": "module"`) compiled with `"module": "NodeNext"` and `"moduleResolution": "NodeNext"`, so imports follow Node's real ESM rules.

- **Always use a `.js` extension on relative imports,** even though the source file is `.ts`. TypeScript does not rewrite specifiers, and Node's ESM loader requires the extension of the emitted file: `import { BackoffPolicy } from "../interfaces/backoff-policy.interface.js"`, not `.interface` or `.interface.ts`. Omitting it fails `typecheck` and breaks at runtime with `ERR_MODULE_NOT_FOUND`.
- **Prefer deep, specific relative imports internally; do not import from barrel/index files within a package.** Importing from a package-internal barrel risks circular dependencies (the barrel re-exports the engine, scheduler, and storage), which surface as `undefined` bindings at runtime under ESM. Deep imports keep the dependency graph acyclic and make each file's real dependencies explicit.
- **Reserve `packages/core/src/index.ts` for the public API.** It is the single entry point consumers and examples import from (`@outpost/core`); barrels exist for that purpose, not for shortening internal imports.

## Dates and time

- Use `date-fns` and `date-fns-tz` for all date arithmetic and comparison. Do not hand-roll with raw `Date` math.
    - Add/subtract: `addMilliseconds`, `subMilliseconds`, etc.
    - Compare: `isAfter`, `isBefore`, `compareAsc`, `compareDesc`.
    - Differences: `differenceInMilliseconds`.
    - Time zones: `date-fns-tz` (`getTimezoneOffset` for validation, zone-aware formatting).
- The only acceptable raw `Date` usage is value conversion at a serialization boundary (epoch milliseconds to/from `Date`), where `date-fns` has no equivalent. Keep such usage isolated and commented.

## Verification

- After code changes to `packages/core`, run `npm run typecheck` and `npm test`.
- After changes that the examples consume, rebuild `@outpost/core` (`npm run build`) before building an example, since examples import the built package.
- After documentation changes, run the Docusaurus build in `packages/documentation/` and confirm there are no broken-link warnings.
