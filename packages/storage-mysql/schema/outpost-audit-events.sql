-- Stores the append-only audit log of material state transitions.
-- The (workflowId, createdAt) index supports retrieving the ordered
-- history of a single workflow, which is the most common diagnostic query.
CREATE TABLE IF NOT EXISTS `outpostAuditEvents` (
  `id`         BIGINT       NOT NULL AUTO_INCREMENT,
  `workflowId` VARCHAR(191) NOT NULL,
  `stepKey`    VARCHAR(191) NULL,
  `eventType`  VARCHAR(64)  NOT NULL,
  `details`    LONGTEXT     NULL,
  `createdAt`  DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  KEY `indexOutpostAuditWorkflowCreatedAt` (`workflowId`, `createdAt`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
