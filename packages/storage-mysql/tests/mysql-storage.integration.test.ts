import {
  FailureKind,
  StepStatus,
  WorkflowEngine,
  WorkflowStatus,
  WorkflowSuspendedError,
} from "@outpost/core";
import mysql from "mysql2/promise";
import type { Pool } from "mysql2/promise";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { MysqlStorage } from "../src/storage/mysql-storage.js";

// These tests require a live MySQL instance. Connection details come from the
// environment so credentials are not hardcoded. Set OUTPOST_SKIP_DB=1 to skip.
const shouldSkip = process.env.OUTPOST_SKIP_DB === "1";
const host = process.env.OUTPOST_TEST_MYSQL_HOST ?? "127.0.0.1";
const port = Number(process.env.OUTPOST_TEST_MYSQL_PORT ?? "3306");
const user = process.env.OUTPOST_TEST_MYSQL_USER ?? "root";
const password = process.env.OUTPOST_TEST_MYSQL_PASSWORD ?? "";
const database = process.env.OUTPOST_TEST_MYSQL_DB ?? "outpostTest";

/** Classifies timeout and 5xx errors as ambiguous, as an HTTP wrapper would. */
function classifyHttpError(error: unknown): FailureKind {
  const message = error instanceof Error ? error.message : String(error);
  return /timeout|5\d\d/i.test(message) ? FailureKind.AMBIGUOUS : FailureKind.DEFINITE;
}

