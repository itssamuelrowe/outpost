import { EventType, ScheduleStatus, StepStatus, WorkflowStatus } from "@outpost/core";
import type { ClaimResult, StorageAdapter, WorkflowRecord } from "@outpost/core";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

import { formatUtcDateTime } from "../utilities/datetime.utility.js";
import { loadSchemaStatements } from "../utilities/schema-loader.utility.js";

/**
 * Configuration for the MySQL storage adapter.
 */
export interface MysqlStorageOptions {
    /**
     * An injectable clock, provided so tests can control time.
     */
    now?: () => Date;
}

/**
 * A MySQL/InnoDB implementation of the {@link StorageAdapter} contract.
 *
 * Correctness rests on two mechanisms. First, step claiming uses `SELECT ...
 * FOR UPDATE SKIP LOCKED` inside a transaction, so concurrent workers cannot
 * both claim the same runnable step. Second, commits and failures are guarded
 * by a fence token, so a worker whose lease has expired and been taken over
 * cannot overwrite the newer owner's result.
 *
 * The pool passed to this adapter should be created with `timezone: "Z"` so
 * that `DATETIME` values round-trip in UTC and align with the clock the adapter
 * uses for formatting.
 */
export class MysqlStorage implements StorageAdapter {
    private readonly pool: Pool;
    private readonly now: () => Date;

    public constructor(pool: Pool, options: MysqlStorageOptions = {}) {
        this.pool = pool;
        this.now = options.now ?? (() => new Date());
    }

    /**
     * Creates the schema by executing the versioned `.sql` files shipped with
     * the package. Each statement uses `CREATE TABLE IF NOT EXISTS`, so calling
     * this repeatedly is safe.
     */
    public async migrate(): Promise<void> {
        const statements = await loadSchemaStatements();
        for (const statement of statements) {
            await this.pool.query(statement);
        }
    }

    /**
     * Runs the supplied function inside a transaction, committing or rolling
     * back.
     */
    private async withinTransaction<TResult>(
        operation: (connection: PoolConnection) => Promise<TResult>,
    ): Promise<TResult> {
        const connection = await this.pool.getConnection();
        try {
            await connection.beginTransaction();
            const result = await operation(connection);
            await connection.commit();
            return result;
        } catch (error) {
            await connection.rollback();
            throw error;
        } finally {
            connection.release();
        }
    }

    public async ensureWorkflow(
        workflowIdentifier: string,
        workflowName: string,
        input: Buffer | null,
    ): Promise<void> {
        const timestamp = formatUtcDateTime(this.now());
        await this.pool.query(
            `INSERT INTO \`outpostWorkflows\`
         (\`workflowIdentifier\`, \`workflowName\`, \`status\`, \`input\`, \`output\`, \`error\`, \`createdAt\`, \`updatedAt\`)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, ?)
       ON DUPLICATE KEY UPDATE \`workflowIdentifier\` = \`workflowIdentifier\``,
            [workflowIdentifier, workflowName, WorkflowStatus.RUNNING, input, timestamp, timestamp],
        );
    }

    public async setWorkflowStatus(
        workflowIdentifier: string,
        status: WorkflowStatus,
        fields?: { output?: Buffer | null; error?: string | null },
    ): Promise<void> {
        const timestamp = formatUtcDateTime(this.now());
        const assignments: string[] = ["`status` = ?", "`updatedAt` = ?"];
        const parameters: unknown[] = [status, timestamp];
        if (fields && "output" in fields) {
            assignments.push("`output` = ?");
            parameters.push(fields.output ?? null);
        }
        if (fields && "error" in fields) {
            assignments.push("`error` = ?");
            parameters.push(fields.error ?? null);
        }
        parameters.push(workflowIdentifier);
        await this.pool.query(
            `UPDATE \`outpostWorkflows\` SET ${assignments.join(", ")} WHERE \`workflowIdentifier\` = ?`,
            parameters,
        );
    }

    public async getWorkflow(workflowIdentifier: string): Promise<WorkflowRecord | null> {
        const [rows] = await this.pool.query<RowDataPacket[]>(
            "SELECT * FROM `outpostWorkflows` WHERE `workflowIdentifier` = ?",
            [workflowIdentifier],
        );
        const row = rows[0];
        if (!row) {
            return null;
        }
        return {
            workflowIdentifier: row.workflowIdentifier,
            workflowName: row.workflowName,
            status: row.status as WorkflowStatus,
            input: row.input,
            output: row.output,
            error: row.error,
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
        };
    }

