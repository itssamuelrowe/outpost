import { randomUUID } from "node:crypto";

/**
 * Identifier helpers used by the engine: deriving deterministic child workflow
 * identifiers and generating UUIDs for {@link WorkflowContext.randomUUID}.
 *
 * Grouped as static members so the identifier scheme lives in one place.
 */
export class WorkflowIdentifier {
    /**
     * Derives a deterministic identifier for a child workflow from its parent's
     * identifier and the stable child key. Because the derivation is pure, a
     * resume of the parent addresses exactly the same child execution, which the
     * engine then memoises rather than starting afresh.
     */
    static composeChildWorkflowId(parentWorkflowId: string, childKey: string): string {
        return `${parentWorkflowId}::child::${childKey}`;
    }

    /**
     * The default UUID generator, backed by Node's cryptographically strong
     * `crypto.randomUUID`. Used by {@link WorkflowContext.randomUUID}.
     */
    static generateUuid(): string {
        return randomUUID();
    }
}
