import { randomUUID } from "node:crypto";

import {
    CronScheduleStatus,
    EventType,
    ScheduleStatus,
    StepStatus,
    WorkflowStatus,
} from "@outpost/core";
import type {
    ClaimResult,
    CronSchedule,
    DueCronSchedule,
    DueTimer,
    SleepTimer,
    StorageAdapter,
    WorkflowFilter,
    WorkflowRecord,
} from "@outpost/core";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";

import { DateTimeUtility } from "../utilities/datetime.utility.js";
import { SchemaLoader } from "../utilities/schema-loader.utility.js";

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
 * The optional fields accepted by {@link MysqlStorage.setWorkflowStatus}.
 *
 * Each key is optional, and its mere presence (not just its value) decides
 * whether the corresponding column is written. This lets a caller clear a
 * column to `null` explicitly, which a plain "undefined means skip" convention
 * could not express.
 */
export interface WorkflowStatusFields {
    /**
     * The serialized final output to store, or `null` to clear it.
     */
    output?: Buffer | null;
    /**
     * The terminal error description to store, or `null` to clear it.
     */
    error?: string | null;
}

/**
 * The result shape returned by MySQL write queries that we inspect for the
 * number of rows a statement touched. Fence-guarded writes use this to tell a
 * successful update from a no-op rejection.
 */
