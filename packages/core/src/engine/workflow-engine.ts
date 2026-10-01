import { addMilliseconds, isAfter } from "date-fns";

import { EventType } from "../enums/event-type.enum.js";
import { FailureKind } from "../enums/failure-kind.enum.js";
import { StepStatus } from "../enums/step-status.enum.js";
import { WorkflowStatus } from "../enums/workflow-status.enum.js";
import {
    StepExhaustedError,
    StepNeedsReviewError,
    StepResultExpiredError,
    WorkflowCancelledError,
    WorkflowSuspendedError,
} from "../errors/durable-execution.error.js";
import { NonSerializableValueError } from "../errors/serialization.error.js";
import type { BackoffPolicy } from "../interfaces/backoff-policy.interface.js";
import type { StepMiddleware } from "../interfaces/middleware.interface.js";
import type { StepContext } from "../interfaces/step-context.interface.js";
import type { Serializable, SerializableInput } from "../interfaces/serializable.interface.js";
import type { StepOptions } from "../interfaces/step-options.interface.js";
import type { StorageAdapter } from "../interfaces/storage-adapter.interface.js";
import type { WorkflowContext } from "../interfaces/workflow-context.interface.js";
import { SerializationValidator } from "../utilities/serialization.utility.js";
import { BackoffCalculator } from "../utilities/backoff.utility.js";
import { MiddlewarePipeline } from "../utilities/middleware-pipeline.utility.js";
import type { Constructor } from "../decorators/constructor.js";
import { SerializationRegistry } from "../serialization/serialization-registry.js";
import type { Workflow } from "../entities/workflow.entity.js";
import type { WorkflowFilter } from "../interfaces/storage-adapter.interface.js";
import type {
    ChildWorkflowHandle,
    ChildWorkflowOptions,
} from "../interfaces/workflow-context.interface.js";
import type { ResolvedWorkflow, WorkflowFunction } from "./workflow-function.type.js";
import { WorkflowClassAdapter } from "./workflow-class-adapter.js";
import { WorkflowIdentifier } from "../utilities/workflow-identifier.utility.js";
import { ErrorChain } from "../utilities/error-chain.utility.js";

/**
 * Configuration for a {@link WorkflowEngine}. All fields are optional; the
 * injectable clock, randomness, and codec exist primarily so tests can make the
 * engine fully deterministic.
 */
export interface WorkflowEngineOptions {
    /**
     * The default lease duration applied to steps that do not specify one.
     */
    defaultLeaseMilliseconds?: number;
    /**
     * An injectable clock returning the current instant.
     */
    now?: () => Date;
    /**
     * An injectable source of randomness in `[0, 1)` for backoff jitter.
     */
    randomNumberGenerator?: () => number;
    /**
     * Middleware applied to every step executed by this engine, outermost
     * first.
     */
    middleware?: StepMiddleware[];
    /**
     * Serializes a value into a binary buffer for persistence. Persisting
     * values as buffers keeps the storage layer agnostic to the serialization
     * format and allows binary-friendly codecs. Defaults to UTF-8 encoded
     * JSON.
     *
     * Prefer {@link WorkflowEngineOptions.serialization} when you want to
     * persist rich types (Date, Map, and so on) through registered recipes;
     * `encode`/`decode` are the lower-level escape hatch for a wholly custom
     * format. Supplying both a `serialization` registry and `encode`/`decode`
     * is an error.
     */
    encode?: (value: unknown) => Buffer;
    /**
     * Deserializes a persisted binary buffer back into a value. Must be the
     * inverse of {@link WorkflowEngineOptions.encode}. Defaults to parsing UTF-8
     * encoded JSON.
     */
    decode?: (raw: Buffer) => unknown;
    /**
     * A {@link SerializationRegistry} used to encode and decode every persisted
     * value. This is the recommended way to persist rich types such as `Date`
     * and `Map`: register recipes on the registry and the engine applies them
     * everywhere. Mutually exclusive with `encode`/`decode`.
     */
    serialization?: SerializationRegistry;
    /**
     * An injectable UUID generator, used by {@link WorkflowContext.randomUUID}.
     * Defaults to the platform `crypto.randomUUID`. Provided so tests can make
     * id generation deterministic.
     */
    uuid?: () => string;
    /**
     * Invoked when the engine swallows a secondary error to preserve a more
     * meaningful primary one. This happens in two places: when recording a
     * workflow's terminal or suspended state (a status update or audit event)
     * fails, and when releasing an in-flight step lease during shutdown fails.
     * In both cases the engine keeps going and reports the swallowed error here
     * instead of throwing it, so operators can observe storage problems that
     * would otherwise be invisible.
     *
     * Note that step and workflow execution errors are not delivered here: those
     * propagate to the caller of {@link WorkflowEngine.run} normally. This hook
     * is only for the secondary errors the engine deliberately suppresses.
     * Defaults to a no-op.
     */
    onRecordingError?: (workflowId: string, error: unknown) => void;
    /**
     * When `true`, every value about to be persisted (workflow input and
     * output, and each step result) is checked at run time to confirm it is
     * serializable before encoding. A non-serializable value throws a clear
     * error at the point of use rather than corrupting persisted state or
     * failing on a later resume.
     *
     * The compile-time `Serializable` constraint already catches most mistakes;
     * this hook is a runtime safety net for values that slipped through a cast.
     * It is off by default to avoid the small traversal cost on every step.
     */
    validateSerializable?: boolean;
}

/**
 * A decoded, public-facing snapshot of a stored workflow execution, returned by
 * the lifecycle-management API ({@link WorkflowEngine.describeWorkflow} and
 * {@link WorkflowEngine.listWorkflows}). Unlike the raw {@link Workflow} entity,
 * its `input` and `output` are decoded values rather than binary buffers.
 */