    public async claimStep(
        workflowIdentifier: string,
        stepKey: string,
        maxAttempts: number,
        leaseMilliseconds: number,
    ): Promise<ClaimResult> {
        const currentInstant = this.now();
        const timestamp = formatUtcDateTime(currentInstant);
        const newLease = formatUtcDateTime(new Date(currentInstant.getTime() + leaseMilliseconds));

        return this.withinTransaction(async (connection) => {
            // Ensure the row exists so that it can be locked below.
            await connection.query(
                `INSERT INTO \`outpostSteps\`
           (\`workflowIdentifier\`, \`stepKey\`, \`status\`, \`attempts\`, \`maxAttempts\`, \`fenceToken\`, \`createdAt\`, \`updatedAt\`)
         VALUES (?, ?, ?, 0, ?, 0, ?, ?)
         ON DUPLICATE KEY UPDATE \`workflowIdentifier\` = \`workflowIdentifier\``,
                [
                    workflowIdentifier,
                    stepKey,
                    StepStatus.PENDING,
                    maxAttempts,
                    timestamp,
                    timestamp,
                ],
            );

            // Lock the row. SKIP LOCKED lets a concurrent claimer return immediately
            // rather than block, which is the behaviour we want for worker fan-out.
            const [rows] = await connection.query<RowDataPacket[]>(
                "SELECT * FROM `outpostSteps` WHERE `workflowIdentifier` = ? AND `stepKey` = ? FOR UPDATE SKIP LOCKED",
                [workflowIdentifier, stepKey],
            );
            const row = rows[0];
            if (!row) {
                // Another worker currently holds the row lock.
                return { claimed: false, attempt: 0, fenceToken: 0, priorStatus: null };
            }

            const status = row.status as StepStatus;

            if (status === StepStatus.COMPLETED || status === StepStatus.FAILED_OPTIONAL) {
                return {
                    claimed: false,
                    cachedResult: {
                        output: row.output ?? null,
                        completedAt: row.completedAt ? new Date(row.completedAt) : null,
                    },
                    attempt: row.attempts,
                    fenceToken: Number(row.fenceToken),
                    priorStatus: status,
                };
            }

            // Decide lease liveness using the database's own clock to avoid any skew
            // between the application and the database session timezone.
            if (status === StepStatus.RUNNING && row.lockedUntil !== null) {
                const [livenessRows] = await connection.query<RowDataPacket[]>(
                    "SELECT (`lockedUntil` > ?) AS live FROM `outpostSteps` WHERE `workflowIdentifier` = ? AND `stepKey` = ?",
                    [timestamp, workflowIdentifier, stepKey],
                );
                if (livenessRows[0]?.live === 1) {
                    return {
                        claimed: false,
                        attempt: row.attempts,
                        fenceToken: Number(row.fenceToken),
                        priorStatus: status,
                    };
                }
            }

            const attempt = row.attempts + 1;
            const fenceToken = Number(row.fenceToken) + 1;

            await connection.query(
                `UPDATE \`outpostSteps\`
           SET \`status\` = ?, \`attempts\` = ?, \`fenceToken\` = ?, \`lockedUntil\` = ?, \`updatedAt\` = ?
         WHERE \`workflowIdentifier\` = ? AND \`stepKey\` = ?`,
                [
                    StepStatus.RUNNING,
                    attempt,
                    fenceToken,
                    newLease,
                    timestamp,
                    workflowIdentifier,
                    stepKey,
                ],
            );

            return { claimed: true, attempt, fenceToken, priorStatus: status };
        });
    }

    public async commitStep(
        workflowIdentifier: string,
        stepKey: string,
        fenceToken: number,
        output: Buffer | null,
        status: StepStatus,
    ): Promise<boolean> {
        const timestamp = formatUtcDateTime(this.now());
        const [result] = await this.pool.query(
            `UPDATE \`outpostSteps\`
         SET \`status\` = ?, \`output\` = ?, \`lockedUntil\` = NULL, \`completedAt\` = ?, \`updatedAt\` = ?
       WHERE \`workflowIdentifier\` = ? AND \`stepKey\` = ? AND \`fenceToken\` = ?`,
            [status, output, timestamp, timestamp, workflowIdentifier, stepKey, fenceToken],
        );
        return (result as { affectedRows: number }).affectedRows > 0;
    }

    public async failStep(
        workflowIdentifier: string,
        stepKey: string,
        fenceToken: number,
        error: string,
        status: StepStatus,
        retryAt: Date | null,
    ): Promise<boolean> {
        const timestamp = formatUtcDateTime(this.now());
        // Preserve the ambiguous status across a scheduled retry so recovery probes;
        // otherwise a retryable definite failure returns to the pending state.
        const nextStatus: StepStatus = retryAt
            ? status === StepStatus.AMBIGUOUS
                ? StepStatus.AMBIGUOUS
                : StepStatus.PENDING
            : status;

        const [result] = await this.pool.query(
            `UPDATE \`outpostSteps\`
         SET \`status\` = ?, \`lastError\` = ?, \`lockedUntil\` = NULL, \`updatedAt\` = ?
       WHERE \`workflowIdentifier\` = ? AND \`stepKey\` = ? AND \`fenceToken\` = ?`,
            [nextStatus, error, timestamp, workflowIdentifier, stepKey, fenceToken],
        );
        const affected = (result as { affectedRows: number }).affectedRows > 0;

        if (affected && retryAt) {
            await this.scheduleTimer(workflowIdentifier, stepKey, retryAt, null);
        }
        return affected;
    }

