-- Stores durable timers created by durable sleeps and retry scheduling.
-- The (status, runAt) index supports the scheduler's core query, which selects
-- pending timers whose due time has passed.
--
-- Each timer is identified by a UUID `scheduleId` (its primary key), assigned
-- by the adapter when the row is inserted rather than by a database sequence.
CREATE TABLE IF NOT EXISTS `outpostSchedules` (
  `scheduleId`  CHAR(36)     NOT NULL,
  `workflowId`  VARCHAR(191) NOT NULL,
  `stepKey`     VARCHAR(191) NULL,
  `runAt`       DATETIME(3)  NOT NULL,
  `status`      VARCHAR(32)  NOT NULL,
  `payload`     LONGTEXT     NULL,
  `createdAt`   DATETIME(3)  NOT NULL,
  PRIMARY KEY (`scheduleId`),
  KEY `indexOutpostSchedulesStatusRunAt` (`status`, `runAt`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
