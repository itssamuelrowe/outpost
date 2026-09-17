/**
 * Raised when a call is rejected because its circuit breaker is open.
 *
 * This is a distinct error type so that application code and other middleware
 * can recognise a fail-fast rejection and distinguish it from an error produced
 * by the downstream dependency itself.
 */
export class CircuitOpenError extends Error {
    public constructor(public readonly circuitName: string) {
        super(
            `The circuit "${circuitName}" is open; the call was rejected without invoking the dependency.`,
        );
        this.name = "CircuitOpenError";
    }
}
