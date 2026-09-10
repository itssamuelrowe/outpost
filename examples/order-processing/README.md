# Example: order processing

This example has two files:

- **`src/demo.ts`** — a self-contained program you can actually run. It uses your
  local MySQL and in-process fakes for the external services, and demonstrates
  the ambiguous-state probe recovery end to end. Start here.
- **`src/main.ts`** — a production-shaped reference showing how the engine, the
  SQS transport, resilience, and alerts wire together. It is not meant to be run
  directly (it expects a real SQS queue and real service clients); it exists to
  read.

## Prerequisites

- Node.js 20 or newer.
- The Outpost packages must be built first (the example imports their compiled
  output).

From the repository root, build the packages once:

```bash
yarn install
yarn workspaces run build
```

## Running the demo

The demo picks its storage automatically, so you can run it with or without a
database.

### Option A: no setup (in-memory storage)

Just run it. State lives only for the duration of the process, which is fine for
seeing the workflow execute.

```bash
cd examples/order-processing
yarn demo
```

### Option B: with MySQL (state persists)

1. Create a database for the demo (any name works):

   ```bash
   mysql -h 127.0.0.1 -P 3306 -u root -p -e "CREATE DATABASE IF NOT EXISTS outpostDemo CHARACTER SET utf8mb4;"
   ```

2. Run it, pointing at your database via `OUTPOST_DEMO_DB_URL`. The demo creates
   its tables automatically.

   ```bash
   cd examples/order-processing
   OUTPOST_DEMO_DB_URL="mysql://root:YOUR_PASSWORD@127.0.0.1:3306/outpostDemo" yarn demo
   ```

When `OUTPOST_DEMO_DB_URL` is not set, the demo falls back to the in-memory
adapter automatically.

## What you should see

The demo runs the checkout workflow twice for the same order id:

```
Run 1: first attempt (the create-order step will 500 after creating)
  Run 1 stopped as expected: Step "createOrder" ... 503 Service Unavailable

Run 2: resume (the probe should find the order and skip create)
  [probeCreateOrder] found existing SHOP-1; skipping create
  [notifyWhatsApp] messaging +15551234567
  [notifyEmail] emailing sam@example.com

Done. Final result: { orderId: 'SHOP-1' }
```

The key point: the order was created **exactly once**, even though the first
attempt returned a `503` and the workflow was retried. On the retry, the step is
recognized as ambiguous, so the probe runs first and finds the already-created
order instead of creating a duplicate.

## Try changing things

- Run it twice with the same `orderId` (edit the demo to use a fixed id) and see
  that completed steps are memoized and never re-run.
- Remove the `probeCreateOrder` method and watch the workflow park the ambiguous
  step for review instead of guessing.
