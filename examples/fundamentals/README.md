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

### Running locally before the packages are published

`@outpost/core` is not on npm yet, so until it is published, link the local
build with `npm link` instead of relying on `npm install` to fetch it.

From the repository root, build and register the package once:

```bash
npm run build --workspace @outpost/core
(cd packages/core && npm link)
```

Then, in this directory, install the dev tooling and link the package:

```bash
npm install --no-save tsx typescript
npm link @outpost/core
```

Now the `npm run` scripts below work against your local build. When the package
is published, drop the link and a plain `npm install` resolves it normally.

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
