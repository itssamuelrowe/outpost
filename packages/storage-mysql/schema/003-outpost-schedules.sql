-- Stores durable timers created by durable sleeps and retry scheduling.
-- The (status, runAt) index supports the scheduler's core query, which selects
-- pending timers whose due time has passed.
CREATE TABLE IF NOT EXISTS `outpostSchedules` (
  `scheduleIdentifier` BIGINT       NOT NULL AUTO_INCREMENT,
  `workflowIdentifier` VARCHAR(191) NOT NULL,
  `stepKey`            VARCHAR(191) NULL,
  `runAt`              DATETIME(3)  NOT NULL,
  `status`             VARCHAR(32)  NOT NULL,
  `payload`            LONGTEXT     NULL,
  `createdAt`          DATETIME(3)  NOT NULL,
  PRIMARY KEY (`scheduleIdentifier`),
  KEY `indexOutpostSchedulesStatusRunAt` (`status`, `runAt`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
