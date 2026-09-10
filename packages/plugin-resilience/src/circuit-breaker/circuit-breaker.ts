import { addMilliseconds, isAfter } from "date-fns";

import { CircuitState } from "../enums/circuit-state.enum.js";
import { CircuitOpenError } from "../errors/circuit-open.error.js";

/** Configuration for a {@link CircuitBreaker}. */
export interface CircuitBreakerOptions {
  /** A human-readable name used in errors and event details. */
  name: string;
  /** The number of consecutive failures that trips the breaker open. */
  failureThreshold: number;
  /** How long, in milliseconds, the breaker stays open before a trial call. */
  resetTimeoutMilliseconds: number;
  /** An injectable clock, provided so tests can control time. */
  now?: () => Date;
}

/**
 * A process-local circuit breaker.
 *
 * The breaker tracks consecutive failures. Once the failure threshold is
 * reached it opens and rejects calls immediately until the reset timeout
 * elapses, at which point it allows a single trial call in the half-open state.
 * A success in the half-open state closes the breaker; a failure reopens it.
 *
 * Because the state lives in process memory, a breaker reflects the health of
 * the dependency as seen by a single process, not the whole fleet.
 */
export class CircuitBreaker {
  private readonly name: string;
  private readonly failureThreshold: number;
  private readonly resetTimeoutMilliseconds: number;
  private readonly now: () => Date;

  private state: CircuitState = CircuitState.CLOSED;
  private consecutiveFailures = 0;
  private openedUntil: Date | null = null;

  public constructor(options: CircuitBreakerOptions) {
    this.name = options.name;
    this.failureThreshold = options.failureThreshold;
    this.resetTimeoutMilliseconds = options.resetTimeoutMilliseconds;
    this.now = options.now ?? (() => new Date());
  }

  /** Returns the breaker's name. */
  public getName(): string {
    return this.name;
  }

  /** Returns the breaker's current state, accounting for an elapsed reset timeout. */
  public getState(): CircuitState {
    this.transitionToHalfOpenIfDue();
    return this.state;
  }

  /**
   * Executes the supplied operation under the breaker's protection.
   *
   * When the breaker is open the operation is not invoked and a
   * {@link CircuitOpenError} is thrown instead. Otherwise the operation runs and
   * its success or failure updates the breaker's state.
   */
  public async execute<TResult>(operation: () => Promise<TResult>): Promise<TResult> {
    this.transitionToHalfOpenIfDue();

    if (this.state === CircuitState.OPEN) {
      throw new CircuitOpenError(this.name);
    }

    try {
      const result = await operation();
      this.recordSuccess();
      return result;
    } catch (error) {
      this.recordFailure();
      throw error;
    }
  }

  /** Moves an open breaker to half-open once its reset timeout has elapsed. */
  private transitionToHalfOpenIfDue(): void {
    if (
      this.state === CircuitState.OPEN &&
      this.openedUntil !== null &&
      !isAfter(this.openedUntil, this.now())
    ) {
      this.state = CircuitState.HALF_OPEN;
    }
  }

  /** Records a successful call, closing the breaker and clearing the failure count. */
  private recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.state = CircuitState.CLOSED;
    this.openedUntil = null;
  }

  /** Records a failed call, tripping the breaker open when the threshold is met. */
  private recordFailure(): void {
    this.consecutiveFailures += 1;
    if (
      this.state === CircuitState.HALF_OPEN ||
      this.consecutiveFailures >= this.failureThreshold
    ) {
      this.state = CircuitState.OPEN;
      this.openedUntil = addMilliseconds(this.now(), this.resetTimeoutMilliseconds);
    }
  }
}
