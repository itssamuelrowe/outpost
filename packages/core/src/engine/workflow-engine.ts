import { addMilliseconds, isAfter } from "date-fns";

import { EventType } from "../enums/event-type.enum.js";
import { FailureKind } from "../enums/failure-kind.enum.js";
import { StepStatus } from "../enums/step-status.enum.js";
import { WorkflowStatus } from "../enums/workflow-status.enum.js";
import {
  StepExhaustedError,
  StepNeedsReviewError,
  StepResultExpiredError,
  WorkflowSuspendedError,
} from "../errors/durable-execution.error.js";
import type { BackoffPolicy } from "../interfaces/backoff-policy.interface.js";
import type { StepMiddleware } from "../interfaces/middleware.interface.js";
import type { StepContext } from "../interfaces/step-context.interface.js";
import type {
  Serializable,
  SerializableInput,
} from "../interfaces/serializable.interface.js";
import type { StepOptions } from "../interfaces/step-options.interface.js";
import type { StorageAdapter } from "../interfaces/storage-adapter.interface.js";
import type { WorkflowContext } from "../interfaces/workflow-context.interface.js";
import {
  NonSerializableValueError,
  assertSerializable,
} from "../utilities/serialization.utility.js";
import {
  DEFAULT_BACKOFF_POLICY,
  computeBackoffMilliseconds,
} from "../utilities/backoff.utility.js";
import { runMiddlewarePipeline } from "../utilities/middleware-pipeline.utility.js";
import {
  readWorkflowMetadata,
  type Constructor,
  type WorkflowClassMetadata,
} from "../decorators/workflow-metadata.js";
import {
  conventionalClassifierName,
  conventionalProbeName,
} from "../decorators/workflow.decorator.js";

/**
 * Configuration for a {@link WorkflowEngine}. All fields are optional; the
 * injectable clock, randomness, and codec exist primarily so tests can make the
 * engine fully deterministic.
 */
export interface WorkflowEngineOptions {
  /** The default lease duration applied to steps that do not specify one. */
  defaultLeaseMilliseconds?: number;
  /** An injectable clock returning the current instant. */
  now?: () => Date;
  /** An injectable source of randomness in `[0, 1)` for backoff jitter. */
  randomNumberGenerator?: () => number;
  /** Middleware applied to every step executed by this engine, outermost first. */
  middleware?: StepMiddleware[];
  /**
   * Serializes a value into a binary buffer for persistence. Persisting values
   * as buffers keeps the storage layer agnostic to the serialization format and
   * allows binary-friendly codecs. Defaults to UTF-8 encoded JSON.
   */
  encode?: (value: unknown) => Buffer;
  /**
   * Deserializes a persisted binary buffer back into a value. Must be the
   * inverse of {@link WorkflowEngineOptions.encode}. Defaults to parsing UTF-8
   * encoded JSON.
   */
  decode?: (raw: Buffer) => unknown;
  /**
   * Invoked when recording a workflow failure (status update or audit event)
   * itself throws. This lets operators observe storage problems that would
   * otherwise be silently swallowed to preserve the original error. Defaults to
   * a no-op.
   */
  onRecordingError?: (workflowIdentifier: string, error: unknown) => void;
  /**
   * When `true`, every value about to be persisted (workflow input and output,
   * and each step result) is checked at run time to confirm it is serializable
   * before encoding. A non-serializable value throws a clear error at the point
   * of use rather than corrupting persisted state or failing on a later resume.
   *
   * The compile-time `Serializable` constraint already catches most mistakes;
   * this hook is a runtime safety net for values that slipped through a cast.
   * It is off by default to avoid the small traversal cost on every step.
   */
  validateSerializable?: boolean;
}

/**
 * The signature of a workflow definition body. Both the input and output must
 * be {@link Serializable}, because the input is persisted when the workflow is
 * created and the output is persisted on completion.
 */
type WorkflowFunction<TInput extends SerializableInput, TOutput extends SerializableInput> = (
  context: WorkflowContext,
  input: TInput,
) => Promise<TOutput>;

/** The default lease duration when neither the step nor the engine specifies one. */
const DEFAULT_LEASE_MILLISECONDS = 30_000;

