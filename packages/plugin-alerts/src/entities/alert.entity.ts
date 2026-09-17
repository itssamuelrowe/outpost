import type { AlertSeverity } from "../enums/alert-severity.enum.js";

/**
 * Describes a single alert emitted by the engine or the application.
 *
 * An alert is a vendor-neutral description of an incident. Destinations are
 * responsible for translating it into whatever form their channel requires,
 * such as a Slack message or a PagerDuty incident.
 */
export interface Alert {
    /**
     * How serious the incident is.
     */
    severity: AlertSeverity;
    /**
     * A short, human-readable summary of the incident.
     */
    title: string;
    /**
     * A longer description providing context for the incident.
     */
    message: string;
    /**
     * The workflow the alert concerns, when applicable.
     */
    workflowIdentifier?: string;
    /**
     * The step the alert concerns, when applicable.
     */
    stepKey?: string;
    /**
     * Arbitrary structured context attached to the alert.
     */
    context?: Record<string, unknown>;
    /**
     * The moment the alert was created.
     */
    occurredAt: Date;
}