interface AffectedRowsResult {
    affectedRows: number;
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
        const statements = await SchemaLoader.loadSchemaStatements();
        for (const statement of statements) {
            await this.pool.query(statement);
        }
    }

    /**
     * Runs the supplied operation inside a transaction, committing on success
     * and rolling back on any thrown error. The connection is always returned
     * to the pool.
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
        workflowId: string,
        workflowName: string,
        input: Buffer | null,
        parentWorkflowId: string | null = null,
    ): Promise<void> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());

        /*
         * The surrogate `id` is a UUID the adapter mints here, while the natural
         * key `workflowId` carries the unique constraint. The upsert is a no-op
         * when the row already exists, so re-running a workflow neither
         * duplicates the record nor overwrites the stored parent link.
         */
        await this.pool.query(
            `INSERT INTO \`outpostWorkflows\`
                (
                    \`id\`,
                    \`workflowId\`,
                    \`workflowName\`,
                    \`parentWorkflowId\`,
                    \`status\`,
                    \`input\`,
                    \`output\`,
                    \`error\`,
                    \`createdAt\`,
                    \`updatedAt\`
                )
             VALUES (?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?)
             ON DUPLICATE KEY UPDATE \`workflowId\` = \`workflowId\``,
            [
                randomUUID(),
                workflowId,
                workflowName,
                parentWorkflowId,
                WorkflowStatus.RUNNING,
                input,
                timestamp,
                timestamp,
            ],
        );
    }

    public async setWorkflowStatus(
        workflowId: string,
        status: WorkflowStatus,
        fields?: WorkflowStatusFields,
    ): Promise<void> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());

        /*
         * Build the assignment list dynamically so a caller can update the
         * status alone, or also set output and error. Presence of a key, rather
         * than its value, decides whether a column is written, which allows
         * clearing a column to `null`.
         */
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
        parameters.push(workflowId);

        await this.pool.query(
            `UPDATE \`outpostWorkflows\`
                SET ${assignments.join(", ")}
             WHERE \`workflowId\` = ?`,
            parameters,
        );
    }

    public async getWorkflow(workflowId: string): Promise<WorkflowRecord | null> {
        const [rows] = await this.pool.query<RowDataPacket[]>(
            `SELECT *
               FROM \`outpostWorkflows\`
              WHERE \`workflowId\` = ?`,
            [workflowId],
        );
        const row = rows[0];
        return row ? MysqlStorage.mapWorkflowRow(row) : null;
    }

    public async listWorkflows(filter: WorkflowFilter): Promise<WorkflowRecord[]> {
        /*
         * Translate the filter into a conjunction of optional predicates. Each
         * present field contributes one clause and one bound parameter, so an
         * empty filter degenerates to selecting every workflow up to the limit.
         */
        const clauses: string[] = [];
        const parameters: unknown[] = [];

        if (filter.statuses && filter.statuses.length > 0) {
            const placeholders = filter.statuses.map(() => "?").join(", ");
            clauses.push(`\`status\` IN (${placeholders})`);
            parameters.push(...filter.statuses);
        }
        if (filter.workflowName !== undefined) {
            clauses.push("`workflowName` = ?");
            parameters.push(filter.workflowName);
        }
        if (filter.parentWorkflowId !== undefined) {
            clauses.push("`parentWorkflowId` = ?");
            parameters.push(filter.parentWorkflowId);
        }
        if (filter.createdAfter) {
            clauses.push("`createdAt` >= ?");
            parameters.push(DateTimeUtility.formatUtcDateTime(filter.createdAfter));
        }
        if (filter.createdBefore) {
            clauses.push("`createdAt` <= ?");
            parameters.push(DateTimeUtility.formatUtcDateTime(filter.createdBefore));
        }

        /*
         * Cap the result set at the caller's limit, or a sensible default when
         * none is given, so an unbounded list cannot be requested by accident.
         */
        const limit = filter.limit ?? 100;
        const whereClause = clauses.length > 0 ? `WHERE ${clauses.join(" AND ")}` : "";

        const [rows] = await this.pool.query<RowDataPacket[]>(
            `SELECT *
               FROM \`outpostWorkflows\`
               ${whereClause}
              ORDER BY \`updatedAt\` DESC
              LIMIT ?`,
            [...parameters, limit],
        );
        return rows.map((row) => MysqlStorage.mapWorkflowRow(row));
    }

    public async claimStep(
        workflowId: string,
        stepKey: string,
        maxAttempts: number,
        leaseMilliseconds: number,
    ): Promise<ClaimResult> {
        const currentInstant = this.now();
        const timestamp = DateTimeUtility.formatUtcDateTime(currentInstant);
        const newLease = DateTimeUtility.formatUtcDateTime(
            new Date(currentInstant.getTime() + leaseMilliseconds),
        );

        return this.withinTransaction(async (connection) => {
            /*
             * Ensure the row exists so that the SELECT below has something to
             * lock. The upsert is a no-op when the step has already been
             * recorded by an earlier attempt.
             */
            await connection.query(
                `INSERT INTO \`outpostSteps\`
                    (
                        \`id\`,
                        \`workflowId\`,
                        \`stepKey\`,
                        \`status\`,
                        \`attempts\`,
                        \`maxAttempts\`,
                        \`fenceToken\`,
                        \`createdAt\`,
                        \`updatedAt\`
                    )
                 VALUES (?, ?, ?, ?, 0, ?, 0, ?, ?)
                 ON DUPLICATE KEY UPDATE \`workflowId\` = \`workflowId\``,
                [
                    randomUUID(),
                    workflowId,
                    stepKey,
                    StepStatus.PENDING,
                    maxAttempts,
                    timestamp,
                    timestamp,
                ],
            );

            /*
             * Lock the row for this transaction. SKIP LOCKED lets a competing
             * claimer return at once rather than block, which is the behaviour
             * we want for worker fan-out.
             */
            const [rows] = await connection.query<RowDataPacket[]>(
                `SELECT *
                   FROM \`outpostSteps\`
                  WHERE \`workflowId\` = ? AND \`stepKey\` = ?
                    FOR UPDATE SKIP LOCKED`,
                [workflowId, stepKey],
            );
            const row = rows[0];
            if (!row) {
                /* Another worker currently holds the row lock. */
                return { claimed: false, attempt: 0, fenceToken: 0, priorStatus: null };
            }

            const status = row.status as StepStatus;

            /*
             * A terminal step is never re-run. Return its memoized result so the
             * caller can reuse the recorded output.
             */
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

            /*
             * Decide lease liveness using the database's own clock rather than
             * the application clock, to avoid any skew between the application
             * and the database session timezone. A step whose lease is still
             * live belongs to another worker, so refuse the claim.
             */
            if (status === StepStatus.RUNNING && row.lockedUntil !== null) {
                const [livenessRows] = await connection.query<RowDataPacket[]>(
                    `SELECT (\`lockedUntil\` > ?) AS live
                       FROM \`outpostSteps\`
                      WHERE \`workflowId\` = ? AND \`stepKey\` = ?`,
                    [timestamp, workflowId, stepKey],
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

            /*
             * Grant the claim: advance the attempt count and fence token, and
             * record a fresh lease. The new fence token is what later rejects a
             * commit from a worker whose lease we are taking over here.
             */
            const attempt = row.attempts + 1;
            const fenceToken = Number(row.fenceToken) + 1;

            await connection.query(
                `UPDATE \`outpostSteps\`
                    SET \`status\` = ?,
                        \`attempts\` = ?,
                        \`fenceToken\` = ?,
                        \`lockedUntil\` = ?,
                        \`updatedAt\` = ?
                  WHERE \`workflowId\` = ? AND \`stepKey\` = ?`,
                [StepStatus.RUNNING, attempt, fenceToken, newLease, timestamp, workflowId, stepKey],
            );

            return { claimed: true, attempt, fenceToken, priorStatus: status };
        });
    }

    public async commitStep(
        workflowId: string,
        stepKey: string,
        fenceToken: number,
        output: Buffer | null,
        status: StepStatus,
    ): Promise<boolean> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());

        /*
         * The fence token in the WHERE clause is the guard: the write touches a
         * row only when this caller still holds the current lease, so a stale
         * worker cannot overwrite a newer owner's result.
         */
        const [result] = await this.pool.query(
            `UPDATE \`outpostSteps\`
                SET \`status\` = ?,
                    \`output\` = ?,
                    \`lockedUntil\` = NULL,
                    \`completedAt\` = ?,
                    \`updatedAt\` = ?
              WHERE \`workflowId\` = ? AND \`stepKey\` = ? AND \`fenceToken\` = ?`,
            [status, output, timestamp, timestamp, workflowId, stepKey, fenceToken],
        );
        return (result as AffectedRowsResult).affectedRows > 0;
    }

    public async failStep(
        workflowId: string,
        stepKey: string,
        fenceToken: number,
        error: string,
        status: StepStatus,
        retryAt: Date | null,
    ): Promise<boolean> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());

        /*
         * Preserve the ambiguous status across a scheduled retry so recovery can
         * still probe for the earlier side effect. Otherwise a retryable definite
         * failure returns to the pending state, and a terminal failure keeps the
         * supplied status.
         */
        const nextStatus: StepStatus = retryAt
            ? status === StepStatus.AMBIGUOUS
                ? StepStatus.AMBIGUOUS
                : StepStatus.PENDING
            : status;

        const [result] = await this.pool.query(
            `UPDATE \`outpostSteps\`
                SET \`status\` = ?,
                    \`lastError\` = ?,
                    \`lockedUntil\` = NULL,
                    \`updatedAt\` = ?
              WHERE \`workflowId\` = ? AND \`stepKey\` = ? AND \`fenceToken\` = ?`,
            [nextStatus, error, timestamp, workflowId, stepKey, fenceToken],
        );
        const affected = (result as AffectedRowsResult).affectedRows > 0;

        /*
         * Only schedule the retry timer once we know the fence-guarded update
         * actually applied, so a stale failure does not enqueue a spurious retry.
         */
        if (affected && retryAt) {
            await this.scheduleTimer(workflowId, stepKey, retryAt, null);
        }
        return affected;
    }

    public async releaseStep(
        workflowId: string,
        stepKey: string,
        fenceToken: number,
    ): Promise<boolean> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());

        /*
         * Clear the lease and return the step to PENDING, but only when this
         * caller still holds the current lease (matching fence token) and the
         * step is actually running. The attempt count is left untouched, so the
         * next claim simply resumes the step.
         */
        const [result] = await this.pool.query(
            `UPDATE \`outpostSteps\`
                SET \`status\` = ?,
                    \`lockedUntil\` = NULL,
                    \`updatedAt\` = ?
              WHERE \`workflowId\` = ?
                AND \`stepKey\` = ?
                AND \`fenceToken\` = ?
                AND \`status\` = ?`,
            [StepStatus.PENDING, timestamp, workflowId, stepKey, fenceToken, StepStatus.RUNNING],
        );
        return (result as AffectedRowsResult).affectedRows > 0;
    }

    public async ensureSleepTimer(
        workflowId: string,
        timerKey: string,
        runAt: Date,
    ): Promise<SleepTimer> {
        return this.withinTransaction(async (connection) => {
            /*
             * Look for an existing sleep timer for this workflow and key. Sleep
             * timers are recorded as schedules whose stepKey is the timer key.
             * Locking the matching rows makes the check-then-insert safe under
             * concurrency.
             */
            const [rows] = await connection.query<RowDataPacket[]>(
                `SELECT \`runAt\`
                   FROM \`outpostSchedules\`
                  WHERE \`workflowId\` = ? AND \`stepKey\` = ?
                  ORDER BY \`scheduleId\` ASC
                  LIMIT 1
                    FOR UPDATE`,
                [workflowId, timerKey],
            );
            const existing = rows[0];
            if (existing) {
                return { runAt: new Date(existing.runAt) };
            }

            /*
             * No timer yet, so record it exactly once with its due time. The
             * adapter mints the UUID `scheduleId` that identifies the row.
             */
            const timestamp = DateTimeUtility.formatUtcDateTime(this.now());
            await connection.query(
                `INSERT INTO \`outpostSchedules\`
                    (\`scheduleId\`, \`workflowId\`, \`stepKey\`, \`runAt\`, \`status\`, \`payload\`, \`createdAt\`)
                 VALUES (?, ?, ?, ?, ?, NULL, ?)`,
                [
                    randomUUID(),
                    workflowId,
                    timerKey,
                    DateTimeUtility.formatUtcDateTime(runAt),
                    ScheduleStatus.PENDING,
                    timestamp,
                ],
            );
            return { runAt };
        });
    }

    public async scheduleTimer(
        workflowId: string,
        stepKey: string | null,
        runAt: Date,
        payload: string | null,
    ): Promise<void> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());
        await this.pool.query(
            `INSERT INTO \`outpostSchedules\`
                (\`scheduleId\`, \`workflowId\`, \`stepKey\`, \`runAt\`, \`status\`, \`payload\`, \`createdAt\`)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [
                randomUUID(),
                workflowId,
                stepKey,
                DateTimeUtility.formatUtcDateTime(runAt),
                ScheduleStatus.PENDING,
                payload,
                timestamp,
            ],
        );
    }

    public async claimDueTimers(now: Date, limit: number): Promise<DueTimer[]> {
        return this.withinTransaction(async (connection) => {
            /*
             * Select the pending timers whose due time has passed, locking them
             * with SKIP LOCKED so concurrent schedulers each pick a disjoint set
             * rather than contending for the same rows.
             */
            const [rows] = await connection.query<RowDataPacket[]>(
                `SELECT \`scheduleId\`, \`workflowId\`, \`stepKey\`, \`payload\`
                   FROM \`outpostSchedules\`
                  WHERE \`status\` = ? AND \`runAt\` <= ?
                  ORDER BY \`runAt\` ASC
                  LIMIT ?
                    FOR UPDATE SKIP LOCKED`,
                [ScheduleStatus.PENDING, DateTimeUtility.formatUtcDateTime(now), limit],
            );

            /*
             * Mark the claimed timers processed in the same transaction, so they
             * are not dispatched a second time once the lock is released.
             */
            if (rows.length > 0) {
                const scheduleIds = rows.map((row) => row.scheduleId);
                const placeholders = scheduleIds.map(() => "?").join(", ");
                await connection.query(
                    `UPDATE \`outpostSchedules\`
                        SET \`status\` = ?
                      WHERE \`scheduleId\` IN (${placeholders})`,
                    [ScheduleStatus.PROCESSED, ...scheduleIds],
                );
            }

            return rows.map((row) => ({
                scheduleId: row.scheduleId,
                workflowId: row.workflowId,
                stepKey: row.stepKey ?? null,
                payload: row.payload ?? null,
            }));
        });
    }

    public async setTimerStatus(scheduleId: string, status: ScheduleStatus): Promise<void> {
        await this.pool.query(
            `UPDATE \`outpostSchedules\`
                SET \`status\` = ?
              WHERE \`scheduleId\` = ?`,
            [status, scheduleId],
        );
    }

    public async logEvent(
        workflowId: string,
        stepKey: string | null,
        eventType: EventType,
        details: Record<string, unknown>,
    ): Promise<void> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());
        await this.pool.query(
            `INSERT INTO \`outpostAuditEvents\`
                (\`id\`, \`workflowId\`, \`stepKey\`, \`eventType\`, \`details\`, \`createdAt\`)
             VALUES (?, ?, ?, ?, ?, ?)`,
            [randomUUID(), workflowId, stepKey, eventType, JSON.stringify(details), timestamp],
        );
    }

    // ---------------------------------------------------------------------------
    // Recurring (cron) schedules
    // ---------------------------------------------------------------------------

    public async upsertCronSchedule(schedule: CronSchedule): Promise<void> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());

        /*
         * Insert the schedule with a freshly minted UUID `id`, keyed by its
         * unique `name`. When a schedule with that name already exists, update
         * only the definition fields and leave the firing history (`nextRunAt`,
         * `lastRunAt`) and the ownership lease untouched, so re-registering the
         * same schedule on every boot is an idempotent no-op rather than a
         * reset.
         */
        await this.pool.query(
            `INSERT INTO \`outpostCronSchedules\`
                (
                    \`id\`,
                    \`name\`,
                    \`cronExpression\`,
                    \`timeZone\`,
                    \`workflowName\`,
                    \`payload\`,
                    \`catchUp\`,
                    \`status\`,
                    \`nextRunAt\`,
                    \`lastRunAt\`,
                    \`leaseOwner\`,
                    \`leaseExpiresAt\`,
                    \`createdAt\`,
                    \`updatedAt\`
                )
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
                \`cronExpression\` = VALUES(\`cronExpression\`),
                \`timeZone\` = VALUES(\`timeZone\`),
                \`workflowName\` = VALUES(\`workflowName\`),
                \`payload\` = VALUES(\`payload\`),
                \`catchUp\` = VALUES(\`catchUp\`),
                \`updatedAt\` = VALUES(\`updatedAt\`)`,
            [
                randomUUID(),
                schedule.name,
                schedule.cronExpression,
                schedule.timeZone,
                schedule.workflowName,
                schedule.payload,
                schedule.catchUp ? 1 : 0,
                schedule.status,
                DateTimeUtility.formatUtcDateTime(schedule.nextRunAt),
                schedule.lastRunAt ? DateTimeUtility.formatUtcDateTime(schedule.lastRunAt) : null,
                schedule.leaseOwner,
                schedule.leaseExpiresAt
                    ? DateTimeUtility.formatUtcDateTime(schedule.leaseExpiresAt)
                    : null,
                timestamp,
                timestamp,
            ],
        );
    }

    public async getCronSchedule(name: string): Promise<CronSchedule | null> {
        const [rows] = await this.pool.query<RowDataPacket[]>(
            `SELECT *
               FROM \`outpostCronSchedules\`
              WHERE \`name\` = ?`,
            [name],
        );
        const row = rows[0];
        return row ? MysqlStorage.mapCronScheduleRow(row) : null;
    }

    public async listCronSchedules(): Promise<CronSchedule[]> {
        const [rows] = await this.pool.query<RowDataPacket[]>(
            `SELECT *
               FROM \`outpostCronSchedules\`
              ORDER BY \`name\` ASC`,
        );
        return rows.map((row) => MysqlStorage.mapCronScheduleRow(row));
    }

    public async claimDueCronSchedules(
        now: Date,
        limit: number,
        computeNextRunAt: (schedule: CronSchedule, firedAt: Date) => Date,
        owner?: string,
    ): Promise<DueCronSchedule[]> {
        return this.claimDueCronSchedulesWhere(now, limit, computeNextRunAt, owner, false);
    }

    public async claimDueUnownedCronSchedules(
        now: Date,
        limit: number,
        computeNextRunAt: (schedule: CronSchedule, firedAt: Date) => Date,
    ): Promise<DueCronSchedule[]> {
        return this.claimDueCronSchedulesWhere(now, limit, computeNextRunAt, undefined, true);
    }

    public async setCronScheduleStatus(name: string, status: CronScheduleStatus): Promise<boolean> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());
        const [result] = await this.pool.query(
            `UPDATE \`outpostCronSchedules\`
                SET \`status\` = ?,
                    \`updatedAt\` = ?
              WHERE \`name\` = ?`,
            [status, timestamp, name],
        );
        return (result as AffectedRowsResult).affectedRows > 0;
    }

    public async removeCronSchedule(name: string): Promise<boolean> {
        const [result] = await this.pool.query(
            `DELETE FROM \`outpostCronSchedules\`
              WHERE \`name\` = ?`,
            [name],
        );
        return (result as AffectedRowsResult).affectedRows > 0;
    }

    public async renewCronLeases(owner: string, expiresAt: Date): Promise<number> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());
        const [result] = await this.pool.query(
            `UPDATE \`outpostCronSchedules\`
                SET \`leaseExpiresAt\` = ?,
                    \`updatedAt\` = ?
              WHERE \`leaseOwner\` = ?`,
            [DateTimeUtility.formatUtcDateTime(expiresAt), timestamp, owner],
        );
        return (result as AffectedRowsResult).affectedRows;
    }

    public async acquireCronSchedules(
        owner: string,
        now: Date,
        expiresAt: Date,
        limit: number,
    ): Promise<CronSchedule[]> {
        if (limit <= 0) {
            return [];
        }
        const nowLiteral = DateTimeUtility.formatUtcDateTime(now);

        return this.withinTransaction(async (connection) => {
            /*
             * Lock the candidate rows: those that are free (never owned) or
             * whose lease has expired at or before now. Ordering never-owned
             * rows first, then by oldest expiry, spreads ownership rather than
             * repeatedly landing on the same schedules. SKIP LOCKED lets a
             * competing acquirer pick a disjoint set instead of blocking.
             */
            const [rows] = await connection.query<RowDataPacket[]>(
                `SELECT *
                   FROM \`outpostCronSchedules\`
                  WHERE \`leaseOwner\` IS NULL
                     OR \`leaseExpiresAt\` IS NULL
                     OR \`leaseExpiresAt\` <= ?
                  ORDER BY (\`leaseExpiresAt\` IS NOT NULL), \`leaseExpiresAt\` ASC
                  LIMIT ?
                    FOR UPDATE SKIP LOCKED`,
                [nowLiteral, limit],
            );
            if (rows.length === 0) {
                return [];
            }

            /*
             * Assign every locked candidate to this owner in a single update,
             * stamping the new lease expiry so the heartbeat can later renew it.
             */
            const timestamp = DateTimeUtility.formatUtcDateTime(this.now());
            const ids = rows.map((row) => row.id);
            const placeholders = ids.map(() => "?").join(", ");
            await connection.query(
                `UPDATE \`outpostCronSchedules\`
                    SET \`leaseOwner\` = ?,
                        \`leaseExpiresAt\` = ?,
                        \`updatedAt\` = ?
                  WHERE \`id\` IN (${placeholders})`,
                [owner, DateTimeUtility.formatUtcDateTime(expiresAt), timestamp, ...ids],
            );

            /*
             * Reflect the just-written lease in the returned snapshots so the
             * caller sees the schedules as it now owns them, without a reread.
             */
            return rows.map((row) =>
                MysqlStorage.mapCronScheduleRow({
                    ...row,
                    leaseOwner: owner,
                    leaseExpiresAt: expiresAt,
                }),
            );
        });
    }

    public async countOwnedCronSchedules(owner: string, now: Date): Promise<number> {
        const [rows] = await this.pool.query<RowDataPacket[]>(
            `SELECT COUNT(*) AS \`count\`
               FROM \`outpostCronSchedules\`
              WHERE \`leaseOwner\` = ? AND \`leaseExpiresAt\` > ?`,
            [owner, DateTimeUtility.formatUtcDateTime(now)],
        );
        return Number(rows[0]?.count ?? 0);
    }

    public async releaseCronLeases(owner: string): Promise<number> {
        const timestamp = DateTimeUtility.formatUtcDateTime(this.now());
        const [result] = await this.pool.query(
            `UPDATE \`outpostCronSchedules\`
                SET \`leaseOwner\` = NULL,
                    \`leaseExpiresAt\` = NULL,
                    \`updatedAt\` = ?
              WHERE \`leaseOwner\` = ?`,
            [timestamp, owner],
        );
        return (result as AffectedRowsResult).affectedRows;
    }

    /**
     * Shared body for {@link claimDueCronSchedules} and
     * {@link claimDueUnownedCronSchedules}.
     *
     * Both claim up to `limit` `ACTIVE` schedules whose `nextRunAt` has passed,
     * then advance each claimed schedule to its following occurrence in the
     * same transaction so a concurrent claimer cannot fire the same occurrence
     * twice. They differ only in which rows are eligible:
     *
     * - When `owner` is given, only schedules currently leased live to that owner
     *   are considered, scoping firing to this process's owned slice.
     * - When `unownedOnly` is set, only free or lease-expired schedules are
     *   considered, which is the safety net that fires schedules stranded when
     *   the fleet's total capacity is below the schedule count.
     * - With neither, any due schedule is fair game (the simple
     *   every-process-evaluates-everything model).
     */
    private async claimDueCronSchedulesWhere(
        now: Date,
        limit: number,
        computeNextRunAt: (schedule: CronSchedule, firedAt: Date) => Date,
        owner: string | undefined,
        unownedOnly: boolean,
    ): Promise<DueCronSchedule[]> {
        if (limit <= 0) {
            return [];
        }
        const nowLiteral = DateTimeUtility.formatUtcDateTime(now);

        /*
         * Build the ownership predicate that distinguishes the three firing
         * modes, together with its bound parameters. The due predicate
         * (`ACTIVE` and `nextRunAt <= now`) is common to all three.
         */
        const clauses: string[] = ["`status` = ?", "`nextRunAt` <= ?"];
        const parameters: unknown[] = [CronScheduleStatus.ACTIVE, nowLiteral];

        if (owner !== undefined) {
            clauses.push("`leaseOwner` = ? AND `leaseExpiresAt` > ?");
            parameters.push(owner, nowLiteral);
        } else if (unownedOnly) {
            clauses.push(
                "(`leaseOwner` IS NULL OR `leaseExpiresAt` IS NULL OR `leaseExpiresAt` <= ?)",
            );
            parameters.push(nowLiteral);
        }

        return this.withinTransaction(async (connection) => {
            /*
             * Lock the due rows so a concurrent claimer skips them rather than
             * blocking, then advance each one below. Oldest-due first keeps the
             * firing order fair.
             */
            const [rows] = await connection.query<RowDataPacket[]>(
                `SELECT *
                   FROM \`outpostCronSchedules\`
                  WHERE ${clauses.join(" AND ")}
                  ORDER BY \`nextRunAt\` ASC
                  LIMIT ?
                    FOR UPDATE SKIP LOCKED`,
                [...parameters, limit],
            );
            if (rows.length === 0) {
                return [];
            }

            const claimed: DueCronSchedule[] = [];
            for (const row of rows) {
                /*
                 * Snapshot the occurrence being fired, then advance `nextRunAt`
                 * past it and stamp `lastRunAt`. The caller computes the next
                 * occurrence, since that logic lives in the engine layer.
                 */
                const snapshot = MysqlStorage.mapCronScheduleRow(row);
                const firedAt = snapshot.nextRunAt;
                const nextRunAt = computeNextRunAt(snapshot, firedAt);
                const timestamp = DateTimeUtility.formatUtcDateTime(this.now());

                await connection.query(
                    `UPDATE \`outpostCronSchedules\`
                        SET \`lastRunAt\` = ?,
                            \`nextRunAt\` = ?,
                            \`updatedAt\` = ?
                      WHERE \`id\` = ?`,
                    [
                        DateTimeUtility.formatUtcDateTime(firedAt),
                        DateTimeUtility.formatUtcDateTime(nextRunAt),
                        timestamp,
                        row.id,
                    ],
                );

                claimed.push({ schedule: snapshot, firedAt });
            }
            return claimed;
        });
    }

    /**
     * Rehydrates a workflow row into a {@link WorkflowRecord}, normalising the
     * nullable parent link and parsing the stored timestamps into `Date`
     * instances. Shared by {@link getWorkflow} and {@link listWorkflows}.
     */
    private static mapWorkflowRow(row: RowDataPacket): WorkflowRecord {
        return {
            workflowId: row.workflowId,
            workflowName: row.workflowName,
            parentWorkflowId: row.parentWorkflowId ?? null,
            status: row.status as WorkflowStatus,
            input: row.input,
            output: row.output,
            error: row.error,
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
        };
    }

    /**
     * Rehydrates a cron schedule row into a {@link CronSchedule}, converting the
     * stored `TINYINT` back into a boolean and parsing the required and
     * nullable timestamps into `Date` instances. Shared by every cron read and
     * claim.
     */
    private static mapCronScheduleRow(row: RowDataPacket): CronSchedule {
        return {
            name: row.name,
            cronExpression: row.cronExpression,
            timeZone: row.timeZone ?? null,
            workflowName: row.workflowName,
            payload: row.payload ?? null,
            catchUp: Boolean(row.catchUp),
            status: row.status as CronScheduleStatus,
            nextRunAt: new Date(row.nextRunAt),
            lastRunAt: row.lastRunAt ? new Date(row.lastRunAt) : null,
            leaseOwner: row.leaseOwner ?? null,
            leaseExpiresAt: row.leaseExpiresAt ? new Date(row.leaseExpiresAt) : null,
            createdAt: new Date(row.createdAt),
            updatedAt: new Date(row.updatedAt),
        };
    }
}
