-- Stores the durable journal of every step within a workflow.
-- A step is uniquely identified by the pair (workflowIdentifier, stepKey).
-- The `fenceToken` column is incremented on every claim and is used to reject
-- writes from a stale worker whose lease has been taken over by a newer worker.
CREATE TABLE IF NOT EXISTS `outpostSteps` (
  `workflowIdentifier` VARCHAR(191) NOT NULL,
  `stepKey`            VARCHAR(191) NOT NULL,
  `status`             VARCHAR(32)  NOT NULL,
  `attempts`           INT          NOT NULL DEFAULT 0,
  `maxAttempts`        INT          NOT NULL DEFAULT 1,
  `output`             LONGBLOB     NULL,
  `lastError`          LONGTEXT     NULL,
  `fenceToken`         BIGINT       NOT NULL DEFAULT 0,
  `lockedUntil`        DATETIME(3)  NULL,
  `completedAt`        DATETIME(3)  NULL,
  `createdAt`          DATETIME(3)  NOT NULL,
  `updatedAt`          DATETIME(3)  NOT NULL,
  PRIMARY KEY (`workflowIdentifier`, `stepKey`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
