import { describe, expect, it } from "vitest";

import { CircuitBreaker } from "../src/circuit-breaker/circuit-breaker.js";
import { CircuitState } from "../src/enums/circuit-state.enum.js";
import { CircuitOpenError } from "../src/errors/circuit-open.error.js";

/**
 * A mutable clock so tests can advance time deterministically.
 */
function createControllableClock(): { now: () => Date; advance: (milliseconds: number) => void } {
    let current = new Date("2024-01-01T00:00:00.000Z");
    return {
        now: () => current,
        advance: (milliseconds: number) => {
            current = new Date(current.getTime() + milliseconds);
        },
    };
}

describe("CircuitBreaker", () => {
    it("opens after the failure threshold and then fails fast", async () => {
        const breaker = new CircuitBreaker({
            name: "payments",
            failureThreshold: 2,
            resetTimeoutMilliseconds: 1_000,
        });

        const failing = async () => {
            throw new Error("downstream error");
        };

        await expect(breaker.execute(failing)).rejects.toThrow("downstream error");
        await expect(breaker.execute(failing)).rejects.toThrow("downstream error");
        expect(breaker.getState()).toBe(CircuitState.OPEN);

        // The next call fails fast without invoking the operation.
        let invoked = false;
        await expect(
            breaker.execute(async () => {
                invoked = true;
                return "should not run";
            }),
        ).rejects.toBeInstanceOf(CircuitOpenError);
        expect(invoked).toBe(false);
    });

    it("moves to half-open after the reset timeout and closes on success", async () => {
        const clock = createControllableClock();
        const breaker = new CircuitBreaker({
            name: "payments",
            failureThreshold: 1,
            resetTimeoutMilliseconds: 1_000,
            now: clock.now,
        });

        await expect(
            breaker.execute(async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
        expect(breaker.getState()).toBe(CircuitState.OPEN);

        clock.advance(1_000);
        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

        const result = await breaker.execute(async () => "recovered");
        expect(result).toBe("recovered");
        expect(breaker.getState()).toBe(CircuitState.CLOSED);
    });

    it("reopens when the half-open trial call fails", async () => {
        const clock = createControllableClock();
        const breaker = new CircuitBreaker({
            name: "payments",
            failureThreshold: 1,
            resetTimeoutMilliseconds: 1_000,
            now: clock.now,
        });

        await expect(
            breaker.execute(async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow();
        clock.advance(1_000);
        expect(breaker.getState()).toBe(CircuitState.HALF_OPEN);

        await expect(
            breaker.execute(async () => {
                throw new Error("still broken");
            }),
        ).rejects.toThrow("still broken");
        expect(breaker.getState()).toBe(CircuitState.OPEN);
    });
});