/**
 * The heart of the library: a storage-backed durable execution engine.
 *
 * The engine registers named workflow definitions and runs them against a
 * {@link StorageAdapter}. Each durable step follows a check-execute-commit
 * cycle: the engine first checks for a memoized result, then atomically claims
 * the step, executes it through the middleware pipeline, and finally commits the
 * outcome. Ambiguous failures are handled specially by probing the downstream
 * system before executing again.
 */
export class WorkflowEngine {
  private readonly storage: StorageAdapter;
  private readonly defaultLeaseMilliseconds: number;
  private readonly now: () => Date;
  private readonly randomNumberGenerator: () => number;
  private readonly engineMiddleware: StepMiddleware[];
  private readonly encode: (value: unknown) => Buffer;
  private readonly decode: (raw: Buffer) => unknown;
  private readonly onRecordingError: (workflowIdentifier: string, error: unknown) => void;
  private readonly validateSerializable: boolean;
  private readonly definitions = new Map<string, WorkflowFunction<any, any>>();
  /**
   * Steps whose lease this engine currently holds, keyed by
   * `workflowId\u0000stepKey` with the fence token from the claim. Used by
   * {@link WorkflowEngine.releaseInFlightSteps} to relinquish leases on a
   * graceful shutdown so other workers can take over immediately.
   */
  private readonly inFlightLeases = new Map<string, { workflowIdentifier: string; stepKey: string; fenceToken: number }>();

  public constructor(storage: StorageAdapter, options: WorkflowEngineOptions = {}) {
    this.storage = storage;
    this.defaultLeaseMilliseconds =
      options.defaultLeaseMilliseconds ?? DEFAULT_LEASE_MILLISECONDS;
    this.now = options.now ?? (() => new Date());
    this.randomNumberGenerator = options.randomNumberGenerator ?? Math.random;
    this.engineMiddleware = options.middleware ?? [];
    this.encode =
      options.encode ?? ((value) => Buffer.from(JSON.stringify(value ?? null), "utf8"));
    this.decode = options.decode ?? ((raw) => JSON.parse(raw.toString("utf8")));
    this.onRecordingError = options.onRecordingError ?? (() => undefined);
    this.validateSerializable = options.validateSerializable ?? false;
  }

  /**
   * Encodes a value for persistence, first checking that it is serializable
   * when runtime validation is enabled. The `description` names what is being
   * encoded so any error points the developer to the offending value.
   */
  private encodeForPersistence(value: unknown, description: string): Buffer {
    if (this.validateSerializable) {
      assertSerializable(value, description);
    }
    return this.encode(value);
  }

  /**
   * Registers a named workflow definition. Registering the same name twice is
   * an error, because a stable name is part of the workflow's persisted identity.
   */
  public defineWorkflow<TInput extends SerializableInput, TOutput extends SerializableInput>(
    name: string,
    workflowFunction: WorkflowFunction<TInput, TOutput>,
  ): WorkflowFunction<TInput, TOutput> {
    if (this.definitions.has(name)) {
      throw new Error(`Workflow "${name}" is already defined.`);
    }
    this.definitions.set(name, workflowFunction);
    return workflowFunction;
  }

