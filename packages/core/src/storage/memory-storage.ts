import { addMilliseconds, isAfter } from "date-fns";

import type { EventType } from "../enums/event-type.enum.js";
import { ScheduleStatus } from "../enums/schedule-status.enum.js";
import { StepStatus } from "../enums/step-status.enum.js";
import { WorkflowStatus } from "../enums/workflow-status.enum.js";
import type { AuditEvent } from "../entities/audit-event.entity.js";
import type { ClaimResult } from "../entities/claim-result.entity.js";
import type { Schedule } from "../entities/schedule.entity.js";
import type { Step } from "../entities/step.entity.js";
import type { Workflow } from "../entities/workflow.entity.js";
import type { StorageAdapter } from "../interfaces/storage-adapter.interface.js";

/**
 * An in-memory implementation of {@link StorageAdapter}, shipped as part of the
 * core library so consumers can unit-test their workflows without provisioning a
 * database.
 *
 * It faithfully models the lease and fence-token semantics that the production
 * MySQL adapter provides, which means correctness tests written against it
 * remain meaningful. It is emphatically not intended for production use: all
 * state is held in process memory and is lost when the process exits.
 */
export class MemoryStorage implements StorageAdapter {
  private readonly workflows = new Map<string, Workflow>();
  private readonly steps = new Map<string, Step>();
  private readonly schedules: Schedule[] = [];
  /** Durable sleep due-times, keyed by workflowId + timerKey, created once each. */
  private readonly sleepTimers = new Map<string, Date>();
  private nextScheduleIdentifier = 1;
  private nextEventIdentifier = 1;

  /** The append-only audit log, exposed so tests can make assertions on it. */
  public readonly events: AuditEvent[] = [];

  private readonly now: () => Date;

  public constructor(now: () => Date = () => new Date()) {
    this.now = now;
  }

  /** Composes the composite primary key for the step map. */
  private composeStepKey(workflowIdentifier: string, stepKey: string): string {
    return `${workflowIdentifier}\u0000${stepKey}`;
  }

  public async ensureWorkflow(
    workflowIdentifier: string,
    workflowName: string,
    input: Buffer | null,
  ): Promise<void> {
    if (!this.workflows.has(workflowIdentifier)) {
      const timestamp = this.now();
      this.workflows.set(workflowIdentifier, {
        workflowIdentifier,
        workflowName,
        status: WorkflowStatus.RUNNING,
        input,
        output: null,
        error: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      });
    }
  }

  public async setWorkflowStatus(
    workflowIdentifier: string,
    status: WorkflowStatus,
    fields?: { output?: Buffer | null; error?: string | null },
  ): Promise<void> {
    const workflow = this.workflows.get(workflowIdentifier);
    if (!workflow) {
      return;
    }
    workflow.status = status;
    if (fields && "output" in fields) {
      workflow.output = fields.output ?? null;
    }
    if (fields && "error" in fields) {
      workflow.error = fields.error ?? null;
    }
    workflow.updatedAt = this.now();
  }

  public async getWorkflow(workflowIdentifier: string): Promise<Workflow | null> {
    return this.workflows.get(workflowIdentifier) ?? null;
  }

  public async claimStep(
    workflowIdentifier: string,
    stepKey: string,
    maxAttempts: number,
    leaseMilliseconds: number,
  ): Promise<ClaimResult> {
    const mapKey = this.composeStepKey(workflowIdentifier, stepKey);
    const currentInstant = this.now();
    let step = this.steps.get(mapKey);

    if (!step) {
      step = {
        workflowIdentifier,
        stepKey,
        status: StepStatus.PENDING,
        attempts: 0,
        maxAttempts,
        output: null,
        lastError: null,
        fenceToken: 0,
        lockedUntil: null,
        completedAt: null,
        createdAt: currentInstant,
        updatedAt: currentInstant,
      };
      this.steps.set(mapKey, step);
    }

    if (step.status === StepStatus.COMPLETED || step.status === StepStatus.FAILED_OPTIONAL) {
      return {
        claimed: false,
        cachedResult: { output: step.output, completedAt: step.completedAt },
        attempt: step.attempts,
        fenceToken: step.fenceToken,
        priorStatus: step.status,
      };
    }

    const leaseIsLive =
      step.status === StepStatus.RUNNING &&
      step.lockedUntil !== null &&
      isAfter(step.lockedUntil, currentInstant);
    if (leaseIsLive) {
      return {
        claimed: false,
        attempt: step.attempts,
        fenceToken: step.fenceToken,
        priorStatus: step.status,
      };
    }

    const priorStatus = step.status;
    step.attempts += 1;
    step.fenceToken += 1;
    step.status = StepStatus.RUNNING;
    step.lockedUntil = addMilliseconds(currentInstant, leaseMilliseconds);
    step.updatedAt = currentInstant;

    return {
      claimed: true,
      attempt: step.attempts,
      fenceToken: step.fenceToken,
      priorStatus,
    };
  }

  public async commitStep(
    workflowIdentifier: string,
    stepKey: string,
    fenceToken: number,
    output: Buffer | null,
    status: StepStatus,
  ): Promise<boolean> {
    const step = this.steps.get(this.composeStepKey(workflowIdentifier, stepKey));
    if (!step || step.fenceToken !== fenceToken) {
      return false;
    }
    step.status = status;
    step.output = output;
    step.lockedUntil = null;
    step.completedAt = this.now();
    step.updatedAt = this.now();
    return true;
  }

