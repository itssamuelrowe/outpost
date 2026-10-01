# Outpost scheduling

Standalone examples of Outpost's durable timers: durable sleep and durable cron.
Everything here runs on in-memory or local file storage, so there is nothing to
install or configure beyond this project's own dependencies.

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

- `npm run durable-sleep`: a workflow pauses for one minute using `context.sleep`. State is kept in a local JSON file, so you can press Ctrl+C mid-sleep, run the command again, and watch it resume where it left off without repeating completed steps.
- `npm run cron-backfill-update`: register a nightly schedule, backfill a past week of missed runs, then change its cadence in place.
- `npm run functional-cron`: wire a recurring schedule to a workflow in the functional style (`defineWorkflow` + `registerCron` + `onCronFire`), driven by explicit ticks for deterministic output.

## Requirements

- Node.js 20 or newer.

The `durable-sleep` example writes a `src/.durable-sleep-state.json` file next to
its source while it runs; it is safe to delete between runs.
