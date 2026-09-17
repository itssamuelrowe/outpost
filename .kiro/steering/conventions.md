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
