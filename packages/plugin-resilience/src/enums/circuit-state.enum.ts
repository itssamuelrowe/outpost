/**
 * Represents the state of a circuit breaker.
 *
 * A breaker starts {@link CircuitState.CLOSED}, allowing calls through. After
 * enough consecutive failures it trips {@link CircuitState.OPEN} and fails fast
 * without calling the downstream dependency. Once the reset timeout elapses it
 * moves to {@link CircuitState.HALF_OPEN} and permits a single trial call to
 * decide whether the dependency has recovered.
 */
export enum CircuitState {
    /**
     * Calls flow through normally.
     */
    CLOSED = "CLOSED",
    /**
     * Calls fail fast without touching the downstream dependency.
     */
    OPEN = "OPEN",
    /**
     * A single trial call is permitted to test whether the dependency
     * recovered.
     */
    HALF_OPEN = "HALF_OPEN",
}
