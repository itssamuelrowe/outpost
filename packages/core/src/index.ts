// Engine
export { WorkflowEngine } from "./engine/workflow-engine.js";
export type { WorkflowEngineOptions, WorkflowDescription } from "./engine/workflow-engine.js";

// Serialization recipe system
export { SerializationRegistry } from "./serialization/serialization-registry.js";
export type { SerializationRecipe } from "./serialization/serialization-registry.js";
export {
    dateRecipe,
    mapRecipe,
    setRecipe,
    bigintRecipe,
} from "./serialization/built-in-recipes.js";

// Storage adapters for consumer tests and examples
export { MemoryStorage } from "./storage/memory-storage.js";
export { JsonFileStorage } from "./storage/json-file-storage.js";

// Embedded scheduler
export { Scheduler } from "./scheduler/scheduler.js";
export type {
    SchedulerOptions,
    OwnershipOptions,
    OwnershipCapacity,
    DueTimerHandler,
    CronFireHandler,
    CronScheduleOptions,
    CronScheduleUpdate,
} from "./scheduler/scheduler.js";
export { CronWorkflowAdapter } from "./scheduler/cron-workflow-adapter.js";
export type { CronWorkflowRunner, CronWorkflowInput } from "./scheduler/cron-workflow-adapter.js";

// Cron utilities
export { CronUtility } from "./utilities/cron.utility.js";

// Decorator-based authoring
export { Workflow } from "./decorators/workflow.decorator.js";
export type { WorkflowDecoratorOptions } from "./decorators/workflow.decorator.js";
export { Step } from "./decorators/step.decorator.js";
export type { StepDecoratorOptions } from "./decorators/step.decorator.js";
export { Probe } from "./decorators/probe.decorator.js";
export { ClassifyError } from "./decorators/classify-error.decorator.js";
export { Cron } from "./decorators/cron.decorator.js";
export type { CronDecoratorOptions } from "./decorators/cron.decorator.js";

// Utilities
export { BackoffCalculator } from "./utilities/backoff.utility.js";
export { MiddlewarePipeline } from "./utilities/middleware-pipeline.utility.js";
export { SerializationValidator } from "./utilities/serialization.utility.js";
export { ErrorChain } from "./utilities/error-chain.utility.js";

// Errors
export {
    StepExhaustedError,
    StepNeedsReviewError,
    StepResultExpiredError,
    WorkflowCancelledError,
    WorkflowSuspendedError,
} from "./errors/durable-execution.error.js";
export { NonSerializableValueError } from "./errors/serialization.error.js";
export { InvalidCronExpressionError, InvalidTimeZoneError } from "./errors/cron.error.js";

// Enumerations
export { CronScheduleStatus } from "./enums/cron-schedule-status.enum.js";
export { EventType } from "./enums/event-type.enum.js";
export { FailureKind } from "./enums/failure-kind.enum.js";
export { ScheduleStatus } from "./enums/schedule-status.enum.js";
export { StepStatus } from "./enums/step-status.enum.js";
export { WorkflowStatus } from "./enums/workflow-status.enum.js";

// Entity interfaces. The Workflow and Step record types are exported under
// `*Record` aliases so they do not collide with the @Workflow and @Step
// decorators, which occupy the plain names in the public API.
export type { AuditEvent } from "./entities/audit-event.entity.js";
export type { ClaimResult } from "./entities/claim-result.entity.js";
export type { CronSchedule } from "./entities/cron-schedule.entity.js";
export type { DueCronSchedule } from "./entities/due-cron-schedule.entity.js";
export type { DueTimer } from "./entities/due-timer.entity.js";
export type { Schedule } from "./entities/schedule.entity.js";
export type { SleepTimer } from "./entities/sleep-timer.entity.js";
export type { Step as StepRecord } from "./entities/step.entity.js";
export type { Workflow as WorkflowRecord } from "./entities/workflow.entity.js";

// Contract interfaces
export type { BackoffPolicy } from "./interfaces/backoff-policy.interface.js";
export type { StepMiddleware } from "./interfaces/middleware.interface.js";
export type { ProbeFunction } from "./interfaces/probe-function.interface.js";
export type { Serializable, SerializableInput } from "./interfaces/serializable.interface.js";
export type { StepContext } from "./interfaces/step-context.interface.js";
export type { StepOptions } from "./interfaces/step-options.interface.js";
export type { StorageAdapter, WorkflowFilter } from "./interfaces/storage-adapter.interface.js";
export type {
    WorkflowContext,
    ChildWorkflowHandle,
    ChildWorkflowOptions,
} from "./interfaces/workflow-context.interface.js";
