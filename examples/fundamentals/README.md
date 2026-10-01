# Outpost fundamentals

Standalone examples of the core Outpost authoring model. Everything here runs on
in-memory storage, so there is nothing to install or configure beyond this
project's own dependencies.

## Setup

```bash
npm install
```

This pulls `@outpost/core` from npm. You do not need to clone the Outpost
repository to run these.

If you want to run it without pulling `@outpost/core`,
```
# once per package, from each package dir
cd packages/core && npm link
# then in the example group
cd examples/fundamentals && npm link @outpost/core
npm run hello
```

## Examples

Each script maps to one file in `src/`:

- `npm run hello`: the smallest workflow, run twice to show that completed steps are memoised.
- `npm run child-workflows`: a parent workflow that fans out to one durable child per line item.
- `npm run deterministic-values`: `context.now` and `context.randomUUID` recorded once and stable across resumes.
- `npm run workflow-management`: inspect status, read results, list, and cancel executions.
- `npm run serialization-recipes`: persist rich values (`Date`, `Map`, `Set`, and a custom `Money`) faithfully.
- `npm run functional-style`: the same model written with `engine.defineWorkflow` and `context.step` instead of decorators.

## Requirements

- Node.js 20 or newer.