  /**
   * Starts a new workflow execution or resumes an existing one with the same
   * identifier. Completed steps are memoized, so resuming re-runs only the work
   * that has not yet committed.
   *
   * The workflow to run may be identified in three interchangeable ways:
   *
   *  - by the string name of a definition previously registered with
   *    {@link WorkflowEngine.defineWorkflow};
   *  - by a class annotated with {@link Workflow}; or
   *  - by an already-constructed instance of such a class, which is convenient
   *    when the workflow needs injected dependencies.
   *
   * In every case the workflow identifier is an explicit, stable string (such as
   * an order id). It is what lets the engine recognise the same run across
   * restarts and memoise completed steps.
   */
  public run<TInput extends SerializableInput, TOutput extends SerializableInput>(
    name: string,
    workflowIdentifier: string,
    input: TInput,
  ): Promise<TOutput>;
  public run<TInput extends SerializableInput, TOutput extends SerializableInput>(
    workflowClassOrInstance: Constructor | object,
    workflowIdentifier: string,
    input: TInput,
  ): Promise<TOutput>;
  public async run<TInput extends SerializableInput, TOutput extends SerializableInput>(
    nameOrClassOrInstance: string | Constructor | object,
    workflowIdentifier: string,
    input: TInput,
  ): Promise<TOutput> {
    // Dispatch on the shape of the first argument. A string selects a
    // registered functional definition; anything else is treated as a
    // decorator-based workflow class or instance.
    if (typeof nameOrClassOrInstance === "string") {
      const workflowFunction = this.definitions.get(nameOrClassOrInstance) as
        | WorkflowFunction<TInput, TOutput>
        | undefined;
      if (!workflowFunction) {
        throw new Error(`Workflow "${nameOrClassOrInstance}" is not defined.`);
      }
      return this.executeWorkflow(
        nameOrClassOrInstance,
        workflowIdentifier,
        input,
        workflowFunction,
      );
    }

    const { name, workflowFunction } = buildWorkflowFromClass<TInput, TOutput>(
      nameOrClassOrInstance,
    );
    return this.executeWorkflow(name, workflowIdentifier, input, workflowFunction);
  }

  /**
   * The shared execution core used by every {@link WorkflowEngine.run} overload.
   * It persists the workflow record, invokes the workflow function against a
   * fresh context, and records the terminal outcome.
   */
  private async executeWorkflow<TInput extends SerializableInput, TOutput extends SerializableInput>(
    name: string,
    workflowIdentifier: string,
    input: TInput,
    workflowFunction: WorkflowFunction<TInput, TOutput>,
  ): Promise<TOutput> {
    await this.storage.ensureWorkflow(
      workflowIdentifier,
      name,
      this.encodeForPersistence(input, `input of workflow "${name}"`),
    );
    await this.storage.setWorkflowStatus(workflowIdentifier, WorkflowStatus.RUNNING);

    const context = this.createWorkflowContext(workflowIdentifier);
    try {
      const output = await workflowFunction(context, input);
      await this.storage.setWorkflowStatus(workflowIdentifier, WorkflowStatus.COMPLETED, {
        output: this.encodeForPersistence(output, `output of workflow "${name}"`),
      });
      await this.storage.logEvent(workflowIdentifier, null, EventType.WORKFLOW_COMPLETED, {});
      return output;
    } catch (error) {
      // A durable sleep that is not yet due unwinds the run to suspend it. This
      // is not a failure: the workflow is parked as SUSPENDED, and the scheduler
      // resumes it once the sleep timer becomes due. We record the state and
      // re-throw so the caller (for example, a queue consumer) knows this run
      // did not complete and should not be treated as done.
      if (error instanceof WorkflowSuspendedError) {
        try {
          await this.storage.setWorkflowStatus(workflowIdentifier, WorkflowStatus.SUSPENDED);
        } catch (recordingError) {
          this.onRecordingError(workflowIdentifier, recordingError);
        }
        throw error;
      }

      // The workflow body threw. We attempt to record the failure durably and
      // then re-throw the original error so the caller (typically a queue
      // consumer) can decide whether to redeliver.
      //
      // Behaviour when the failure-recording calls themselves throw:
      // `WorkflowEngine.describeError`, `setWorkflowStatus`, and `logEvent` are
      // performed on a best-effort basis inside their own try/catch. If the
      // storage backend is unreachable, persisting the FAILED status or the
      // audit event may fail. We deliberately swallow such secondary errors so
      // that the original, more meaningful error is the one propagated to the
      // caller; masking it with a storage error would obscure the true cause.
      // The workflow simply remains in the RUNNING state in that case and will
      // be retried on the next resume, which is safe because steps are
      // idempotent. Any swallowed secondary error is surfaced through the
      // optional diagnostics hook so operators are not left blind.
      try {
        const message = WorkflowEngine.describeError(error);
        await this.storage.setWorkflowStatus(workflowIdentifier, WorkflowStatus.FAILED, {
          error: message,
        });
        await this.storage.logEvent(workflowIdentifier, null, EventType.WORKFLOW_FAILED, {
          error: message,
        });
      } catch (recordingError) {
        this.onRecordingError(workflowIdentifier, recordingError);
      }
      throw error;
    }
  }

