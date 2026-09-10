import type { ChaosTiming } from "../enums/chaos-timing.enum.js";

/**
 * Describes a single fault-injection rule.
 *
 * A rule matches a step either by an exact key or by a regular expression, and
 * may be further restricted to specific attempt numbers. When it matches, the
 * middleware injects the configured fault: a thrown error, an added delay to
 * expire the step's lease, or both.
 */
export interface ChaosRule {
  /** Matches a step by its exact key. Provide either this or `stepKeyPattern`. */
  stepKey?: string;
  /** Matches a step by a regular expression on its key. */
  stepKeyPattern?: RegExp;
  /**
   * Restricts the rule to specific attempt numbers, counting from one. When
   * omitted, the rule applies on every attempt.
   */
  attempts?: number[];
  /** When the fault is injected relative to the step function. Defaults to before. */
  timing?: ChaosTiming;
  /**
   * The error thrown when the rule matches. When omitted and a delay is set, the
   * rule only delays and does not throw.
   */
  error?: () => Error;
  /**
   * A delay, in milliseconds, applied before the fault. Use this to hold a step
   * long enough that its lease expires and another worker can take over.
   */
  delayMilliseconds?: number;
}
