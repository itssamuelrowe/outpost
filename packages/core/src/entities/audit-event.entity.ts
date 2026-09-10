import type { EventType } from "../enums/event-type.enum.js";

/**
 * Describes a single immutable audit event.
 *
 * Audit events are append-only and capture every material transition in the
 * lifecycle of a workflow or step. They are intended for debugging, compliance,
 * and for feeding the alerting subsystem.
 */
export interface AuditEvent {
  /** The database-assigned, monotonically increasing event identifier. */
  identifier: number;
  /** The identifier of the workflow this event concerns. */
  workflowIdentifier: string;
  /** The step key this event concerns, or `null` for a workflow-level event. */
  stepKey: string | null;
  /** The category of the event. */
  eventType: EventType;
  /** Structured, serialized details describing the event. */
  details: string | null;
  /** The moment the event was recorded. */
  createdAt: Date;
}
