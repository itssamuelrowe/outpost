-- Stores the durable journal of every step within a workflow.
-- A step is uniquely identified by the pair (workflowId, stepKey).
-- The `fenceToken` column is incremented on every claim and is used to reject
-- writes from a stale worker whose lease has been taken over by a newer worker.
--
-- Every row carries a UUID surrogate `id` (its primary key), while the natural
-- (workflowId, stepKey) pair is kept unique so claiming and the idempotent
-- row-creation upsert continue to address a step by its natural key.
CREATE TABLE IF NOT EXISTS `outpostSteps` (
  `id`          CHAR(36)     NOT NULL,
  `workflowId`  VARCHAR(191) NOT NULL,
  `stepKey`     VARCHAR(191) NOT NULL,
  `status`      VARCHAR(32)  NOT NULL,
  `attempts`    INT          NOT NULL DEFAULT 0,
  `maxAttempts` INT          NOT NULL DEFAULT 1,
  `output`      LONGBLOB     NULL,
  `lastError`   LONGTEXT     NULL,
  `fenceToken`  BIGINT       NOT NULL DEFAULT 0,
  `lockedUntil` DATETIME(3)  NULL,
  `completedAt` DATETIME(3)  NULL,
  `createdAt`   DATETIME(3)  NOT NULL,
  `updatedAt`   DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniqueOutpostStepsWorkflowStep` (`workflowId`, `stepKey`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
