import type { Alert } from "../entities/alert.entity.js";

/**
 * A destination receives alerts and delivers them to a specific channel, such
 * as a webhook, Slack, or PagerDuty.
 *
 * Implementations should be self-contained and must tolerate being called
 * concurrently. The dispatcher guarantees that a failure in one destination
 * does not prevent other destinations from receiving the alert.
 */
export interface AlertDestination {
  /** A name used in diagnostics to identify this destination. */
  readonly name: string;
  /** Delivers a single alert to the destination's channel. */
  deliver(alert: Alert): Promise<void>;
}
