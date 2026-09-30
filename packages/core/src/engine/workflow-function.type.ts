import type { SerializableInput } from "../interfaces/serializable.interface.js";
import type { WorkflowContext } from "../interfaces/workflow-context.interface.js";

/**
 * The signature of a workflow definition body. Both the input and output must
 * be {@link Serializable}, because the input is persisted when the workflow is
 * created and the output is persisted on completion.
 */
export type WorkflowFunction<
    TInput extends SerializableInput,
    TOutput extends SerializableInput,
> = (context: WorkflowContext, input: TInput) => Promise<TOutput>;

/**
 * A resolved workflow reference: the definition name and the functional body
 * the engine runs. Produced when a run target (a registered name, an
 * `@Workflow` class, or an instance) is resolved to something the engine can
 * execute directly.
 */
export interface ResolvedWorkflow<
    TInput extends SerializableInput,
    TOutput extends SerializableInput,
> {
    /**
     * The name of the workflow definition.
     */
    name: string;
    /**
     * The functional body the engine invokes.
     */
    workflowFunction: WorkflowFunction<TInput, TOutput>;
}
