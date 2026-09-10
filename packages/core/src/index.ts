// Engine
export { WorkflowEngine } from "./engine/workflow-engine.js";
export type { WorkflowEngineOptions } from "./engine/workflow-engine.js";

// In-memory storage for consumer tests
export { MemoryStorage } from "./storage/memory-storage.js";

// Embedded scheduler
export { Scheduler } from "./scheduler/scheduler.js";
export type { SchedulerOptions, DueTimerHandler } from "./scheduler/scheduler.js";

// Decorator-based authoring
export {
  Workflow,
  Step,
  Probe,
  ClassifyError,
} from "./decorators/workflow.decorator.js";
export type {
  WorkflowDecoratorOptions,
  StepDecoratorOptions,
} from "./decorators/workflow.decorator.js";

// Utilities
export {
  DEFAULT_BACKOFF_POLICY,
  computeBackoffMilliseconds,
} from "./utilities/backoff.utility.js";
export { runMiddlewarePipeline } from "./utilities/middleware-pipeline.utility.js";
export {
  assertSerializable,
  NonSerializableValueError,
} from "./utilities/serialization.utility.js";

// Errors
export {
  StepExhaustedError,
  StepNeedsReviewError,
  StepResultExpiredError,
  WorkflowSuspendedError,
} from "./errors/durable-execution.error.js";

// Enumerations
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
export type { Schedule } from "./entities/schedule.entity.js";
export type { Step as StepRecord } from "./entities/step.entity.js";
export type { Workflow as WorkflowRecord } from "./entities/workflow.entity.js";

// Contract interfaces
export type { BackoffPolicy } from "./interfaces/backoff-policy.interface.js";
export type { StepMiddleware } from "./interfaces/middleware.interface.js";
export type { ProbeFunction } from "./interfaces/probe-function.interface.js";
export type {
  Serializable,
  SerializableInput,
} from "./interfaces/serializable.interface.js";
export type { StepContext } from "./interfaces/step-context.interface.js";
export type { StepOptions } from "./interfaces/step-options.interface.js";
export type { StorageAdapter } from "./interfaces/storage-adapter.interface.js";
export type { WorkflowContext } from "./interfaces/workflow-context.interface.js";