  /** Builds the durable primitives exposed to a workflow body. */
  private createWorkflowContext(workflowIdentifier: string): WorkflowContext {
    return {
      workflowIdentifier,
      step: <TResult extends Serializable>(
        stepKey: string,
        stepFunction: (context: StepContext) => Promise<TResult>,
        options?: StepOptions<TResult>,
      ) => this.executeStep(workflowIdentifier, stepKey, stepFunction, options ?? {}),
      sleep: (timerKey: string, durationMilliseconds: number) =>
        this.performDurableSleep(workflowIdentifier, timerKey, durationMilliseconds),
    };
  }

  /**
   * Performs a durable sleep. The timer is recorded exactly once for the given
   * key, so this is idempotent across resumes. If the due time has not yet
   * arrived, the workflow is suspended (by throwing {@link WorkflowSuspendedError},
   * which the run loop turns into a `SUSPENDED` state) and the scheduler resumes
   * it later. If the due time has passed, the sleep returns and execution
   * continues past it.
   */
  private async performDurableSleep(
    workflowIdentifier: string,
    timerKey: string,
    durationMilliseconds: number,
  ): Promise<void> {
    const runAt = addMilliseconds(this.now(), durationMilliseconds);
    // Idempotent: the first call fixes the due time; later calls (on resume)
    // return the existing due time rather than sliding it forward.
    const timer = await this.storage.ensureSleepTimer(workflowIdentifier, timerKey, runAt);

    if (isAfter(timer.runAt, this.now())) {
      // Not due yet. Suspend the workflow until the scheduler resumes it.
      await this.storage.logEvent(workflowIdentifier, timerKey, EventType.TIMER_SCHEDULED, {
        runAt: timer.runAt.toISOString(),
      });
      throw new WorkflowSuspendedError(workflowIdentifier, timerKey, timer.runAt);
    }
    // The due time has passed; the sleep is over and execution continues.
  }

  /**
   * Executes a single durable step following the check-execute-commit cycle,
   * with ambiguous-state resolution performed before any re-execution.
   */
  private async executeStep<TResult extends Serializable>(
    workflowIdentifier: string,
    stepKey: string,
    stepFunction: (context: StepContext) => Promise<TResult>,
    options: StepOptions<TResult>,
  ): Promise<TResult> {
    const maxAttempts = options.maxAttempts ?? 1;
    const leaseMilliseconds = options.leaseMilliseconds ?? this.defaultLeaseMilliseconds;
    const backoffPolicy = options.backoff ?? DEFAULT_BACKOFF_POLICY;
    const classifyError =
      options.classifyError ?? ((): FailureKind => FailureKind.DEFINITE);

    const claim = await this.storage.claimStep(
      workflowIdentifier,
      stepKey,
      maxAttempts,
      leaseMilliseconds,
    );

    // The step is already terminal; return the memoized output without running,
    // unless the step opted into result expiry and the saved result is stale.
    if (claim.cachedResult) {
      const previousResult = this.decodeOutput<TResult>(claim.cachedResult.output);
      await this.assertResultStillFresh(
        workflowIdentifier,
        stepKey,
        options,
        previousResult,
        claim.cachedResult.completedAt,
      );
      return previousResult;
    }

    // Another worker holds a live lease; treat this as a transient condition so
    // the workflow is resumed later rather than proceeding without the result.
    if (!claim.claimed) {
      throw new StepExhaustedError(
        workflowIdentifier,
        stepKey,
        claim.attempt,
        "the step is currently leased by another worker",
      );
    }

    const context: StepContext = {
      workflowIdentifier,
      stepKey,
      attempt: claim.attempt,
    };

    // Ambiguous-state resolution: probe before executing to avoid duplicating
    // a side effect that may already have happened.
    if (claim.priorStatus === StepStatus.AMBIGUOUS) {
      const resolution = await this.resolveAmbiguousStep(context, claim.fenceToken, options);
      if (resolution.resolved) {
        return resolution.value as TResult;
      }
      // The probe reported the effect did not happen, so fall through and run.
    }

    await this.storage.logEvent(workflowIdentifier, stepKey, EventType.STEP_STARTED, {
      attempt: claim.attempt,
    });

    // Track this lease while the step runs, so a graceful shutdown can release
    // it promptly rather than leaving it to expire.
    const leaseKey = `${workflowIdentifier}\u0000${stepKey}`;
    this.inFlightLeases.set(leaseKey, {
      workflowIdentifier,
      stepKey,
      fenceToken: claim.fenceToken,
    });

    try {
      const combinedMiddleware = [...this.engineMiddleware, ...(options.middleware ?? [])];
      const result = (await runMiddlewarePipeline(combinedMiddleware, context, () =>
        stepFunction(context),
      )) as TResult;

      const committed = await this.storage.commitStep(
        workflowIdentifier,
        stepKey,
        claim.fenceToken,
        this.encodeForPersistence(result, `result of step "${stepKey}"`),
        StepStatus.COMPLETED,
      );
      if (!committed) {
        // A newer claim superseded this one; return the authoritative result.
        return await this.readCommittedResult<TResult>(workflowIdentifier, stepKey);
      }

      await this.storage.logEvent(workflowIdentifier, stepKey, EventType.STEP_COMPLETED, {
        attempt: claim.attempt,
      });
      return result;
    } catch (error) {
      // A non-serializable result is a programming error, not a transient
      // failure of the step's work. Propagate it directly rather than treating
      // it as a failed attempt to retry, so the developer sees the real problem.
      if (error instanceof NonSerializableValueError) {
        throw error;
      }
      return await this.handleStepFailure(
        context,
        claim.fenceToken,
        claim.attempt,
        maxAttempts,
        backoffPolicy,
        classifyError,
        options,
        error,
      );
    } finally {
      // The step has finished one way or another (committed, failed, or threw),
      // so its lease is no longer in flight and must not be released later.
      this.inFlightLeases.delete(leaseKey);
    }
  }

