import type { WorkflowStatus } from "../enums/workflow-status.enum.js";

/**
 * Describes a persisted workflow execution.
 *
 * Every field maps one-to-one to a camelCase column in the `outpostWorkflows`
 * table. The `input` and `output` fields hold serialized (JSON) payloads, or
 * `null` when no value is present.
 */
export interface Workflow {
    /**
     * The stable, caller-supplied identifier for this workflow execution.
     */
    workflowIdentifier: string;
    /**
     * The name of the workflow definition that produced this execution.
     */
    workflowName: string;
    /**
     * The identifier of the parent workflow that started this one as a child,
     * or `null` for a top-level execution. Recording the link makes the
     * parent/child relationship auditable and lets tooling reconstruct a
     * workflow tree.
     */
    parentWorkflowIdentifier: string | null;
    /**
     * The current lifecycle state of the workflow.
     */
    status: WorkflowStatus;
    /**
     * The serialized input passed when the workflow was started, stored as
     * binary.
     */
    input: Buffer | null;
    /**
     * The serialized final output produced on successful completion, stored as
     * binary.
     */
    output: Buffer | null;
    /**
     * A human-readable description of the terminal error, if the workflow
     * failed.
     */
    error: string | null;
    /**
     * The moment the workflow execution record was first created.
     */
    createdAt: Date;
    /**
     * The moment the workflow execution record was last modified.
     */
    updatedAt: Date;
}
