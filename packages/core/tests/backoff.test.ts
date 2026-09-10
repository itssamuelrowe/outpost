import { describe, expect, it } from "vitest";

import { computeBackoffMilliseconds } from "../src/utilities/backoff.utility.js";

describe("computeBackoffMilliseconds", () => {
  const policy = {
    baseMilliseconds: 100,
    maximumMilliseconds: 1_000,
    factor: 2,
    jitter: false,
  };

  it("grows exponentially when jitter is disabled", () => {
    expect(computeBackoffMilliseconds(policy, 0)).toBe(100);
    expect(computeBackoffMilliseconds(policy, 1)).toBe(200);
    expect(computeBackoffMilliseconds(policy, 2)).toBe(400);
  });

  it("never exceeds the configured maximum", () => {
    expect(computeBackoffMilliseconds(policy, 10)).toBe(1_000);
  });

  it("keeps a jittered delay within the interval [0, rawDelay]", () => {
    const jitteredPolicy = { ...policy, jitter: true };
    for (let iteration = 0; iteration < 100; iteration += 1) {
      const delay = computeBackoffMilliseconds(jitteredPolicy, 3, Math.random);
      expect(delay).toBeGreaterThanOrEqual(0);
      expect(delay).toBeLessThanOrEqual(800);
    }
  });

  it("maps the random source deterministically onto the interval", () => {
    const jitteredPolicy = { ...policy, jitter: true };
    expect(computeBackoffMilliseconds(jitteredPolicy, 2, () => 0)).toBe(0);
    expect(computeBackoffMilliseconds(jitteredPolicy, 2, () => 0.999999)).toBe(399);
  });
});
