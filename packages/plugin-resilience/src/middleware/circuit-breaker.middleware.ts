import type { StepMiddleware } from "@outpost/core";

import { CircuitBreaker } from "../circuit-breaker/circuit-breaker.js";
import type { CircuitBreakerOptions } from "../circuit-breaker/circuit-breaker.js";

/**
 * Creates step middleware that guards execution with a shared circuit breaker.
 *
 * Passing the same breaker instance to several steps groups them behind a
 * single circuit, which is the natural way to protect a common downstream
 * dependency such as a payment provider. When the circuit is open, the guarded
 * step fails fast without invoking the step function.
 *
 * @param breaker The breaker instance to guard the step with.
 */
export function createCircuitBreakerMiddleware(breaker: CircuitBreaker): StepMiddleware {
  return async (_context, next) => breaker.execute(() => next());
}

/**
 * Convenience factory that constructs a new {@link CircuitBreaker} and returns
 * both the breaker and its middleware, for callers that do not need to share
 * the breaker across steps.
 *
 * @param options The breaker configuration.
 */
export function createCircuitBreaker(options: CircuitBreakerOptions): {
  breaker: CircuitBreaker;
  middleware: StepMiddleware;
} {
  const breaker = new CircuitBreaker(options);
  return { breaker, middleware: createCircuitBreakerMiddleware(breaker) };
}
