---
id: managing-workflows
title: Managing workflows
---

# Managing workflows

Starting a workflow is only half of running one in production. You also need to observe and steer executions after they start: check whether one finished, read its result, list everything that failed overnight, find the children of a parent, or cancel a run that should no longer proceed. Outpost exposes these as read-and-control methods on the engine, backed by the same storage your workflows already use, so there is no separate control plane to stand up.

## Inspecting a single workflow

### Status

`getWorkflowStatus` returns the current lifecycle state, or `null` if no workflow with that identifier exists.

```ts
const status = await engine.getWorkflowStatus("order-1001");
// "RUNNING" | "COMPLETED" | "FAILED" | "SUSPENDED" | "CANCELLED" | null
```

### A full snapshot

`describeWorkflow` returns a decoded view: status, decoded input and output, error, timings, and the parent link. It is the general-purpose call behind a status endpoint or a dashboard row.

```ts
const description = await engine.describeWorkflow("order-1001");
if (description) {
    console.log(description.status, description.input, description.output);
}
```

Unlike the raw stored record, `input` and `output` are already decoded values, not binary buffers.

### The result

`getWorkflowResult` returns the decoded output of a completed workflow.

```ts
const result = await engine.getWorkflowResult("order-1001");
```

By default it returns `null` when the workflow has not completed (it is still running, suspended, or failed and has no output yet). Pass `{ throwIfNotComplete: true }` when you expect completion and want an incomplete or failed workflow to surface as a thrown error, with a failed workflow's recorded error included in the message:

```ts
const result = await engine.getWorkflowResult("order-1001", {
    throwIfNotComplete: true,
});
```

## Listing workflows

`listWorkflows` returns matching executions, most recently updated first. Every filter field is optional; an empty filter lists everything (up to the default limit).

```ts
// Everything that failed:
const failed = await engine.listWorkflows({ statuses: ["FAILED"] });

// Every execution of one definition:
const charges = await engine.listWorkflows({ workflowName: "charge-card" });

// The children of a parent workflow:
const children = await engine.listWorkflows({
    parentWorkflowIdentifier: "order-1001",
});

// A bounded, time-scoped page:
const recent = await engine.listWorkflows({
    createdAfter: new Date(Date.now() - 24 * 60 * 60 * 1000),
    limit: 50,
});
```

The full filter:

| Field                            | Meaning                                               |
| -------------------------------- | ----------------------------------------------------- |
| `statuses`                       | Restrict to workflows in any of these states.         |
| `workflowName`                   | Restrict to executions of this definition.            |
| `parentWorkflowIdentifier`       | Restrict to the children of this parent.              |
| `createdAfter` / `createdBefore` | Restrict by creation time.                            |
| `limit`                          | Maximum records to return (default is a backend cap). |

This is what backs listing views, reconciliation jobs ("find everything stuck in `RUNNING` for over an hour"), and parent/child navigation.

## Cancelling a workflow

`cancelWorkflow` moves a workflow to the terminal `CANCELLED` state so it is never resumed again.

```ts
const cancelled = await engine.cancelWorkflow("order-1001");
```

It returns `true` on a successful cancellation and `false` when the workflow does not exist or is already terminal (completed, failed, or cancelled). A cancelled workflow emits a `WORKFLOW_CANCELLED` audit event, and any later call to `engine.run` for it is refused with a `WorkflowCancelledError` rather than silently running:

```ts
import { WorkflowCancelledError } from "@outpost/core";

try {
    await engine.run("charge-card", "order-1001", input);
} catch (error) {
    if (error instanceof WorkflowCancelledError) {
        // The workflow was cancelled; treat this run as abandoned.
    } else {
        throw error;
    }
}
```

### What cancellation does and does not do

Cancellation is **cooperative at the boundary**. It prevents future resumes, but it does not reach into another process and interrupt a step that is executing right now. A step already running under a live lease finishes and commits; the workflow simply is not resumed past it. This is the same principle as the rest of Outpost: correctness comes from what is committed to storage, not from racing an in-flight operation.

## A complete example

See [`examples/order-processing/src/workflow-management.ts`](https://github.com/) for a runnable example that runs successful and failing workflows, reads their status and results, lists by status, and cancels a workflow before proving it will not resume.
