/**
 * Indicates how serious an alert is, so destinations can route or filter
 * accordingly (for example, paging on critical alerts but only logging warnings).
 */
export enum AlertSeverity {
  /** Informational; no action is required. */
  INFO = "INFO",
  /** Something is degraded and may need attention soon. */
  WARNING = "WARNING",
  /** Something has failed and requires prompt attention. */
  CRITICAL = "CRITICAL",
}