describe.skipIf(shouldSkip)("MysqlStorage integration", () => {
  let pool: Pool;
  let storage: MysqlStorage;

  beforeAll(async () => {
    pool = mysql.createPool({
      host,
      port,
      user,
      password,
      database,
      connectionLimit: 10,
      timezone: "Z",
    });
    storage = new MysqlStorage(pool);
    await storage.migrate();
  });

  afterAll(async () => {
    await pool.end();
  });

  beforeEach(async () => {
    await pool.query("DELETE FROM `outpostAuditEvents`");
    await pool.query("DELETE FROM `outpostSchedules`");
    await pool.query("DELETE FROM `outpostSteps`");
    await pool.query("DELETE FROM `outpostWorkflows`");
  });

  it("memoizes a committed step across resumes", async () => {
    const engine = new WorkflowEngine(storage);
    let executionCount = 0;
    engine.defineWorkflow<null, number>("memoized", async (context) =>
      context.step("step", async () => {
        executionCount += 1;
        return 99;
      }),
    );

    expect(await engine.run<null, number>("memoized", "workflow-memo", null)).toBe(99);
    expect(await engine.run<null, number>("memoized", "workflow-memo", null)).toBe(99);
    expect(executionCount).toBe(1);
  });

  it("grants exactly one claim under concurrent contention", async () => {
    await storage.ensureWorkflow("workflow-claim", "concurrent", null);
    const results = await Promise.all(
      Array.from({ length: 8 }, () => storage.claimStep("workflow-claim", "race", 1, 30_000)),
    );
    expect(results.filter((result) => result.claimed).length).toBe(1);
  });

  it("rejects a stale fence token from overwriting a newer owner's commit", async () => {
    await storage.ensureWorkflow("workflow-fence", "fencing", null);
    const first = await storage.claimStep("workflow-fence", "step", 3, 0);
    const second = await storage.claimStep("workflow-fence", "step", 3, 30_000);
    expect(second.claimed).toBe(true);
    expect(second.fenceToken).toBeGreaterThan(first.fenceToken);

    const staleCommit = await storage.commitStep(
      "workflow-fence",
      "step",
      first.fenceToken,
      Buffer.from(JSON.stringify("stale"), "utf8"),
      StepStatus.COMPLETED,
    );
    expect(staleCommit).toBe(false);

    const freshCommit = await storage.commitStep(
      "workflow-fence",
      "step",
      second.fenceToken,
      Buffer.from(JSON.stringify("fresh"), "utf8"),
      StepStatus.COMPLETED,
    );
    expect(freshCommit).toBe(true);
  });

  it("releaseStep clears the lease so the step is immediately claimable again", async () => {
    await storage.ensureWorkflow("workflow-release", "releasing", null);
    const claim = await storage.claimStep("workflow-release", "step", 1, 60_000);
    expect(claim.claimed).toBe(true);

    // A stale token cannot release the lease.
    expect(await storage.releaseStep("workflow-release", "step", claim.fenceToken + 1)).toBe(false);

    // The current holder releases it; another worker can then claim it at once,
    // well before the 60 second lease would have expired.
    expect(await storage.releaseStep("workflow-release", "step", claim.fenceToken)).toBe(true);
    const reclaim = await storage.claimStep("workflow-release", "step", 1, 60_000);
    expect(reclaim.claimed).toBe(true);
  });

  it("resolves a Shopify-style ambiguous failure through a probe without re-executing", async () => {
    const engine = new WorkflowEngine(storage, { randomNumberGenerator: () => 0 });
    let executionCount = 0;
    let sideEffectOccurred = false;

    engine.defineWorkflow<null, { orderIdentifier: string }>("shopify", async (context) =>
      context.step<{ orderIdentifier: string }>(
        "create-order",
        async () => {
          executionCount += 1;
          sideEffectOccurred = true;
          throw new Error("500 Internal Server Error");
        },
        {
          maxAttempts: 2,
          classifyError: classifyHttpError,
          probe: async () => (sideEffectOccurred ? { orderIdentifier: "SHOP-42" } : null),
        },
      ),
    );

    await expect(engine.run("shopify", "workflow-shopify", null)).rejects.toThrow();
    const [ambiguousRows] = await pool.query(
      "SELECT `status` FROM `outpostSteps` WHERE `workflowIdentifier` = ?",
      ["workflow-shopify"],
    );
    expect((ambiguousRows as Array<{ status: string }>)[0]!.status).toBe(StepStatus.AMBIGUOUS);

    const output = await engine.run<null, { orderIdentifier: string }>(
      "shopify",
      "workflow-shopify",
      null,
    );
    expect(output).toEqual({ orderIdentifier: "SHOP-42" });
    expect(executionCount).toBe(1);
  });

  it("suspends on a durable sleep and resumes once the timer is due", async () => {
    let afterSleepRan = false;
    const engine = new WorkflowEngine(storage);
    engine.defineWorkflow<null, string>("sleeper", async (context) => {
      await context.sleep("nap", 100); // 100 ms
      afterSleepRan = true;
      return "awake";
    });

    // First run suspends, because the sleep is not yet due.
    await expect(engine.run("sleeper", "workflow-sleep", null)).rejects.toBeInstanceOf(
      WorkflowSuspendedError,
    );
    expect(afterSleepRan).toBe(false);

    const workflow = await storage.getWorkflow("workflow-sleep");
    expect(workflow?.status).toBe(WorkflowStatus.SUSPENDED);

    // Wait for the sleep to become due, then resume. The workflow completes and
    // the code after the sleep runs exactly once.
    await new Promise((resolve) => setTimeout(resolve, 150));
    const result = await engine.run<null, string>("sleeper", "workflow-sleep", null);
    expect(result).toBe("awake");
    expect(afterSleepRan).toBe(true);
  });

  it("ensureSleepTimer creates the timer once and returns the same due time", async () => {
    await storage.ensureWorkflow("workflow-timer", "sleeper", null);
    const first = await storage.ensureSleepTimer("workflow-timer", "nap", new Date(Date.now() + 60_000));
    const second = await storage.ensureSleepTimer("workflow-timer", "nap", new Date(Date.now() + 999_000));
    // The second call must not slide the due time forward.
    expect(second.runAt.getTime()).toBe(first.runAt.getTime());
  });
});