  public async failStep(
    workflowIdentifier: string,
    stepKey: string,
    fenceToken: number,
    error: string,
    status: StepStatus,
    retryAt: Date | null,
  ): Promise<boolean> {
    const step = this.steps.get(this.composeStepKey(workflowIdentifier, stepKey));
    if (!step || step.fenceToken !== fenceToken) {
      return false;
    }
    step.lastError = error;
    step.lockedUntil = null;
    step.updatedAt = this.now();
    if (retryAt) {
      // Preserve the ambiguous status across a retry so recovery probes; a
      // definite retryable failure returns to the pending state.
      step.status = status === StepStatus.AMBIGUOUS ? StepStatus.AMBIGUOUS : StepStatus.PENDING;
      this.schedules.push({
        scheduleIdentifier: this.nextScheduleIdentifier++,
        workflowIdentifier,
        stepKey,
        runAt: retryAt,
        status: ScheduleStatus.PENDING,
        payload: null,
        createdAt: this.now(),
      });
    } else {
      step.status = status;
    }
    return true;
  }

  public async releaseStep(
    workflowIdentifier: string,
    stepKey: string,
    fenceToken: number,
  ): Promise<boolean> {
    const step = this.steps.get(this.composeStepKey(workflowIdentifier, stepKey));
    if (!step || step.fenceToken !== fenceToken) {
      return false;
    }
    // Only a step that is currently running under this lease can be released.
    if (step.status !== StepStatus.RUNNING) {
      return false;
    }
    step.status = StepStatus.PENDING;
    step.lockedUntil = null;
    step.updatedAt = this.now();
    return true;
  }

  public async ensureSleepTimer(
    workflowIdentifier: string,
    timerKey: string,
    runAt: Date,
  ): Promise<{ runAt: Date }> {
    const mapKey = this.composeStepKey(workflowIdentifier, timerKey);
    const existing = this.sleepTimers.get(mapKey);
    if (existing) {
      return { runAt: existing };
    }
    this.sleepTimers.set(mapKey, runAt);
    // Also record a schedule so the embedded scheduler can dispatch a resume
    // when the sleep becomes due.
    this.schedules.push({
      scheduleIdentifier: this.nextScheduleIdentifier++,
      workflowIdentifier,
      stepKey: timerKey,
      runAt,
      status: ScheduleStatus.PENDING,
      payload: null,
      createdAt: this.now(),
    });
    return { runAt };
  }

  public async scheduleTimer(
    workflowIdentifier: string,
    stepKey: string | null,
    runAt: Date,
    payload: string | null,
  ): Promise<void> {
    this.schedules.push({
      scheduleIdentifier: this.nextScheduleIdentifier++,
      workflowIdentifier,
      stepKey,
      runAt,
      status: ScheduleStatus.PENDING,
      payload,
      createdAt: this.now(),
    });
  }

  public async claimDueTimers(
    now: Date,
    limit: number,
  ): Promise<
    Array<{
      scheduleIdentifier: number;
      workflowIdentifier: string;
      stepKey: string | null;
      payload: string | null;
    }>
  > {
    const dueTimers = this.schedules
      .filter(
        (schedule) =>
          schedule.status === ScheduleStatus.PENDING && !isAfter(schedule.runAt, now),
      )
      .slice(0, limit);

    for (const timer of dueTimers) {
      timer.status = ScheduleStatus.PROCESSED;
    }

    return dueTimers.map((timer) => ({
      scheduleIdentifier: timer.scheduleIdentifier,
      workflowIdentifier: timer.workflowIdentifier,
      stepKey: timer.stepKey,
      payload: timer.payload,
    }));
  }

  public async setTimerStatus(
    scheduleIdentifier: number,
    status: ScheduleStatus,
  ): Promise<void> {
    const timer = this.schedules.find(
      (schedule) => schedule.scheduleIdentifier === scheduleIdentifier,
    );
    if (timer) {
      timer.status = status;
    }
  }

  public async logEvent(
    workflowIdentifier: string,
    stepKey: string | null,
    eventType: EventType,
    details: Record<string, unknown>,
  ): Promise<void> {
    this.events.push({
      identifier: this.nextEventIdentifier++,
      workflowIdentifier,
      stepKey,
      eventType,
      details: JSON.stringify(details),
      createdAt: this.now(),
    });
  }

  /** Returns the current state of a step, for use in tests. */
  public getStep(workflowIdentifier: string, stepKey: string): Step | undefined {
    return this.steps.get(this.composeStepKey(workflowIdentifier, stepKey));
  }

  /**
   * Returns a snapshot of everything currently held in memory: workflows, steps,
   * schedules, and audit events.
   *
   * This is intended for tests, examples, and debugging, where it is useful to
   * inspect or print the complete durable state after a run. The returned arrays
   * are shallow copies, so iterating over them will not be disturbed by later
   * writes, though the entity objects themselves are the live records.
   */
  public dump(): {
    workflows: Workflow[];
    steps: Step[];
    schedules: Schedule[];
    events: AuditEvent[];
  } {
    return {
      workflows: [...this.workflows.values()],
      steps: [...this.steps.values()],
      schedules: [...this.schedules],
      events: [...this.events],
    };
  }
}
