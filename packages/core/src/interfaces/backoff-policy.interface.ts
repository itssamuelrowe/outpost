/**
 * Configures exponential backoff with optional full jitter for step retries.
 *
 * The delay before a given retry attempt is computed as:
 *
 *   rawDelay = min(maximumMilliseconds, baseMilliseconds * factor ^ attempt)
 *   delay    = jitter ? random(0, rawDelay) : rawDelay
 *
 * Full jitter spreads retries across the interval to avoid the thundering-herd
 * problem that arises when many workers retry in lockstep.
 */
export interface BackoffPolicy {
  /** The base delay, in milliseconds, used as the starting point for growth. */
  baseMilliseconds: number;
  /** The upper bound, in milliseconds, that the computed delay may not exceed. */
  maximumMilliseconds: number;
  /** The multiplicative growth factor applied per attempt. */
  factor: number;
  /** Whether to apply full jitter. Defaults to enabled when omitted. */
  jitter?: boolean;
}
