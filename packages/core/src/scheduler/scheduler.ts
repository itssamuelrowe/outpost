import type { StorageAdapter } from "../interfaces/storage-adapter.interface.js";

/**
 * Handles a single due timer by resuming the workflow it belongs to.
 *
 * The application supplies this callback because only it knows how to map a
 * workflow identifier back to a runnable workflow (for example, by calling
 * `engine.run(name, workflowIdentifier, input)`). Keeping the resume logic
 * outside the scheduler preserves the engine's independence from any particular
 * dispatch mechanism.
 */
export type DueTimerHandler = (timer: {
  scheduleIdentifier: number;
  workflowIdentifier: string;
  stepKey: string | null;
  payload: string | null;
}) => Promise<void>;

/** Configuration for a {@link Scheduler}. */
export interface SchedulerOptions {
  /** How often, in milliseconds, to poll for due timers. Defaults to one second. */
  pollIntervalMilliseconds?: number;
  /** The maximum number of timers to claim per poll. Defaults to fifty. */
  batchSize?: number;
  /** An injectable clock, provided so tests can control time. */
  now?: () => Date;
  /**
   * Invoked when handling a due timer throws. Because a timer is marked
   * processed when it is claimed, a handler failure is reported here rather than
   * propagated, so a single bad timer cannot halt the whole loop. Defaults to a
   * no-op.
   */
  onHandlerError?: (workflowIdentifier: string, error: unknown) => void;
}

/**
 * An embedded scheduler that periodically claims due timers and dispatches them.
 *
 * The scheduler is designed to run inside ordinary application processes, with
 * no separate daemon required. Multiple instances may run concurrently against
 * the same storage backend: the adapter's `claimDueTimers` operation claims each
 * timer atomically, so no timer is dispatched twice under normal locking
 * semantics.
 *
 * Timer volume is expected to be moderate; database polling is intentionally
 * simple and may need a different backend at very high scale.
 */
export class Scheduler {
  private readonly storage: StorageAdapter;
  private readonly pollIntervalMilliseconds: number;
  private readonly batchSize: number;
  private readonly now: () => Date;
  private readonly onHandlerError: (workflowIdentifier: string, error: unknown) => void;

  private running = false;
  private loopPromise: Promise<void> | null = null;

  public constructor(storage: StorageAdapter, options: SchedulerOptions = {}) {
    this.storage = storage;
    this.pollIntervalMilliseconds = options.pollIntervalMilliseconds ?? 1_000;
    this.batchSize = options.batchSize ?? 50;
    this.now = options.now ?? (() => new Date());
    this.onHandlerError = options.onHandlerError ?? (() => undefined);
  }

  /**
   * Starts the polling loop in the background. The loop continues until
   * {@link Scheduler.stop} is called. Calling `start` while already running is a
   * no-op.
   */
  public start(handler: DueTimerHandler): void {
    if (this.running) {
      return;
    }
    this.running = true;
    this.loopPromise = this.runLoop(handler);
  }

  /**
   * Stops the polling loop and waits for the current cycle to finish, so callers
   * can shut down cleanly.
   */
  public async stop(): Promise<void> {
    this.running = false;
    if (this.loopPromise) {
      await this.loopPromise;
      this.loopPromise = null;
    }
  }

  /** Runs poll cycles separated by the configured interval until stopped. */
  private async runLoop(handler: DueTimerHandler): Promise<void> {
    while (this.running) {
      await this.tick(handler);
      if (this.running) {
        await this.sleep(this.pollIntervalMilliseconds);
      }
    }
  }

  /**
   * Performs a single scheduler tick: claim a batch of due timers and dispatch
   * each to the handler. This is exposed publicly so tests can drive one tick
   * deterministically without running the unbounded loop.
   *
   * @returns The number of timers dispatched during this tick.
   */
  public async tick(handler: DueTimerHandler): Promise<number> {
    const dueTimers = await this.storage.claimDueTimers(this.now(), this.batchSize);

    for (const timer of dueTimers) {
      try {
        await handler(timer);
      } catch (error) {
        // The timer has already been marked processed by claimDueTimers. We
        // report the failure rather than rethrow it so that one failing timer
        // cannot stall the loop or block sibling timers in the same batch.
        this.onHandlerError(timer.workflowIdentifier, error);
      }
    }

    return dueTimers.length;
  }

  /** Pauses for the given number of milliseconds. */
  private sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
  }
}
