/**
 * Raised when a step exhausts its configured retry budget, or when a retryable
 * failure has been recorded and the workflow must be resumed at a later time.
 *
 * The engine throws this to unwind the current workflow invocation; a
 * subsequent resume will pick up from the persisted step state.
 */
export class StepExhaustedError extends Error {
  public constructor(
    public readonly workflowIdentifier: string,
    public readonly stepKey: string,
    public readonly attempts: number,
    public readonly lastError: string | null,
  ) {
    super(
      `Step "${stepKey}" in workflow "${workflowIdentifier}" could not complete after ${attempts} attempt(s): ${lastError ?? "unknown error"}`,
    );
    this.name = "StepExhaustedError";
  }
}

/**
 * Raised when a step opted into result expiry (via `resultTtlMilliseconds` or
 * `revalidate`) and its memoized result is found to be stale on a resume.
 *
 * The engine deliberately does not silently re-run the step, because a step that
 * ran earlier may have committed downstream steps that consumed its old value,
 * and re-running could duplicate real side effects. Instead this error is
 * raised so the workflow author can decide how to recover, for example by
 * regenerating the resource or running a compensation. Application code is
 * expected to catch this and handle it explicitly.
 */
export class StepResultExpiredError extends Error {
  public constructor(
    public readonly workflowIdentifier: string,
    public readonly stepKey: string,
  ) {
    super(
      `The memoized result of step "${stepKey}" in workflow "${workflowIdentifier}" has expired. ` +
        `Handle this explicitly (regenerate or compensate); the engine does not re-run it automatically.`,
    );
    this.name = "StepResultExpiredError";
  }
}

/**
 * Raised internally to unwind a workflow when it reaches a durable sleep whose
 * due time has not yet arrived.
 *
 * The engine catches this at the top of the run, marks the workflow as suspended
 * rather than failed, and returns. The scheduler later resumes the workflow once
 * the sleep timer becomes due. Application code should not catch this error.
 */
export class WorkflowSuspendedError extends Error {
  public constructor(
    public readonly workflowIdentifier: string,
    public readonly timerKey: string,
    public readonly resumeAt: Date,
  ) {
    super(
      `Workflow "${workflowIdentifier}" is suspended at sleep "${timerKey}" until ${resumeAt.toISOString()}.`,
    );
    this.name = "WorkflowSuspendedError";
  }
}

/**
 * Raised when an ambiguous step cannot be resolved automatically because no
 * probe was provided. The step is parked for manual review rather than guessed,
 * because guessing could either duplicate a side effect or silently drop one.
 */
export class StepNeedsReviewError extends Error {
  public constructor(
    public readonly workflowIdentifier: string,
    public readonly stepKey: string,
  ) {
    super(
      `Step "${stepKey}" in workflow "${workflowIdentifier}" is ambiguous and has no probe to resolve it; it has been parked for manual review.`,
    );
    this.name = "StepNeedsReviewError";
  }
}