  /**
   * Releases the lease on a specific step, making it immediately claimable by
   * another worker. This delegates to the storage adapter and is guarded by the
   * fence token, so only the current holder can release it.
   *
   * @returns `true` if the lease was released, `false` if the token was stale.
   */
  public releaseStep(
    workflowIdentifier: string,
    stepKey: string,
    fenceToken: number,
  ): Promise<boolean> {
    return this.storage.releaseStep(workflowIdentifier, stepKey, fenceToken);
  }

  /**
   * Releases every lease this engine currently holds for in-flight steps.
   *
   * Call this during a graceful shutdown, after you have stopped accepting new
   * work, so that steps interrupted by the shutdown become immediately claimable
   * by another worker instead of waiting for their leases to expire. Releases
   * are attempted for all tracked leases even if some fail.
   */
  public async releaseInFlightSteps(): Promise<void> {
    const leases = [...this.inFlightLeases.values()];
    this.inFlightLeases.clear();
    await Promise.all(
      leases.map((lease) =>
        this.storage
          .releaseStep(lease.workflowIdentifier, lease.stepKey, lease.fenceToken)
          .catch((error) => this.onRecordingError(lease.workflowIdentifier, error)),
      ),
    );
  }

  /**
   * Attempts to resolve an ambiguous step by probing the downstream system. A
   * non-null probe result marks the step complete and skips execution; a null
   * result allows execution to proceed. When no probe is available the step is
   * parked for manual review.
   */
  private async resolveAmbiguousStep<TResult extends Serializable>(
    context: StepContext,
    fenceToken: number,
    options: StepOptions<TResult>,
  ): Promise<{ resolved: true; value: TResult } | { resolved: false }> {
    if (!options.probe) {
      await this.storage.failStep(
        context.workflowIdentifier,
        context.stepKey,
        fenceToken,
        "ambiguous outcome with no probe available",
        StepStatus.NEEDS_REVIEW,
        null,
      );
      await this.storage.logEvent(
        context.workflowIdentifier,
        context.stepKey,
        EventType.STEP_NEEDS_REVIEW,
        {},
      );
      throw new StepNeedsReviewError(context.workflowIdentifier, context.stepKey);
    }

    await this.storage.logEvent(
      context.workflowIdentifier,
      context.stepKey,
      EventType.STEP_PROBE_STARTED,
      { attempt: context.attempt },
    );
    const probedValue = await options.probe(context);

    if (probedValue !== null && probedValue !== undefined) {
      await this.storage.commitStep(
        context.workflowIdentifier,
        context.stepKey,
        fenceToken,
        this.encodeForPersistence(probedValue, `probe result of step "${context.stepKey}"`),
        StepStatus.COMPLETED,
      );
      await this.storage.logEvent(
        context.workflowIdentifier,
        context.stepKey,
        EventType.STEP_PROBE_RESOLVED,
        {},
      );
      return { resolved: true, value: probedValue };
    }

    await this.storage.logEvent(
      context.workflowIdentifier,
      context.stepKey,
      EventType.STEP_PROBE_EMPTY,
      {},
    );
    return { resolved: false };
  }

