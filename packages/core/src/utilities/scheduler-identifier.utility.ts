/**
 * Identifier helpers used by the {@link Scheduler}: deterministic per-fire cron
 * workflow identifiers and per-process ownership identifiers.
 *
 * Grouped as static members so the scheduler's identifier schemes live together
 * and read as `SchedulerIdentifier.composeCronWorkflowId(...)`.
 */
export class SchedulerIdentifier {
    /**
     * Builds a deterministic workflow identifier for a cron fire from the
     * schedule name and the exact scheduled instant. Because the instant is part
     * of the key, dispatching the same occurrence twice resolves to the same
     * workflow execution, which the engine then memoises rather than running
     * again, giving exactly-once semantics per occurrence even across concurrent
     * schedulers.
     */
    static composeCronWorkflowId(name: string, scheduledFor: Date, suffix?: string): string {
        const base = `cron-${name}-${scheduledFor.toISOString()}`;
        return suffix ? `${base}-${suffix}` : base;
    }

    /**
     * Generates a per-process ownership id. Uses `crypto.randomUUID` when
     * available and falls back to a timestamp-plus-random string otherwise,
     * which is enough to distinguish processes for lease ownership.
     */
    static generateProcessId(): string {
        const cryptoObject = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
        if (cryptoObject?.randomUUID) {
            return `scheduler-${cryptoObject.randomUUID()}`;
        }
        return `scheduler-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
    }
}