export interface WorkflowDescription<
    TInput extends SerializableInput = SerializableInput,
    TOutput extends SerializableInput = SerializableInput,
> {
    /**
     * The stable identifier of this workflow execution.
     */
    workflowId: string;
    /**
     * The name of the workflow definition.
     */
    workflowName: string;
    /**
     * The parent workflow that started this one as a child, or `null`.
     */
    parentWorkflowId: string | null;
    /**
     * The current lifecycle status.
     */
    status: WorkflowStatus;
    /**
     * The decoded input the workflow was started with, or `null`.
     */
    input: TInput | null;
    /**
     * The decoded output, present only once the workflow has completed.
     */
    output: TOutput | null;
    /**
     * A human-readable terminal error message, present only when failed.
     */
    error: string | null;
    /**
     * When the execution record was first created.
     */
    createdAt: Date;
    /**
     * When the execution record was last modified.
     */
    updatedAt: Date;
}

/**
 * A step lease this engine currently holds, tracked so a graceful shutdown can
 * release it promptly rather than leaving it to expire.
 */
interface InFlightLease {
    /**
     * The workflow that owns the leased step.
     */
    workflowId: string;
    /**
     * The key of the leased step within its workflow.
     */
    stepKey: string;
    /**
     * The fence token issued when the step was claimed, used to release the
     * exact lease this engine holds.
     */
    fenceToken: number;
}

/**
 * Options accepted by {@link WorkflowEngine.getWorkflowResult}.
 */
export interface GetWorkflowResultOptions {
    /**
     * When `true`, throw if the workflow has not reached a terminal completed
     * state instead of returning `null`.
     */
    throwIfNotComplete?: boolean;
}

/**
 * The outcome of attempting to resolve an ambiguous step through its probe:
 * either resolved with a value, or unresolved so the step should execute.
 */
type AmbiguousStepResolution<TResult> =
    | { resolved: true; value: TResult }
    | { resolved: false };

/**
 * The inputs to a single workflow execution, bundled so the shared execution
 * core and child-workflow dispatch share one readable shape rather than a long
 * positional parameter list.
 */
interface WorkflowExecution<TInput extends SerializableInput, TOutput extends SerializableInput> {
    /**
     * The name of the workflow definition being run.
     */
    name: string;
    /**
     * The stable identifier of this execution.
     */
    workflowId: string;
    /**
     * The input the workflow is started or resumed with.
     */
    input: TInput;
    /**
     * The functional body to invoke.
     */
    workflowFunction: WorkflowFunction<TInput, TOutput>;
    /**
     * The parent workflow that started this one as a child, or `null` for a
     * top-level run.
     */
    parentWorkflowId?: string | null;
}

/**
 * A durable step to execute, bundling the step's identity, body, and options.
 */
interface StepExecution<TResult extends Serializable> {
    /**
     * The workflow that owns the step.
     */
    workflowId: string;
    /**
     * The stable key that identifies the step within its workflow.
     */
    stepKey: string;
    /**
     * The step body to run when the step is not already memoised.
     */
    stepFunction: (context: StepContext) => Promise<TResult>;
    /**
     * The resolved step options.
     */
    options: StepOptions<TResult>;
}

/**
 * The state of a claimed step attempt that has thrown, bundled so the failure
 * policy is applied from one cohesive value rather than many parameters.
 */
interface StepFailure<TResult extends Serializable> {
    /**
     * The step execution context (workflow id, step key, attempt).
     */
    context: StepContext;
    /**
     * The fence token from the claim, guarding the failure write.
     */
    fenceToken: number;
    /**
     * The maximum number of attempts permitted for the step.
     */
    maxAttempts: number;
    /**
     * The backoff policy used to schedule a retry.
     */
    backoffPolicy: BackoffPolicy;
    /**
     * Classifies the thrown error as definite or ambiguous.
     */
    classifyError: (error: unknown) => FailureKind;
    /**
     * The resolved step options.
     */
    options: StepOptions<TResult>;
    /**
     * The error the step attempt threw.
     */
    error: unknown;
}

/**
 * The inputs needed to start (or resume) a child workflow from within a parent.
 */
interface ChildWorkflowStart<TInput extends SerializableInput> {
    /**
     * The identifier of the parent workflow starting the child.
     */
    parentWorkflowId: string;
    /**
     * A stable key identifying this child within the parent.
     */
    childKey: string;
    /**
     * The child workflow to run, by registered name or by `@Workflow` class or
     * instance.
     */
    nameOrClass: string | Constructor | object;
    /**
     * The input passed to the child.
     */
    input: TInput;
    /**
     * Options controlling the child's identifier.
     */
    options?: ChildWorkflowOptions;
}

/**
 * A memoised step result whose freshness is being checked against the step's
 * opt-in expiry policy.
 */
interface MemoizedStepResult<TResult extends Serializable> {
    /**
     * The workflow that owns the step.
     */
    workflowId: string;
    /**
     * The stable key that identifies the step within its workflow.
     */
    stepKey: string;
    /**
     * The resolved step options carrying any freshness policy.
     */
    options: StepOptions<TResult>;
    /**
     * The decoded prior result being validated.
     */
    previousResult: TResult;
    /**
     * When the memoised result was committed, or `null` when unknown.
     */
    completedAt: Date | null;
}

/**
 * The heart of the library: a storage-backed durable execution engine.
 *
 * The engine registers named workflow definitions and runs them against a
 * {@link StorageAdapter}. Each durable step follows a check-execute-commit
 * cycle: the engine first checks for a memoized result, then atomically claims
 * the step, executes it through the middleware pipeline, and finally commits
 * the outcome. Ambiguous failures are handled specially by probing the
 * downstream system before executing again.
 */