  /** Applies the failure policy: retry, ambiguous parking, optional fallback, or terminal failure. */
  private async handleStepFailure<TResult extends Serializable>(
    context: StepContext,
    fenceToken: number,
    attempt: number,
    maxAttempts: number,
    backoffPolicy: BackoffPolicy,
    classifyError: (error: unknown) => FailureKind,
    options: StepOptions<TResult>,
    error: unknown,
  ): Promise<TResult> {
    const message = WorkflowEngine.describeError(error);
    const failureKind = classifyError(error);
    const hasAttemptsRemaining = attempt < maxAttempts;

    // Ambiguous failure: record the ambiguous status so recovery probes next time.
    if (failureKind === FailureKind.AMBIGUOUS) {
      const retryAt = hasAttemptsRemaining
        ? addMilliseconds(
            this.now(),
            computeBackoffMilliseconds(backoffPolicy, attempt, this.randomNumberGenerator),
          )
        : null;
      await this.storage.failStep(
        context.workflowIdentifier,
        context.stepKey,
        fenceToken,
        message,
        StepStatus.AMBIGUOUS,
        retryAt,
      );
      await this.storage.logEvent(
        context.workflowIdentifier,
        context.stepKey,
        EventType.STEP_AMBIGUOUS,
        { attempt, retryAt: retryAt ? retryAt.toISOString() : null },
      );
      if (hasAttemptsRemaining) {
        throw new StepExhaustedError(context.workflowIdentifier, context.stepKey, attempt, message);
      }
      // Without remaining attempts only a probe on the next resume can resolve it.
      throw new StepNeedsReviewError(context.workflowIdentifier, context.stepKey);
    }

    // Definite failure with attempts remaining: schedule a retry.
    if (hasAttemptsRemaining) {
      const retryAt = addMilliseconds(
        this.now(),
        computeBackoffMilliseconds(backoffPolicy, attempt, this.randomNumberGenerator),
      );
      await this.storage.failStep(
        context.workflowIdentifier,
        context.stepKey,
        fenceToken,
        message,
        StepStatus.FAILED,
        retryAt,
      );
      await this.storage.logEvent(
        context.workflowIdentifier,
        context.stepKey,
        EventType.STEP_RETRY_SCHEDULED,
        { attempt, retryAt: retryAt.toISOString() },
      );
      throw new StepExhaustedError(context.workflowIdentifier, context.stepKey, attempt, message);
    }

    // Terminal failure of an optional step: continue with the fallback value.
    if (options.optional) {
      const fallbackValue = (options.fallbackValue ?? null) as TResult;
      await this.storage.failStep(
        context.workflowIdentifier,
        context.stepKey,
        fenceToken,
        message,
        StepStatus.FAILED_OPTIONAL,
        null,
      );
      await this.storage.logEvent(
        context.workflowIdentifier,
        context.stepKey,
        EventType.STEP_OPTIONAL_FAILED,
        { attempt, error: message },
      );
      return fallbackValue;
    }

    // Terminal failure of a mandatory step: fail the workflow.
    await this.storage.failStep(
      context.workflowIdentifier,
      context.stepKey,
      fenceToken,
      message,
      StepStatus.FAILED,
      null,
    );
    await this.storage.logEvent(context.workflowIdentifier, context.stepKey, EventType.STEP_FAILED, {
      attempt,
      error: message,
    });
    throw new StepExhaustedError(context.workflowIdentifier, context.stepKey, attempt, message);
  }

