/**
 * Describes the envelope carried on the queue to start or resume a workflow.
 *
 * The envelope is intentionally minimal and transport-neutral: it names the
 * workflow definition, carries the stable workflow identifier, and holds the
 * serialized input. This keeps the queue free of any engine internals.
 */
export interface WorkflowMessage {
    /**
     * The name of the workflow definition to run.
     */
    workflowName: string;
    /**
     * The stable identifier for the workflow execution.
     */
    workflowIdentifier: string;
    /**
     * The serialized input passed to the workflow.
     */
    input: unknown;
}
