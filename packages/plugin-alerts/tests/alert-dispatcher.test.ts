import { describe, expect, it } from "vitest";

import { AlertDispatcher } from "../src/dispatcher/alert-dispatcher.js";
import type { Alert } from "../src/entities/alert.entity.js";
import { AlertSeverity } from "../src/enums/alert-severity.enum.js";
import type { AlertDestination } from "../src/interfaces/alert-destination.interface.js";

function createAlert(): Alert {
    return {
        severity: AlertSeverity.CRITICAL,
        title: "Retries exhausted",
        message: "The charge-card step failed permanently.",
        occurredAt: new Date("2024-01-01T00:00:00.000Z"),
    };
}

describe("AlertDispatcher", () => {
    it("delivers an alert to every destination", async () => {
        const received: string[] = [];
        const makeDestination = (name: string): AlertDestination => ({
            name,
            deliver: async () => {
                received.push(name);
            },
        });

        const dispatcher = new AlertDispatcher([makeDestination("a"), makeDestination("b")]);
        const outcomes = await dispatcher.dispatch(createAlert());

        expect(received.sort()).toEqual(["a", "b"]);
        expect(outcomes.every((outcome) => outcome.delivered)).toBe(true);
    });

    it("isolates a failing destination so others still receive the alert", async () => {
        const received: string[] = [];
        const reportedErrors: string[] = [];

        const failingDestination: AlertDestination = {
            name: "flaky",
            deliver: async () => {
                throw new Error("channel unavailable");
            },
        };
        const workingDestination: AlertDestination = {
            name: "reliable",
            deliver: async () => {
                received.push("reliable");
            },
        };

        const dispatcher = new AlertDispatcher([failingDestination, workingDestination], {
            onDeliveryError: (outcome) => reportedErrors.push(outcome.destinationName),
        });

        // The dispatch must not reject even though one destination throws.
        const outcomes = await dispatcher.dispatch(createAlert());

        expect(received).toEqual(["reliable"]);
        expect(reportedErrors).toEqual(["flaky"]);
        expect(outcomes.find((outcome) => outcome.destinationName === "flaky")?.delivered).toBe(
            false,
        );
        expect(outcomes.find((outcome) => outcome.destinationName === "reliable")?.delivered).toBe(
            true,
        );
    });
});
