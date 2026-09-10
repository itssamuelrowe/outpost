import type { FailureKind } from "../enums/failure-kind.enum.js";
import type { BackoffPolicy } from "./backoff-policy.interface.js";
import type { StepMiddleware } from "./middleware.interface.js";
import type { ProbeFunction } from "./probe-function.interface.js";
import type { Serializable } from "./serializable.interface.js";

/**
 * Configures the behaviour of a single durable step.
 *
 * The most important options for correctness are `classifyError`, which decides
 * whether a failure is ambiguous, and `probe`, which resolves an ambiguous step
 * on recovery without duplicating its side effect.
 *
 * `TResult` is constrained to {@link Serializable} because a step's result is
 * persisted and restored on later runs.
 */
export interface StepOptions<TResult extends Serializable = Serializable> {
  /** The maximum number of attempts before terminal failure. Defaults to one. */
  maxAttempts?: number;
  /** The exponential backoff policy governing retry delays. */
  backoff?: BackoffPolicy;
  /** The lease duration, in milliseconds, granted to a claim of this step. */
  leaseMilliseconds?: number;
  /**
   * When `true`, a terminal failure yields `fallbackValue` and allows the
   * workflow to continue instead of failing it.
   */
  optional?: boolean;
  /** The value returned when an optional step fails terminally. */
  fallbackValue?: TResult;
  /**
   * A probe consulted before executing an ambiguous step, used to determine
   * whether the step's side effect has already occurred.
   */
  probe?: ProbeFunction<TResult>;
  /**
   * Classifies a thrown error as definite or ambiguous. Callers that wrap
   * network calls should classify timeouts and 5xx responses as ambiguous so
   * the engine probes on recovery. Defaults to treating every error as definite.
   */
  classifyError?: (error: unknown) => FailureKind;
  /** Middleware applied to this step in addition to any engine-wide middleware. */
  middleware?: StepMiddleware[];
  /**
   * An optional time-to-live for the step's memoized result, in milliseconds.
   *
   * By default a completed step's result never expires: it is returned on every
   * resume. When this is set, a resume that reaches the step after its result
   * is older than the TTL does not return the stale value and does not silently
   * re-run the step. Instead the engine raises a `StepResultExpiredError`, so the
   * workflow can decide what to do (regenerate, compensate, or fail).
   *
   * Use this for steps that produce a perishable resource, such as a signed URL
   * or a short-lived token. See the "Time-sensitive resources" documentation.
   */
  resultTtlMilliseconds?: number;
  /**
   * An optional predicate that decides whether a memoized result is still valid.
   *
   * It is called with the decoded prior result when a resume reaches an
   * already-completed step. Returning `true` keeps the result; returning `false`
   * causes the engine to raise a `StepResultExpiredError` rather than return the
   * stale value or re-run the step. Like `resultTtlMilliseconds`, this only ever
   * applies to steps that opt in.
   */
  revalidate?: (previousResult: TResult) => boolean | Promise<boolean>;
}
