-- Stores the append-only audit log of material state transitions.
-- The (workflowId, createdAt) index supports retrieving the ordered
-- history of a single workflow, which is the most common diagnostic query.
--
-- Each event is identified by a UUID `id` (its primary key), assigned by the
-- adapter when the row is inserted rather than by a database sequence.
CREATE TABLE IF NOT EXISTS `outpostAuditEvents` (
  `id`         CHAR(36)     NOT NULL,
  `workflowId` VARCHAR(191) NOT NULL,
  `stepKey`    VARCHAR(191) NULL,
  `eventType`  VARCHAR(64)  NOT NULL,
  `details`    LONGTEXT     NULL,
  `createdAt`  DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  KEY `indexOutpostAuditWorkflowCreatedAt` (`workflowId`, `createdAt`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
