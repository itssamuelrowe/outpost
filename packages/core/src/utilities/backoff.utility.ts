import type { BackoffPolicy } from "../interfaces/backoff-policy.interface.js";

/**
 * A sensible default backoff policy: one second base, thirty second ceiling,
 * doubling each attempt, with full jitter enabled.
 */
export const DEFAULT_BACKOFF_POLICY: BackoffPolicy = {
    baseMilliseconds: 1_000,
    maximumMilliseconds: 30_000,
    factor: 2,
    jitter: true,
};

/**
 * Computes the delay, in milliseconds, before the next retry attempt.
 *
 * The raw delay grows exponentially and is capped by the policy's maximum. When
 * jitter is enabled (the default), the returned delay is drawn uniformly from
 * the interval `[0, rawDelay]`, which spreads retries out to avoid a
 * synchronized retry storm.
 *
 * @param policy The backoff configuration to apply.
 * @param attempt The zero-based attempt index used for the exponent.
 * @param randomNumberGenerator An injectable source of randomness in `[0, 1)`,
 *   provided so tests can make the computation deterministic.
 */
export function computeBackoffMilliseconds(
    policy: BackoffPolicy,
    attempt: number,
    randomNumberGenerator: () => number = Math.random,
): number {
    const rawDelay = Math.min(
        policy.maximumMilliseconds,
        policy.baseMilliseconds * Math.pow(policy.factor, Math.max(0, attempt)),
    );

    if (policy.jitter === false) {
        return Math.floor(rawDelay);
    }

    return Math.floor(randomNumberGenerator() * rawDelay);
}
