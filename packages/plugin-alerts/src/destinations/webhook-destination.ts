import type { Alert } from "../entities/alert.entity.js";
import type { AlertDestination } from "../interfaces/alert-destination.interface.js";

/** Configuration for a {@link WebhookDestination}. */
export interface WebhookDestinationOptions {
  /** A name used in diagnostics. */
  name?: string;
  /** The absolute URL the alert payload is posted to. */
  url: string;
  /** Additional headers to include on the request. */
  headers?: Record<string, string>;
  /**
   * An injectable fetch implementation, provided so tests can avoid real network
   * calls. Defaults to the global `fetch`.
   */
  fetchImplementation?: typeof fetch;
}

/**
 * Delivers alerts by posting a JSON payload to an HTTP endpoint.
 *
 * This is the simplest useful destination and can target most incident systems
 * that accept an inbound webhook. Slack and PagerDuty destinations can be built
 * by shaping the payload to their respective formats.
 */
export class WebhookDestination implements AlertDestination {
  public readonly name: string;
  private readonly url: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImplementation: typeof fetch;

  public constructor(options: WebhookDestinationOptions) {
    this.name = options.name ?? "webhook";
    this.url = options.url;
    this.headers = options.headers ?? {};
    this.fetchImplementation = options.fetchImplementation ?? fetch;
  }

  public async deliver(alert: Alert): Promise<void> {
    const response = await this.fetchImplementation(this.url, {
      method: "POST",
      headers: { "content-type": "application/json", ...this.headers },
      body: JSON.stringify(alert),
    });

    if (!response.ok) {
      throw new Error(
        `Webhook destination "${this.name}" received a non-success status ${response.status}.`,
      );
    }
  }
}
