import type { EventType } from "../enums/event-type.enum.js";
import type { ScheduleStatus } from "../enums/schedule-status.enum.js";
import type { StepStatus } from "../enums/step-status.enum.js";
import type { WorkflowStatus } from "../enums/workflow-status.enum.js";
import type { ClaimResult } from "../entities/claim-result.entity.js";
import type { Workflow } from "../entities/workflow.entity.js";

/**
 * The narrow persistence contract the core engine depends upon.
 *
 * Any backend that can provide atomic step claiming, fence-token-guarded
 * commits, durable timers, and an append-only audit log can implement this
 * interface. The MySQL adapter is the primary production implementation; the
 * in-memory adapter shipped with the core is intended for tests.
 *
 * Every operation must be safe to call concurrently from multiple worker
 * processes sharing the same backend.
 */
export interface StorageAdapter {
  /** Creates the workflow execution record if it does not already exist. */
  ensureWorkflow(
    workflowIdentifier: string,
    workflowName: string,
    input: Buffer | null,
  ): Promise<void>;

  /** Updates a workflow's status and, optionally, its binary output or error. */
  setWorkflowStatus(
    workflowIdentifier: string,
    status: WorkflowStatus,
    fields?: { output?: Buffer | null; error?: string | null },
  ): Promise<void>;

  /** Retrieves a workflow execution record, or `null` when absent. */
  getWorkflow(workflowIdentifier: string): Promise<Workflow | null>;

  /**
   * Atomically claims a runnable step. Returns the memoized result when the
   * step is already terminal, refuses the claim when another worker holds a
   * live lease, and otherwise grants a claim with a freshly incremented fence
   * token.
   */
  claimStep(
    workflowIdentifier: string,
    stepKey: string,
    maxAttempts: number,
    leaseMilliseconds: number,
  ): Promise<ClaimResult>;

  /**
   * Commits a step outcome. The write is rejected (returns `false`) when the
   * supplied fence token is stale, which prevents a stale worker from
   * overwriting a newer owner's result.
   */
  commitStep(
    workflowIdentifier: string,
    stepKey: string,
    fenceToken: number,
    output: Buffer | null,
    status: StepStatus,
  ): Promise<boolean>;

  /**
   * Records a step failure. When `retryAt` is provided the step returns to a
   * runnable state for a later attempt (preserving the ambiguous status when
   * applicable); otherwise the supplied terminal status is stored. Rejected
   * when the fence token is stale.
   */
  failStep(
    workflowIdentifier: string,
    stepKey: string,
    fenceToken: number,
    error: string,
    status: StepStatus,
    retryAt: Date | null,
  ): Promise<boolean>;

  /**
   * Releases the lease on a claimed step without recording an outcome, making
   * the step immediately claimable again. This is used for graceful shutdown and
   * for operator intervention, so a step held by a worker that is going away is
   * not stuck until its lease naturally expires.
   *
   * The release is guarded by the fence token: only the current lease holder can
   * release it, and the attempt count is left untouched so the next claim simply
   * resumes. Returns `false` if the token is stale (a newer claim already exists).
   */
  releaseStep(
    workflowIdentifier: string,
    stepKey: string,
    fenceToken: number,
  ): Promise<boolean>;

  /** Persists a durable timer that becomes due at `runAt`. */
  scheduleTimer(
    workflowIdentifier: string,
    stepKey: string | null,
    runAt: Date,
    payload: string | null,
  ): Promise<void>;

  /**
   * Ensures a durable sleep timer exists for the given key, creating it exactly
   * once. This is how {@link WorkflowContext.sleep} stays idempotent across
   * resumes: the first call records the timer with its due time, and later calls
   * for the same key return the existing timer instead of creating another.
   *
   * @returns The due time of the sleep timer (the existing one if it was already
   *   created, otherwise the newly recorded `runAt`).
   */
  ensureSleepTimer(
    workflowIdentifier: string,
    timerKey: string,
    runAt: Date,
  ): Promise<{ runAt: Date }>;

  /**
   * Atomically claims up to `limit` timers whose due time has passed, marking
   * them processed so concurrent schedulers do not dispatch them twice.
   */
  claimDueTimers(
    now: Date,
    limit: number,
  ): Promise<
    Array<{
      scheduleIdentifier: number;
      workflowIdentifier: string;
      stepKey: string | null;
      payload: string | null;
    }>
  >;

  /** Sets the status of a specific timer. */
  setTimerStatus(
    scheduleIdentifier: number,
    status: ScheduleStatus,
  ): Promise<void>;

  /** Appends an immutable audit event. */
  logEvent(
    workflowIdentifier: string,
    stepKey: string | null,
    eventType: EventType,
    details: Record<string, unknown>,
  ): Promise<void>;
}
