-- Stores one row per workflow execution.
-- Column and table names follow the project convention: camelCase identifiers
-- with an `outpost` table prefix. The engine is used with InnoDB so that the
-- transactional row locking required for step claiming is available.
--
-- Every row carries a UUID surrogate `id` (its primary key), while the
-- caller-supplied `workflowId` is kept unique so lookups and the idempotent
-- `ensureWorkflow` upsert continue to address a row by its natural key.
CREATE TABLE IF NOT EXISTS `outpostWorkflows` (
  `id`               CHAR(36)     NOT NULL,
  `workflowId`       VARCHAR(191) NOT NULL,
  `workflowName`     VARCHAR(191) NOT NULL,
  `parentWorkflowId` VARCHAR(191) NULL,
  `status`           VARCHAR(32)  NOT NULL,
  `input`            LONGBLOB     NULL,
  `output`           LONGBLOB     NULL,
  `error`            LONGTEXT     NULL,
  `createdAt`        DATETIME(3)  NOT NULL,
  `updatedAt`        DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniqueOutpostWorkflowsWorkflowId` (`workflowId`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
