-- Stores one row per workflow execution.
-- Column and table names follow the project convention: camelCase identifiers
-- with an `outpost` table prefix. The engine is used with InnoDB so that the
-- transactional row locking required for step claiming is available.
CREATE TABLE IF NOT EXISTS `outpostWorkflows` (
  `workflowIdentifier` VARCHAR(191) NOT NULL,
  `workflowName`       VARCHAR(191) NOT NULL,
  `status`             VARCHAR(32)  NOT NULL,
  `input`              LONGBLOB     NULL,
  `output`             LONGBLOB     NULL,
  `error`              LONGTEXT     NULL,
  `createdAt`          DATETIME(3)  NOT NULL,
  `updatedAt`          DATETIME(3)  NOT NULL,
  PRIMARY KEY (`workflowIdentifier`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