export class WorkflowEngine {
    /**
     * The default lease duration when neither the step nor the engine specifies
     * one.
     */
    public static readonly DEFAULT_LEASE_MILLISECONDS = 30_000;

    /**
     * The storage backend that persists workflow and step state. Every durable
     * operation the engine performs is delegated here, so swapping this adapter
     * changes where state lives without touching the execution logic.
     */
    private readonly storage: StorageAdapter;

    /**
     * The lease duration, in milliseconds, applied to a step that does not
     * specify its own. It is resolved once at construction from the engine
     * options, falling back to {@link WorkflowEngine.DEFAULT_LEASE_MILLISECONDS}.
     */
    private readonly defaultLeaseMilliseconds: number;

    /**
     * Returns the current instant. It is injectable so tests can advance time
     * deterministically; in production it simply reads the wall clock.
     */
    private readonly now: () => Date;

    /**
     * Produces a random number in `[0, 1)`, used to apply jitter to retry
     * backoff. It is injectable so tests can make backoff timing deterministic.
     */
    private readonly randomNumberGenerator: () => number;

    /**
     * The middleware applied to every step this engine runs, outermost first.
     * A step's own middleware is composed inside these, so engine-wide concerns
     * such as logging or metrics wrap every execution.
     */
    private readonly engineMiddleware: StepMiddleware[];

    /**
     * Serializes a value into the binary buffer that storage persists. It is
     * derived at construction from either a serialization registry or an
     * explicit codec, and must be the inverse of {@link WorkflowEngine.decode}.
     */
    private readonly encode: (value: unknown) => Buffer;

    /**
     * Deserializes a persisted buffer back into its value. It is the inverse of
     * {@link WorkflowEngine.encode} and is configured from the same source.
     */
    private readonly decode: (raw: Buffer) => unknown;

    /**
     * Generates a UUID for {@link WorkflowContext.randomUUID}. It is injectable
     * so tests can make generated identifiers deterministic.
     */
    private readonly uuid: () => string;

    /**
     * Reports a secondary error that the engine deliberately swallowed to
     * preserve a more meaningful primary one, such as a failure while recording
     * a workflow's terminal state or while releasing a lease on shutdown.
     * Defaults to a no-op when no handler is supplied.
     */
    private readonly onRecordingError: (workflowId: string, error: unknown) => void;

    /**
     * Whether to check at run time that every value about to be persisted is
     * serializable. It trades a small traversal cost for catching a
     * non-serializable value at its point of use rather than on a later resume.
     */
    private readonly validateSerializable: boolean;

    /**
     * The registered workflow definitions, keyed by name. A functional
     * definition is added directly, and a decorated class is adapted into one
     * before being stored here, so both authoring styles resolve through the
     * same map.
     */
    private readonly definitions = new Map<string, WorkflowFunction<any, any>>();

    /**
     * Steps whose lease this engine currently holds, keyed by
     * `workflowId\u0000stepKey` with the fence token from the claim. Used by
     * {@link WorkflowEngine.releaseInFlightSteps} to relinquish leases on a
     * graceful shutdown so other workers can take over immediately.
     */
    private readonly inFlightLeases = new Map<string, InFlightLease>();

