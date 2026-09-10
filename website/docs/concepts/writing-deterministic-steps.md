---
id: writing-deterministic-steps
title: Writing deterministic steps
---

# Writing deterministic steps

When a workflow resumes after a crash or a retry, Outpost runs the `run` method again from the top. Completed steps return their saved results instead of executing, but **the code around the steps runs fresh every time.** If that surrounding code makes different decisions on different runs, your workflow can take a different path than it did before, which leads to skipped work, duplicated work, or confusing state.

This page explains the small number of rules that keep resumes safe, with bad and good examples for each. None of this is hard once you see the pattern: **do anything unpredictable inside a step, never between steps.**

## The one idea to hold onto

- **Inside a step** (the body of a `@Step` method): do whatever you like. Call APIs, read the clock, use random values. The result is saved once and reused, so it is computed only on the first successful run.
- **Between steps** (the `run` method's own logic: `if`, loops, variables, which step to call next): keep it predictable. It re-runs on every resume, so it must reach the same decisions each time.

## Rule 1: Do not read the clock between steps

The current time changes on every run. If it drives control flow, a resume can branch differently than the original run.

**Bad:** the clock is read in the lifecycle method, so a resume an hour later takes the other branch:

```ts
async run(context: WorkflowContext, input: OrderInput) {
  await this.createOrder(input);

  // Re-runs on resume with a NEW time. A retry after 6pm behaves differently
  // from the original run before 6pm.
  if (new Date().getHours() >= 18) {
    await this.sendEveningReceipt(input);
  } else {
    await this.sendDaytimeReceipt(input);
  }
}
```

**Good:** capture the time inside a step, so it is decided once and memoised:

```ts
@Step()
async decideReceiptKind(): Promise<"EVENING" | "DAYTIME"> {
  return new Date().getHours() >= 18 ? "EVENING" : "DAYTIME";
}

async run(context: WorkflowContext, input: OrderInput) {
  await this.createOrder(input);

  // `kind` is computed once and reused on every resume, so the branch is stable.
  const kind = await this.decideReceiptKind();
  if (kind === "EVENING") {
    await this.sendEveningReceipt(input);
  } else {
    await this.sendDaytimeReceipt(input);
  }
}
```

## Rule 2: Do not use random values between steps

Random values change on every run for the same reason the clock does.

**Bad:** a random choice made in the lifecycle method:

```ts
async run(context: WorkflowContext, input: OrderInput) {
  // A resume rolls the dice again and may pick a different provider than the
  // one the earlier run already used.
  const provider = Math.random() < 0.5 ? "providerA" : "providerB";
  await this.charge(input, provider);
}
```

**Good:** make the random choice inside a step so it is fixed after the first run:

```ts
@Step()
async pickProvider(): Promise<"providerA" | "providerB"> {
  return Math.random() < 0.5 ? "providerA" : "providerB";
}

async run(context: WorkflowContext, input: OrderInput) {
  const provider = await this.pickProvider();
  await this.charge(input, provider);
}
```

## Rule 3: Keep step keys stable

Outpost recognises a step by its key (by default, the method name). If the key changes between runs, Outpost thinks it is a brand-new step with no saved result and runs it again. So a step key must never be built from something that varies between runs.

Step keys become important when you call the same step in a loop. Each iteration needs its own stable key.

**Bad:** the key depends on the current time, so it is different on every resume and the step is never recognised as already done:

```ts
async run(context: WorkflowContext, input: OrderInput) {
  for (const item of input.items) {
    // A time-based key changes on resume, so this reserves the same item twice.
    await context.step(`reserve-${Date.now()}`, async () => reserve(item));
  }
}
```

**Good:** derive the key from stable data, such as the item's id or its position:

```ts
async run(context: WorkflowContext, input: OrderInput) {
  for (const [index, item] of input.items.entries()) {
    // A stable key means a resume recognises which reservations already ran.
    await context.step(`reserve-item-${item.id}`, async () => reserve(item));
  }
}
```

The same caution applies to the loop itself: iterate over the **input** (which is fixed for the run) rather than over a list you fetched between steps, so the set of iterations does not change on resume.

## Rule 4: Do not store un-stepped values on the instance and rely on them after a step

Instance fields are convenient, but the `run` method re-executes on resume while completed steps do not. If you set a field from something unpredictable (the clock, randomness, an un-stepped API call) and then use it after a step, the field holds a **different value** on resume than it did when the earlier steps ran.

**Bad:** a request id is generated in the lifecycle method, stored on the instance, used by an early step, and reused by a later step. On resume the field is regenerated, so the two steps end up using different ids:

```ts
private requestId = "";

async run(context: WorkflowContext, input: OrderInput) {
  // Regenerated on every resume, because run() re-executes from the top.
  this.requestId = crypto.randomUUID();

  // First run: charges with requestId "A" and memoises success.
  await this.chargeCard(input, this.requestId);

  // On a resume, chargeCard is skipped (memoised), but requestId is now "B".
  // This step records a mismatched id that does not match the actual charge.
  await this.recordCharge(input, this.requestId);
}
```

**Good:** generate the id inside a step, so it is computed once and memoised. Every later step reads the same saved value on every run:

```ts
@Step()
async createRequestId(): Promise<string> {
  return crypto.randomUUID();
}

async run(context: WorkflowContext, input: OrderInput) {
  // Computed once on the first run; the same id is returned on every resume.
  const requestId = await this.createRequestId();

  await this.chargeCard(input, requestId);
  await this.recordCharge(input, requestId); // uses the identical id after a resume
}
```

## Rule 5: Read configuration and external data through steps

Anything that can change between runs (a feature flag, a config value, an exchange rate, a database row) should be read inside a step if it decides what the workflow does. Read between steps, it can flip mid-workflow and send a resume down a different path.

**Bad:** a feature flag read in the lifecycle method:

```ts
async run(context: WorkflowContext, input: OrderInput) {
  await this.createOrder(input);

  // If the flag is toggled between the first run and a resume, the two runs
  // disagree about whether to run the new step.
  if (await featureFlags.isEnabled("new-fulfilment")) {
    await this.fulfilNewWay(input);
  } else {
    await this.fulfilOldWay(input);
  }
}
```

**Good:** snapshot the flag in a step, so the workflow commits to one path:

```ts
@Step()
async readFulfilmentFlag(): Promise<boolean> {
  return featureFlags.isEnabled("new-fulfilment");
}

async run(context: WorkflowContext, input: OrderInput) {
  await this.createOrder(input);

  const useNewWay = await this.readFulfilmentFlag();
  if (useNewWay) {
    await this.fulfilNewWay(input);
  } else {
    await this.fulfilOldWay(input);
  }
}
```

## Loops and branches

Loops and branches are common and fully supported. The one thing to keep predictable is their **shape**: which branch is taken, how many times a loop runs, and each iteration's step key must be the same on every run. The safe pattern for a loop is the functional `context.step` form with a per-element key derived from stable data:

```ts
for (const item of input.items) {
  await context.step(`fulfil-item-${item.id}`, async () => {
    await warehouse.ship(item.id);
    return { shipped: true };
  });
}
```

If the process crashes after some items shipped, the loop runs again on resume, the completed per-item steps return their saved results without shipping again, and only the unfinished items actually run. Two ways to get this wrong are unstable per-iteration keys (for example, keying on `Date.now()`) and looping over a list fetched with an un-stepped call in `run`. Both, along with the nested-step trap, are covered in full on the [Branching and loops](./branching-and-loops.md) page.

The safe mental model: **a loop is fine as long as its shape (how many iterations and each iteration's step key) is fully determined by the input or by earlier step results.**

## A quick checklist

Before you rely on a value in your `run` method, ask: **could this be different the next time the workflow resumes?** If yes, and it affects which steps run or how, move it into a step.

- Clock, timers, dates → read inside a step.
- Random values, generated ids → produce inside a step.
- Feature flags, config, external lookups → snapshot inside a step.
- Step keys → derive only from the input or from step results, never from the clock or randomness.
- Loops → iterate over the fixed input, with one stable key per iteration.

Follow these and your workflows will resume cleanly every time, because every decision that matters was made once, inside a step, and saved.

## How this differs from replay-based engines

If you have used a system like Temporal, you may have learned strict rules about never calling `Date.now()` or `Math.random()` anywhere in workflow code, because the whole function is replayed from an event log. Outpost is simpler: it does not replay your code against a log. It re-runs the `run` method and hands back saved results for completed steps. That means the only place non-determinism causes trouble is the ordinary logic **between** steps. Put the unpredictable work inside steps and you are done. There is no replay model to reason about.

## Does Outpost detect non-deterministic workflows?

Honestly: no, and by design it largely cannot.

Replay-based engines can detect non-determinism because they replay your code against a recorded history and notice when the new run diverges from what the log says happened. Outpost has no such log to compare against. It simply re-runs your `run` method and returns saved results for completed steps, so there is no recorded history to diverge from and therefore no divergence to flag.

This is the direct consequence of the simpler model. It means you do not get an automatic alarm when the glue between steps behaves differently on a resume. The safeguards Outpost does provide are narrower and specific:

- **Serialization checks.** With `validateSerializable` enabled, the engine rejects step results and workflow input or output that cannot be faithfully saved and restored. This catches a common class of mistake, though not non-determinism itself.
- **Stable step identity.** A step is keyed by `(workflowId, stepKey)`. If you keep keys stable (the default is the method name), completed work is recognised on resume. Unstable keys, such as ones built from the clock, cause repeated work rather than a silent wrong path.

Everything else is your responsibility as the author. It is not onerous once you internalise one habit: keep the code between steps predictable, and push anything that can change between runs into a step. The checklist above is the practical version of that habit.