    public async releaseStep(
        workflowIdentifier: string,
        stepKey: string,
        fenceToken: number,
    ): Promise<boolean> {
        const timestamp = formatUtcDateTime(this.now());
        // Clear the lease and return the step to PENDING, but only when this caller
        // still holds the current lease (matching fence token) and the step is
        // actually running. The attempt count is left untouched, so the next claim
        // simply resumes the step.
        const [result] = await this.pool.query(
            `UPDATE \`outpostSteps\`
         SET \`status\` = ?, \`lockedUntil\` = NULL, \`updatedAt\` = ?
       WHERE \`workflowIdentifier\` = ? AND \`stepKey\` = ? AND \`fenceToken\` = ? AND \`status\` = ?`,
            [
                StepStatus.PENDING,
                timestamp,
                workflowIdentifier,
                stepKey,
                fenceToken,
                StepStatus.RUNNING,
            ],
        );
        return (result as { affectedRows: number }).affectedRows > 0;
    }

    public async ensureSleepTimer(
        workflowIdentifier: string,
        timerKey: string,
        runAt: Date,
    ): Promise<{ runAt: Date }> {
        return this.withinTransaction(async (connection) => {
            // Look for an existing sleep timer for this workflow and key. Sleep timers
            // are recorded as schedules whose stepKey is the timer key. Locking the
            // matching rows makes the check-then-insert safe under concurrency.
            const [rows] = await connection.query<RowDataPacket[]>(
                `SELECT \`runAt\` FROM \`outpostSchedules\`
          WHERE \`workflowIdentifier\` = ? AND \`stepKey\` = ?
          ORDER BY \`scheduleIdentifier\` ASC
          LIMIT 1
          FOR UPDATE`,
                [workflowIdentifier, timerKey],
            );
            const existing = rows[0];
            if (existing) {
                return { runAt: new Date(existing.runAt) };
            }

            const timestamp = formatUtcDateTime(this.now());
            await connection.query(
                `INSERT INTO \`outpostSchedules\`
           (\`workflowIdentifier\`, \`stepKey\`, \`runAt\`, \`status\`, \`payload\`, \`createdAt\`)
         VALUES (?, ?, ?, ?, NULL, ?)`,
                [
                    workflowIdentifier,
                    timerKey,
                    formatUtcDateTime(runAt),
                    ScheduleStatus.PENDING,
                    timestamp,
                ],
            );
            return { runAt };
        });
    }

    public async scheduleTimer(
        workflowIdentifier: string,
        stepKey: string | null,
        runAt: Date,
        payload: string | null,
    ): Promise<void> {
        const timestamp = formatUtcDateTime(this.now());
        await this.pool.query(
            `INSERT INTO \`outpostSchedules\`
         (\`workflowIdentifier\`, \`stepKey\`, \`runAt\`, \`status\`, \`payload\`, \`createdAt\`)
       VALUES (?, ?, ?, ?, ?, ?)`,
            [
                workflowIdentifier,
                stepKey,
                formatUtcDateTime(runAt),
                ScheduleStatus.PENDING,
                payload,
                timestamp,
            ],
        );
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
        return this.withinTransaction(async (connection) => {
            const [rows] = await connection.query<RowDataPacket[]>(
                `SELECT \`scheduleIdentifier\`, \`workflowIdentifier\`, \`stepKey\`, \`payload\`
           FROM \`outpostSchedules\`
          WHERE \`status\` = ? AND \`runAt\` <= ?
          ORDER BY \`runAt\` ASC
          LIMIT ?
          FOR UPDATE SKIP LOCKED`,
                [ScheduleStatus.PENDING, formatUtcDateTime(now), limit],
            );

            if (rows.length > 0) {
                const identifiers = rows.map((row) => row.scheduleIdentifier);
                await connection.query(
                    `UPDATE \`outpostSchedules\` SET \`status\` = ? WHERE \`scheduleIdentifier\` IN (${identifiers
                        .map(() => "?")
                        .join(",")})`,
                    [ScheduleStatus.PROCESSED, ...identifiers],
                );
            }

            return rows.map((row) => ({
                scheduleIdentifier: row.scheduleIdentifier,
                workflowIdentifier: row.workflowIdentifier,
                stepKey: row.stepKey ?? null,
                payload: row.payload ?? null,
            }));
        });
    }

    public async setTimerStatus(scheduleIdentifier: number, status: ScheduleStatus): Promise<void> {
        await this.pool.query(
            "UPDATE `outpostSchedules` SET `status` = ? WHERE `scheduleIdentifier` = ?",
            [status, scheduleIdentifier],
        );
    }

    public async logEvent(
        workflowIdentifier: string,
        stepKey: string | null,
        eventType: EventType,
        details: Record<string, unknown>,
    ): Promise<void> {
        const timestamp = formatUtcDateTime(this.now());
        await this.pool.query(
            `INSERT INTO \`outpostAuditEvents\`
         (\`workflowIdentifier\`, \`stepKey\`, \`eventType\`, \`details\`, \`createdAt\`)
       VALUES (?, ?, ?, ?, ?)`,
            [workflowIdentifier, stepKey, eventType, JSON.stringify(details), timestamp],
        );
    }
}