    public constructor(storage: StorageAdapter, options: WorkflowEngineOptions = {}) {
        this.storage = storage;
        this.defaultLeaseMilliseconds =
            options.defaultLeaseMilliseconds ?? WorkflowEngine.DEFAULT_LEASE_MILLISECONDS;
        this.now = options.now ?? (() => new Date());
        this.randomNumberGenerator = options.randomNumberGenerator ?? Math.random;
        this.engineMiddleware = options.middleware ?? [];
        if (options.serialization && (options.encode || options.decode)) {
            throw new Error(
                "Provide either a `serialization` registry or `encode`/`decode`, not both: they configure the same serialization slot.",
            );
        }
        if (options.serialization) {
            const registry = options.serialization;
            this.encode = (value) => registry.encode(value);
            this.decode = (raw) => registry.decode(raw);
        } else {
            this.encode =
                options.encode ?? ((value) => Buffer.from(JSON.stringify(value ?? null), "utf8"));
            this.decode = options.decode ?? ((raw) => JSON.parse(raw.toString("utf8")));
        }
        this.uuid = options.uuid ?? WorkflowIdentifier.generateUuid;
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
            SerializationValidator.assertSerializable(value, description);
        }
        return this.encode(value);
    }

    /**
     * Registers a named workflow definition. Registering the same name twice is
     * an error, because a stable name is part of the workflow's persisted
     * identity.
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
     * identifier. Completed steps are memoized, so resuming re-runs only the
     * work that has not yet committed.
     *
     * The workflow to run may be identified in three interchangeable ways:
     *
     * - by the string name of a definition previously registered with
     *   {@link WorkflowEngine.defineWorkflow};
     * - by a class annotated with {@link Workflow}; or
     * - by an already-constructed instance of such a class, which is convenient
     *   when the workflow needs injected dependencies.
     *
     * In every case the workflow identifier is an explicit, stable string (such
     * as an order id). It is what lets the engine recognise the same run across
     * restarts and memoise completed steps.
     */
    public run<TInput extends SerializableInput, TOutput extends SerializableInput>(
        name: string,
        workflowId: string,
        input: TInput,
    ): Promise<TOutput>;
    public run<TInput extends SerializableInput, TOutput extends SerializableInput>(
        workflowClassOrInstance: Constructor | object,
        workflowId: string,
        input: TInput,
    ): Promise<TOutput>;
    public async run<TInput extends SerializableInput, TOutput extends SerializableInput>(
        nameOrClassOrInstance: string | Constructor | object,
        workflowId: string,
        input: TInput,
    ): Promise<TOutput> {
        const { name, workflowFunction } = this.resolveWorkflow<TInput, TOutput>(
            nameOrClassOrInstance,
        );
        return this.executeWorkflow({ name, workflowId, input, workflowFunction });
    }

    /**
     * Resolves a workflow reference — a registered name, an `@Workflow` class,
     * or an instance — into the definition name and functional body the engine
     * runs. Shared by {@link WorkflowEngine.run} and by child-workflow
     * dispatch.
     */
    private resolveWorkflow<TInput extends SerializableInput, TOutput extends SerializableInput>(
        nameOrClassOrInstance: string | Constructor | object,
    ): ResolvedWorkflow<TInput, TOutput> {
        /*
         * Dispatch on the shape of the argument. A string selects a registered
         * functional definition; anything else is a decorator-based
         * class/instance.
         */
        if (typeof nameOrClassOrInstance === "string") {
            const workflowFunction = this.definitions.get(nameOrClassOrInstance) as
                WorkflowFunction<TInput, TOutput> | undefined;
            if (!workflowFunction) {
                throw new Error(`Workflow "${nameOrClassOrInstance}" is not defined.`);
            }
            return { name: nameOrClassOrInstance, workflowFunction };
        }
        return WorkflowClassAdapter.buildWorkflowFromClass<TInput, TOutput>(nameOrClassOrInstance);
    }

    /**
     * The shared execution core used by every {@link WorkflowEngine.run}
     * overload. It persists the workflow record, invokes the workflow function
     * against a fresh context, and records the terminal outcome.
     */
    private async executeWorkflow<
        TInput extends SerializableInput,
        TOutput extends SerializableInput,
    >(execution: WorkflowExecution<TInput, TOutput>): Promise<TOutput> {
        const { name, workflowId, input, workflowFunction } = execution;
        const parentWorkflowId = execution.parentWorkflowId ?? null;

        await this.storage.ensureWorkflow(
            workflowId,
            name,
            this.encodeForPersistence(input, `input of workflow "${name}"`),
            parentWorkflowId,
        );

        /*
         * A cancelled workflow is terminal and must not be resumed; refuse
         * rather than silently running it.
         *
         * A completed workflow, by contrast, is deliberately allowed to run
         * again, for three reasons:
         *
         * 1. Idempotent redelivery: callers are typically queue consumers that
         *    may deliver the same message more than once. Re-running a completed
         *    workflow must be a safe no-op rather than an error, so a duplicate
         *    delivery does not blow up the consumer.
         * 2. Cheap by construction: every step's result is memoised, so a re-run
         *    replays completed steps from storage rather than re-executing their
         *    side effects. It walks the body and returns the same output.
         * 3. Result revalidation: a step may opt into a result TTL, and a re-run
         *    is precisely what lets the engine notice a stale memoised result and
         *    surface it, rather than silently returning an expired value.
         *
         * So completion is not treated as a hard stop; only cancellation is.
         */
        const existing = await this.storage.getWorkflow(workflowId);
        if (existing && existing.status === WorkflowStatus.CANCELLED) {
            throw new WorkflowCancelledError(workflowId);
        }

        await this.storage.setWorkflowStatus(workflowId, WorkflowStatus.RUNNING);

        const context = this.createWorkflowContext(workflowId);
        try {
            const output = await workflowFunction(context, input);
            await this.storage.setWorkflowStatus(workflowId, WorkflowStatus.COMPLETED, {
                output: this.encodeForPersistence(output, `output of workflow "${name}"`),
            });
            await this.storage.logEvent(workflowId, null, EventType.WORKFLOW_COMPLETED, {});
            return output;
        } catch (error) {
            /*
             * A durable sleep that is not yet due unwinds the run to suspend it.
             * This is not a failure: the workflow is parked as SUSPENDED, and the
             * scheduler resumes it once the sleep timer becomes due. We record the
             * state and re-throw so the caller (for example, a queue consumer)
             * knows this run did not complete and should not be treated as done.
             */
            if (error instanceof WorkflowSuspendedError) {
                try {
                    await this.storage.setWorkflowStatus(
                        workflowId,
                        WorkflowStatus.SUSPENDED,
                    );
                } catch (recordingError) {
                    this.onRecordingError(workflowId, recordingError);
                }
                throw error;
            }

            /*
             * The workflow body threw, and this is where every non-suspend
             * failure converges. There is no error handling inside executeStep or
             * handleStepFailure: a failed step throws (StepExhaustedError to
             * trigger a later retry, StepNeedsReviewError when parked, or the raw
             * error for a non-serializable result), that throw unwinds the
             * workflow body, and it lands here. So a step-level storage failure
             * (for example a failing failStep or logEvent inside
             * handleStepFailure) also propagates here as the caught `error`
             * rather than being swallowed at the step layer.
             *
             * We attempt to record the failure durably and then re-throw the
             * original error so the caller (typically a queue consumer) can decide
             * whether to redeliver.
             *
             * Behaviour when the failure-recording calls themselves throw:
             * `ErrorChain.describe`, `setWorkflowStatus`, and `logEvent` are
             * performed on a best-effort basis inside their own try/catch. If
             * the storage backend is unreachable, persisting the FAILED status or
             * the audit event may fail.
             *
             * We deliberately swallow such secondary errors so that the original,
             * more meaningful error is the one propagated to the caller; masking
             * it with a storage error would obscure the true cause.
             *
             * The workflow simply remains in the RUNNING state in that case and
             * will be retried on the next resume, which is safe because steps are
             * idempotent. That swallowed secondary error is the one and only value
             * routed to onRecordingError, which exists precisely to surface these
             * otherwise-invisible recording failures so operators are not left
             * blind.
             */
            try {
                const message = ErrorChain.describe(error);
                await this.storage.setWorkflowStatus(workflowId, WorkflowStatus.FAILED, {
                    error: message,
                });
                await this.storage.logEvent(workflowId, null, EventType.WORKFLOW_FAILED, {
                    error: message,
                });
            } catch (recordingError) {
                this.onRecordingError(workflowId, recordingError);
            }
            throw error;
        }
    }

    /**
     * Builds the durable primitives exposed to a workflow body.
     */
    private createWorkflowContext(workflowId: string): WorkflowContext {
        return {
            workflowId,
            step: <TResult extends Serializable>(
                stepKey: string,
                stepFunction: (context: StepContext) => Promise<TResult>,
                options?: StepOptions<TResult>,
            ) => this.executeStep({ workflowId, stepKey, stepFunction, options: options ?? {} }),

            sleep: (timerKey: string, durationMilliseconds: number) =>
                this.performDurableSleep(workflowId, timerKey, durationMilliseconds),

            now: (key: string) =>
                /* Recorded as a durable step so every resume observes the same instant. */
                this.executeStep({
                    workflowId,
                    stepKey: `$now:${key}`,
                    stepFunction: async () => this.now().getTime(),
                    options: {},
                }),

            randomUUID: (key: string) =>
                /* Recorded as a durable step so every resume observes the same id. */
                this.executeStep({
                    workflowId,
                    stepKey: `$uuid:${key}`,
                    stepFunction: async () => this.uuid(),
                    options: {},
                }),
            
            child: <TInput extends SerializableInput, TOutput extends SerializableInput>(
                childKey: string,
                nameOrClass: string | Constructor | object,
                input: TInput,
                options?: ChildWorkflowOptions,
            ) =>
                this.startChildWorkflow<TInput, TOutput>({
                    parentWorkflowId: workflowId,
                    childKey,
                    nameOrClass,
                    input,
                    options,
                }),
            
            childWithResult: async <TInput extends SerializableInput, TOutput extends SerializableInput>(
                childKey: string,
                nameOrClass: string | Constructor | object,
                input: TInput,
                options?: ChildWorkflowOptions,
            ) => {
                const handle = await this.startChildWorkflow<TInput, TOutput>({
                    parentWorkflowId: workflowId,
                    childKey,
                    nameOrClass,
                    input,
                    options,
                });
                return handle.result();
            },
        };
    }

    /**
     * Starts (or resumes) a child workflow from within a parent and returns a
     * handle to it. The child's identifier is either the one supplied in
     * `options` or a deterministic derivation from the parent identifier and
     * the child key, which is what makes a resume of the parent address the
     * same child rather than starting a new one.
     *
     * The parent/child link is recorded on the child's workflow record and an
     * audit event is emitted, so the relationship is observable. The child runs
     * through the ordinary {@link WorkflowEngine.executeWorkflow} path, so it is
     * durable, memoised, and recoverable in its own right.
     */
    private async startChildWorkflow<
        TInput extends SerializableInput,
        TOutput extends SerializableInput,
    >(start: ChildWorkflowStart<TInput>): Promise<ChildWorkflowHandle<TOutput>> {
        const { parentWorkflowId, childKey, nameOrClass, input, options } = start;
        const { name, workflowFunction } = this.resolveWorkflow<TInput, TOutput>(nameOrClass);
        const childId =
            options?.workflowId ??
            WorkflowIdentifier.composeChildWorkflowId(parentWorkflowId, childKey);

        await this.storage.logEvent(
            parentWorkflowId,
            null,
            EventType.CHILD_WORKFLOW_STARTED,
            {
                childKey,
                childWorkflowId: childId,
                workflowName: name,
            },
        );

        const engine = this;
        return {
            workflowId: childId,
            async result(): Promise<TOutput> {
                const output = await engine.executeWorkflow<TInput, TOutput>({
                    name,
                    workflowId: childId,
                    input,
                    workflowFunction,
                    parentWorkflowId,
                });
                await engine.storage.logEvent(
                    parentWorkflowId,
                    null,
                    EventType.CHILD_WORKFLOW_COMPLETED,
                    { childKey, childWorkflowId: childId },
                );
                return output;
            },
        };
    }

    /**
     * Performs a durable sleep. The timer is recorded exactly once for the
     * given key, so this is idempotent across resumes. If the due time has not
     * yet arrived, the workflow is suspended (by throwing
     * {@link WorkflowSuspendedError}, which the run loop turns into a
     * `SUSPENDED` state) and the scheduler resumes it later. If the due time
     * has passed, the sleep returns and execution continues past it.
     */
    private async performDurableSleep(
        workflowId: string,
        timerKey: string,
        durationMilliseconds: number,
    ): Promise<void> {
        const runAt = addMilliseconds(this.now(), durationMilliseconds);
        /*
         * Idempotent: the first call fixes the due time; later calls (on resume)
         * return the existing due time rather than sliding it forward.
         */
        const timer = await this.storage.ensureSleepTimer(workflowId, timerKey, runAt);

        if (isAfter(timer.runAt, this.now())) {
            /* Not due yet. Suspend the workflow until the scheduler resumes it. */
            await this.storage.logEvent(workflowId, timerKey, EventType.TIMER_SCHEDULED, {
                runAt: timer.runAt.toISOString(),
            });
            throw new WorkflowSuspendedError(workflowId, timerKey, timer.runAt);
        }
        /* The due time has passed; the sleep is over and execution continues. */
    }

    /**
     * Executes a single durable step following the check-execute-commit cycle,
     * with ambiguous-state resolution performed before any re-execution.
     */
    private async executeStep<TResult extends Serializable>(
        step: StepExecution<TResult>,
    ): Promise<TResult> {
        const { workflowId, stepKey, stepFunction, options } = step;
        const maxAttempts = options.maxAttempts ?? 1;
        const leaseMilliseconds = options.leaseMilliseconds ?? this.defaultLeaseMilliseconds;
        const backoffPolicy = options.backoff ?? BackoffCalculator.DEFAULT_BACKOFF_POLICY;
        const classifyError = options.classifyError ?? ((): FailureKind => FailureKind.DEFINITE);

        const claim = await this.storage.claimStep(
            workflowId,
            stepKey,
            maxAttempts,
            leaseMilliseconds,
        );

        /*
         * The step is already terminal; return the memoized output without
         * running, unless the step opted into result expiry and the saved result
         * is stale.
         */
        if (claim.cachedResult) {
            const previousResult = this.decodeOutput<TResult>(claim.cachedResult.output);
            await this.assertResultStillFresh({
                workflowId,
                stepKey,
                options,
                previousResult,
                completedAt: claim.cachedResult.completedAt,
            });
            return previousResult;
        }

        /*
         * Another worker holds a live lease; treat this as a transient condition
         * so the workflow is resumed later rather than proceeding without the
         * result.
         */
        if (!claim.claimed) {
            throw new StepExhaustedError(
                workflowId,
                stepKey,
                claim.attempt,
                "the step is currently leased by another worker",
            );
        }

        const context: StepContext = {
            workflowId,
            stepKey,
            attempt: claim.attempt,
        };

        /*
         * Ambiguous-state resolution: probe before executing to avoid
         * duplicating a side effect that may already have happened.
         */
        if (claim.priorStatus === StepStatus.AMBIGUOUS) {
            const resolution = await this.resolveAmbiguousStep(context, claim.fenceToken, options);
            if (resolution.resolved) {
                return resolution.value as TResult;
            }
            /* The probe reported the effect did not happen, so fall through and run. */
        }

        await this.storage.logEvent(workflowId, stepKey, EventType.STEP_STARTED, {
            attempt: claim.attempt,
        });

        /*
         * Track this lease while the step runs, so a graceful shutdown can
         * release it promptly rather than leaving it to expire.
         */
        const leaseKey = `${workflowId}\u0000${stepKey}`;
        this.inFlightLeases.set(leaseKey, {
            workflowId,
            stepKey,
            fenceToken: claim.fenceToken,
        });

        try {
            const combinedMiddleware = [...this.engineMiddleware, ...(options.middleware ?? [])];
            const result = await MiddlewarePipeline.run<TResult>(combinedMiddleware, context, () =>
                stepFunction(context),
            );

            const committed = await this.storage.commitStep(
                workflowId,
                stepKey,
                claim.fenceToken,
                this.encodeForPersistence(result, `result of step "${stepKey}"`),
                StepStatus.COMPLETED,
            );
            if (!committed) {
                /* A newer claim superseded this one; return the authoritative result. */
                return await this.readCommittedResult<TResult>(workflowId, stepKey);
            }

            await this.storage.logEvent(workflowId, stepKey, EventType.STEP_COMPLETED, {
                attempt: claim.attempt,
            });
            return result;
        } catch (error) {
            /*
             * A non-serializable result is a programming error, not a transient
             * failure of the step's work. Propagate it directly rather than
             * treating it as a failed attempt to retry, so the developer sees the
             * real problem. Like every throw from this method, it unwinds the
             * workflow body and is caught and recorded by executeWorkflow.
             */
            if (error instanceof NonSerializableValueError) {
                throw error;
            }
            /*
             * Apply the failure policy. handleStepFailure never returns normally
             * except for the optional-step fallback; in every other case it
             * throws (a retry/ambiguous/terminal signal, or a storage error while
             * recording the outcome), and that throw propagates out of executeStep
             * to executeWorkflow's catch above.
             */
            return await this.handleStepFailure({
                context,
                fenceToken: claim.fenceToken,
                maxAttempts,
                backoffPolicy,
                classifyError,
                options,
                error,
            });
        } finally {
            /*
             * The step has finished one way or another (committed, failed, or
             * threw), so its lease is no longer in flight and must not be released
             * later.
             */
            this.inFlightLeases.delete(leaseKey);
        }
    }

    /**
     * Releases the lease on a specific step, making it immediately claimable by
     * another worker. This delegates to the storage adapter and is guarded by
     * the fence token, so only the current holder can release it.
     *
     * @returns `true` if the lease was released, `false` if the token was
     *   stale.
     */
    public releaseStep(
        workflowId: string,
        stepKey: string,
        fenceToken: number,
    ): Promise<boolean> {
        return this.storage.releaseStep(workflowId, stepKey, fenceToken);
    }

    /**
     * Releases every lease this engine currently holds for in-flight steps.
     *
     * Call this during a graceful shutdown, after you have stopped accepting
     * new work, so that steps interrupted by the shutdown become immediately
     * claimable by another worker instead of waiting for their leases to
     * expire. Releases are attempted for all tracked leases even if some fail.
     */
    public async releaseInFlightSteps(): Promise<void> {
        const leases = [...this.inFlightLeases.values()];
        this.inFlightLeases.clear();
        await Promise.all(
            leases.map((lease) =>
                this.storage
                    .releaseStep(lease.workflowId, lease.stepKey, lease.fenceToken)
                    .catch((error) => this.onRecordingError(lease.workflowId, error)),
            ),
        );
    }

    /*
     * ---------------------------------------------------------------------------
     * Workflow lifecycle management API
     *
     * These read-and-control operations sit alongside `run`. They let an operator
     * (or a dashboard, or reconciliation code) observe and steer stored workflow
     * executions without re-running them.
     * ---------------------------------------------------------------------------
     */

    /**
     * Returns the current lifecycle status of a workflow, or `null` when no
     * workflow with the given identifier exists.
     */
    public async getWorkflowStatus(workflowId: string): Promise<WorkflowStatus | null> {
        const workflow = await this.storage.getWorkflow(workflowId);
        return workflow ? workflow.status : null;
    }

    /**
     * Returns a decoded snapshot of a workflow execution — its status, decoded
     * input and output, error, timings, and parent link — or `null` when it
     * does not exist. This is the general-purpose inspection call behind
     * dashboards and status endpoints.
     */
    public async describeWorkflow<
        TInput extends SerializableInput = SerializableInput,
        TOutput extends SerializableInput = SerializableInput,
    >(workflowId: string): Promise<WorkflowDescription<TInput, TOutput> | null> {
        const workflow = await this.storage.getWorkflow(workflowId);
        return workflow ? this.describe<TInput, TOutput>(workflow) : null;
    }

    /**
     * Returns the decoded output of a completed workflow.
     *
     * When the workflow has not completed, the behaviour depends on
     * `options.throwIfNotComplete`: by default this returns `null` (the
     * workflow is still running, suspended, or failed and has no output yet);
     * set the flag to throw instead, which is convenient when you expect
     * completion. A failed workflow's recorded error is surfaced as a thrown
     * error when the flag is set.
     */
    public async getWorkflowResult<TOutput extends SerializableInput = SerializableInput>(
        workflowId: string,
        options: GetWorkflowResultOptions = {},
    ): Promise<TOutput | null> {
        const workflow = await this.storage.getWorkflow(workflowId);
        if (!workflow) {
            if (options.throwIfNotComplete) {
                throw new Error(`Workflow "${workflowId}" does not exist.`);
            }
            return null;
        }
        if (workflow.status === WorkflowStatus.COMPLETED) {
            return (workflow.output === null ? null : this.decode(workflow.output)) as TOutput;
        }
        if (options.throwIfNotComplete) {
            if (workflow.status === WorkflowStatus.FAILED) {
                throw new Error(
                    `Workflow "${workflowId}" failed: ${workflow.error ?? "unknown error"}`,
                );
            }
            throw new Error(
                `Workflow "${workflowId}" has not completed (status: ${workflow.status}).`,
            );
        }
        return null;
    }

    /**
     * Lists workflow executions matching a filter, most recently updated first.
     * Backs listing views, reconciliation jobs, and "show me the children of X"
     * queries (via {@link WorkflowFilter.parentWorkflowId}).
     */
    public async listWorkflows<
        TInput extends SerializableInput = SerializableInput,
        TOutput extends SerializableInput = SerializableInput,
    >(filter: WorkflowFilter = {}): Promise<WorkflowDescription<TInput, TOutput>[]> {
        const workflows = await this.storage.listWorkflows(filter);
        return workflows.map((workflow) => this.describe<TInput, TOutput>(workflow));
    }

    /**
     * Cancels a workflow, moving it to the terminal `CANCELLED` state so it is
     * not resumed again. Cancelling a workflow that is already in a terminal
     * state (completed, failed, or cancelled) is a no-op and returns `false`; a
     * successful cancellation returns `true`.
     *
     * Cancellation is cooperative at the boundary: it prevents future resumes
     * but does not interrupt a step executing in another process right now.
     * That step finishes and commits under its lease; the workflow simply is
     * not resumed past it.
     */
    public async cancelWorkflow(workflowId: string): Promise<boolean> {
        const workflow = await this.storage.getWorkflow(workflowId);
        if (!workflow) {
            return false;
        }
        if (
            workflow.status === WorkflowStatus.COMPLETED ||
            workflow.status === WorkflowStatus.FAILED ||
            workflow.status === WorkflowStatus.CANCELLED
        ) {
            return false;
        }
        await this.storage.setWorkflowStatus(workflowId, WorkflowStatus.CANCELLED);
        await this.storage.logEvent(workflowId, null, EventType.WORKFLOW_CANCELLED, {});
        return true;
    }

    /**
     * Decodes a stored workflow record into a public
     * {@link WorkflowDescription}.
     */
    private describe<TInput extends SerializableInput, TOutput extends SerializableInput>(
        workflow: Workflow,
    ): WorkflowDescription<TInput, TOutput> {
        return {
            workflowId: workflow.workflowId,
            workflowName: workflow.workflowName,
            parentWorkflowId: workflow.parentWorkflowId,
            status: workflow.status,
            input: workflow.input === null ? null : (this.decode(workflow.input) as TInput),
            output: workflow.output === null ? null : (this.decode(workflow.output) as TOutput),
            error: workflow.error,
            createdAt: workflow.createdAt,
            updatedAt: workflow.updatedAt,
        };
    }

    /**
     * Attempts to resolve an ambiguous step by probing the downstream system. A
     * non-null probe result marks the step complete and skips execution; a null
     * result allows execution to proceed. When no probe is available the step
     * is parked for manual review.
     */
    private async resolveAmbiguousStep<TResult extends Serializable>(
        context: StepContext,
        fenceToken: number,
        options: StepOptions<TResult>,
    ): Promise<AmbiguousStepResolution<TResult>> {
        if (!options.probe) {
            await this.storage.failStep(
                context.workflowId,
                context.stepKey,
                fenceToken,
                "ambiguous outcome with no probe available",
                StepStatus.NEEDS_REVIEW,
                null,
            );
            await this.storage.logEvent(
                context.workflowId,
                context.stepKey,
                EventType.STEP_NEEDS_REVIEW,
                {},
            );
            throw new StepNeedsReviewError(context.workflowId, context.stepKey);
        }

        await this.storage.logEvent(
            context.workflowId,
            context.stepKey,
            EventType.STEP_PROBE_STARTED,
            { attempt: context.attempt },
        );
        const probedValue = await options.probe(context);

        if (probedValue !== null && probedValue !== undefined) {
            await this.storage.commitStep(
                context.workflowId,
                context.stepKey,
                fenceToken,
                this.encodeForPersistence(probedValue, `probe result of step "${context.stepKey}"`),
                StepStatus.COMPLETED,
            );
            await this.storage.logEvent(
                context.workflowId,
                context.stepKey,
                EventType.STEP_PROBE_RESOLVED,
                {},
            );
            return { resolved: true, value: probedValue };
        }

        await this.storage.logEvent(
            context.workflowId,
            context.stepKey,
            EventType.STEP_PROBE_EMPTY,
            {},
        );
        return { resolved: false };
    }

    /**
     * Applies the failure policy: retry, ambiguous parking, optional fallback,
     * or terminal failure.
     */
    private async handleStepFailure<TResult extends Serializable>(
        failure: StepFailure<TResult>,
    ): Promise<TResult> {
        const { context, fenceToken, maxAttempts, backoffPolicy, classifyError, options, error } =
            failure;
        const attempt = context.attempt;
        const message = ErrorChain.describe(error);
        const failureKind = classifyError(error);
        const hasAttemptsRemaining = attempt < maxAttempts;

        /* Ambiguous failure: record the ambiguous status so recovery probes next time. */
        if (failureKind === FailureKind.AMBIGUOUS) {
            const retryAt = hasAttemptsRemaining
                ? addMilliseconds(
                      this.now(),
                      BackoffCalculator.computeBackoffMilliseconds(
                          backoffPolicy,
                          attempt,
                          this.randomNumberGenerator,
                      ),
                  )
                : null;
            await this.storage.failStep(
                context.workflowId,
                context.stepKey,
                fenceToken,
                message,
                StepStatus.AMBIGUOUS,
                retryAt,
            );
            await this.storage.logEvent(
                context.workflowId,
                context.stepKey,
                EventType.STEP_AMBIGUOUS,
                { attempt, retryAt: retryAt ? retryAt.toISOString() : null },
            );
            if (hasAttemptsRemaining) {
                throw new StepExhaustedError(
                    context.workflowId,
                    context.stepKey,
                    attempt,
                    message,
                );
            }
            /* Without remaining attempts only a probe on the next resume can resolve it. */
            throw new StepNeedsReviewError(context.workflowId, context.stepKey);
        }

        /* Definite failure with attempts remaining: schedule a retry. */
        if (hasAttemptsRemaining) {
            const retryAt = addMilliseconds(
                this.now(),
                BackoffCalculator.computeBackoffMilliseconds(
                    backoffPolicy,
                    attempt,
                    this.randomNumberGenerator,
                ),
            );
            await this.storage.failStep(
                context.workflowId,
                context.stepKey,
                fenceToken,
                message,
                StepStatus.FAILED,
                retryAt,
            );
            await this.storage.logEvent(
                context.workflowId,
                context.stepKey,
                EventType.STEP_RETRY_SCHEDULED,
                { attempt, retryAt: retryAt.toISOString() },
            );
            throw new StepExhaustedError(
                context.workflowId,
                context.stepKey,
                attempt,
                message,
            );
        }

        /* Terminal failure of an optional step: continue with the fallback value. */
        if (options.optional) {
            const fallbackValue = (options.fallbackValue ?? null) as TResult;
            await this.storage.failStep(
                context.workflowId,
                context.stepKey,
                fenceToken,
                message,
                StepStatus.FAILED_OPTIONAL,
                null,
            );
            await this.storage.logEvent(
                context.workflowId,
                context.stepKey,
                EventType.STEP_OPTIONAL_FAILED,
                { attempt, error: message },
            );
            return fallbackValue;
        }

        /* Terminal failure of a mandatory step: fail the workflow. */
        await this.storage.failStep(
            context.workflowId,
            context.stepKey,
            fenceToken,
            message,
            StepStatus.FAILED,
            null,
        );
        await this.storage.logEvent(
            context.workflowId,
            context.stepKey,
            EventType.STEP_FAILED,
            {
                attempt,
                error: message,
            },
        );
        throw new StepExhaustedError(context.workflowId, context.stepKey, attempt, message);
    }

    /**
     * Enforces an opt-in freshness policy for a memoized step result. If the
     * step declared `resultTtlMilliseconds` or `revalidate` and the saved
     * result is stale, this raises {@link StepResultExpiredError}. Steps that
     * opted into neither are always considered fresh, preserving the default
     * guarantee that a completed step is final and never re-run.
     */
    private async assertResultStillFresh<TResult extends Serializable>(
        memoized: MemoizedStepResult<TResult>,
    ): Promise<void> {
        const { workflowId, stepKey, options, previousResult, completedAt } = memoized;
        if (options.resultTtlMilliseconds !== undefined && completedAt !== null) {
            const expiresAt = addMilliseconds(completedAt, options.resultTtlMilliseconds);
            if (isAfter(this.now(), expiresAt)) {
                throw new StepResultExpiredError(workflowId, stepKey);
            }
        }

        if (options.revalidate) {
            const stillValid = await options.revalidate(previousResult);
            if (!stillValid) {
                throw new StepResultExpiredError(workflowId, stepKey);
            }
        }
    }

    /**
     * Re-reads the authoritative committed result after losing a commit race.
     */
    private async readCommittedResult<TResult extends Serializable>(
        workflowId: string,
        stepKey: string,
    ): Promise<TResult> {
        const claim = await this.storage.claimStep(workflowId, stepKey, 1, 0);
        if (claim.cachedResult) {
            return this.decodeOutput<TResult>(claim.cachedResult.output);
        }
        throw new StepExhaustedError(
            workflowId,
            stepKey,
            claim.attempt,
            "lost the commit race and no committed result was available",
        );
    }

    /**
     * Decodes a persisted output buffer, treating a missing value as `null`.
     */
    private decodeOutput<TResult extends Serializable>(raw: Buffer | null): TResult {
        if (raw === null) {
            return null as TResult;
        }
        return this.decode(raw) as TResult;
    }

}
