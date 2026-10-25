import type { Alert } from "../entities/alert.entity.js";
import type { AlertDestination } from "../interfaces/alert-destination.interface.js";

/**
 * Reports the outcome of delivering an alert to one destination.
 */
export interface DeliveryOutcome {
    /**
     * The destination that was targeted.
     */
    destinationName: string;
    /**
     * Whether delivery succeeded.
     */
    delivered: boolean;
    /**
     * The error encountered when delivery failed, if any.
     */
    error?: unknown;
}

/**
 * Configuration for an {@link AlertDispatcher}.
 */
export interface AlertDispatcherOptions {
    /**
     * An optional sink invoked when a destination throws. It allows the host to
     * observe delivery failures without those failures propagating. Defaults to
     * a no-op, because a failed alert must never corrupt the durable state
     * machine.
     */
    onDeliveryError?: (outcome: DeliveryOutcome) => void;
}

/**
 * Fans a single alert out to a set of destinations.
 *
 * The dispatcher isolates failures: if one destination throws, the others still
 * receive the alert, and the throwing destination's error is reported through
 * the configured error sink rather than propagated. This upholds the rule that
 * a failure to send an alert must never disrupt workflow execution.
 */
export class AlertDispatcher {
    private readonly destinations: AlertDestination[];
    private readonly onDeliveryError: (outcome: DeliveryOutcome) => void;

    public constructor(destinations: AlertDestination[], options: AlertDispatcherOptions = {}) {
        this.destinations = destinations;
        this.onDeliveryError = options.onDeliveryError ?? (() => undefined);
    }

    /**
     * Delivers the alert to every destination, returning the per-destination
     * outcomes. This method never rejects.
     */
    public async dispatch(alert: Alert): Promise<DeliveryOutcome[]> {
        const deliveries = this.destinations.map(async (destination): Promise<DeliveryOutcome> => {
            try {
                await destination.deliver(alert);
                return { destinationName: destination.name, delivered: true };
            } catch (error) {
                const outcome: DeliveryOutcome = {
                    destinationName: destination.name,
                    delivered: false,
                    error,
                };
                this.onDeliveryError(outcome);
                return outcome;
            }
        });

        return Promise.all(deliveries);
    }
}