  /**
   * Enforces an opt-in freshness policy for a memoized step result. If the step
   * declared `resultTtlMilliseconds` or `revalidate` and the saved result is
   * stale, this raises {@link StepResultExpiredError}. Steps that opted into
   * neither are always considered fresh, preserving the default guarantee that a
   * completed step is final and never re-run.
   */
  private async assertResultStillFresh<TResult extends Serializable>(
    workflowIdentifier: string,
    stepKey: string,
    options: StepOptions<TResult>,
    previousResult: TResult,
    completedAt: Date | null,
  ): Promise<void> {
    if (options.resultTtlMilliseconds !== undefined && completedAt !== null) {
      const expiresAt = addMilliseconds(completedAt, options.resultTtlMilliseconds);
      if (isAfter(this.now(), expiresAt)) {
        throw new StepResultExpiredError(workflowIdentifier, stepKey);
      }
    }

    if (options.revalidate) {
      const stillValid = await options.revalidate(previousResult);
      if (!stillValid) {
        throw new StepResultExpiredError(workflowIdentifier, stepKey);
      }
    }
  }

  /** Re-reads the authoritative committed result after losing a commit race. */
  private async readCommittedResult<TResult extends Serializable>(
    workflowIdentifier: string,
    stepKey: string,
  ): Promise<TResult> {
    const claim = await this.storage.claimStep(workflowIdentifier, stepKey, 1, 0);
    if (claim.cachedResult) {
      return this.decodeOutput<TResult>(claim.cachedResult.output);
    }
    throw new StepExhaustedError(
      workflowIdentifier,
      stepKey,
      claim.attempt,
      "lost the commit race and no committed result was available",
    );
  }

  /** Decodes a persisted output buffer, treating a missing value as `null`. */
  private decodeOutput<TResult extends Serializable>(raw: Buffer | null): TResult {
    if (raw === null) {
      return null as TResult;
    }
    return this.decode(raw) as TResult;
  }

  /**
   * Produces a human-readable message for any thrown value.
   *
   * This is a static method rather than a free function because it is a pure
   * helper that belongs to the engine's concern of describing failures, needs
   * no instance state, and is referenced from the failure-handling paths above.
   */
  private static describeError(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}

/**
 * Converts a decorator-based workflow class or instance into the workflow name
 * and functional body the engine already knows how to run.
 *
 * This is the whole of the "decorators are a thin wrapper" promise: the metadata
 * recorded by {@link Workflow} and {@link Step} is read here, and each decorated
 * step method is wrapped so that invoking it from the lifecycle method routes
 * transparently through `context.step` with the configured options. Nothing in
 * the core execution engine needs to know decorators exist.
 *
 * @param classOrInstance A workflow constructor (which is instantiated with no
 *   arguments) or an already-constructed instance (useful for dependency
 *   injection).
 */
function buildWorkflowFromClass<TInput extends SerializableInput, TOutput extends SerializableInput>(
  classOrInstance: Constructor | object,
): { name: string; workflowFunction: WorkflowFunction<TInput, TOutput> } {
  // Determine the instance and its constructor, whichever form was supplied.
  const isConstructor = typeof classOrInstance === "function";
  const constructor = (
    isConstructor ? classOrInstance : classOrInstance.constructor
  ) as Constructor;
  const instance = isConstructor
    ? (new (classOrInstance as Constructor)() as Record<string, unknown>)
    : (classOrInstance as Record<string, unknown>);

  const metadata = readWorkflowMetadata(constructor);
  if (!metadata) {
    throw new Error(
      `Class "${constructor.name}" is not a workflow. Did you forget the @Workflow() decorator?`,
    );
  }

  const lifecycleMethod = instance[metadata.lifecycleMethodName];
  if (typeof lifecycleMethod !== "function") {
    throw new Error(
      `Workflow "${metadata.name}" has no lifecycle method "${metadata.lifecycleMethodName}".`,
    );
  }

  const workflowFunction: WorkflowFunction<TInput, TOutput> = async (context, input) => {
    // Build an instance whose decorated step methods are replaced with wrappers
    // that run through `context.step`. The wrapper is bound per run so it can
    // capture this run's context. Non-step methods and fields are left intact,
    // so injected dependencies continue to work.
    const runScopedInstance = wrapStepMethods(instance, metadata, context);
    const boundLifecycle = (
      runScopedInstance[metadata.lifecycleMethodName] as WorkflowFunction<TInput, TOutput>
    ).bind(runScopedInstance);
    return boundLifecycle(context, input);
  };

  return { name: metadata.name, workflowFunction };
}

/**
 * Produces a per-run view of a workflow instance in which every decorated step
 * method is replaced by a wrapper that executes it as a durable step.
 *
 * The original instance is not mutated. Instead a lightweight object is created
 * that inherits from the instance (so its fields and non-step methods remain
 * available) and overrides only the decorated methods. For each step, the probe
 * and error classifier are resolved from the class (see
 * {@link resolveCompanionMethods}) and merged into the step's options.
 */
function wrapStepMethods(
  instance: Record<string, unknown>,
  metadata: WorkflowClassMetadata,
  context: WorkflowContext,
): Record<string, unknown> {
  const runScopedInstance: Record<string, unknown> = Object.create(instance);

  for (const [methodName, stepMetadata] of metadata.stepsByMethodName) {
    const originalMethod = instance[methodName];
    if (typeof originalMethod !== "function") {
      continue;
    }

    const resolvedOptions = resolveCompanionMethods(
      instance,
      runScopedInstance,
      metadata,
      methodName,
      stepMetadata.options,
    );

    runScopedInstance[methodName] = (...callArguments: unknown[]) =>
      context.step(
        stepMetadata.stepKey,
        // The step function calls the original method with the same arguments,
        // preserving `this` so the method can still read the instance's fields.
        // The reflective wrapper cannot know the concrete result type, so the
        // return is treated as Serializable here; the actual serializability is
        // enforced at the authoring site by the decorated method's own type.
        async () =>
          (await (originalMethod as (...args: unknown[]) => Promise<unknown>).apply(
            runScopedInstance,
            callArguments,
          )) as Serializable,
        resolvedOptions,
      );
  }

  return runScopedInstance;
}

/**
 * Resolves the probe and error classifier for a step and merges them into its
 * options.
 *
 * Resolution order for each companion, strongest first:
 *   1. an inline value already present in the `@Step` options;
 *   2. an explicit association from `@Probe` / `@ClassifyError`;
 *   3. the naming convention (`probe<Method>`, `classifyErrorFor<Method>`).
 *
 * Companion methods are bound to the run-scoped instance so they see the same
 * `this` (and injected dependencies) as the step itself.
 */
function resolveCompanionMethods(
  instance: Record<string, unknown>,
  runScopedInstance: Record<string, unknown>,
  metadata: WorkflowClassMetadata,
  stepMethodName: string,
  baseOptions: StepOptions,
): StepOptions<Serializable> {
  const options: StepOptions<Serializable> = { ...(baseOptions as StepOptions<Serializable>) };

  if (options.probe === undefined) {
    const probeMethodName =
      metadata.probeByStepMethodName.get(stepMethodName) ??
      findMethodByName(instance, conventionalProbeName(stepMethodName));
    if (probeMethodName) {
      const probeMethod = instance[probeMethodName] as (
        context: StepContext,
      ) => Promise<Serializable | null>;
      options.probe = (stepContext: StepContext) =>
        probeMethod.apply(runScopedInstance, [stepContext]);
    }
  }

  if (options.classifyError === undefined) {
    const classifierMethodName =
      metadata.classifierByStepMethodName.get(stepMethodName) ??
      findMethodByName(instance, conventionalClassifierName(stepMethodName));
    if (classifierMethodName) {
      const classifierMethod = instance[classifierMethodName] as (
        error: unknown,
      ) => FailureKind;
      options.classifyError = (error: unknown) =>
        classifierMethod.apply(runScopedInstance, [error]);
    }
  }

  return options;
}

/** Returns the method name if the instance has a callable method with it, else undefined. */
function findMethodByName(
  instance: Record<string, unknown>,
  methodName: string,
): string | undefined {
  return typeof instance[methodName] === "function" ? methodName : undefined;
}
