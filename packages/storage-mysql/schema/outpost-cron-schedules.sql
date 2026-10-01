-- Stores long-lived recurring schedules (durable cron jobs), as opposed to the
-- one-shot timers in `outpostSchedules`. The scheduler evaluates each row on
-- every tick and fires it when `nextRunAt` is due, advancing `nextRunAt` to the
-- following occurrence in the same atomic write so two processes cannot fire
-- the same occurrence twice.
--
-- Every row carries a UUID surrogate `id` (its primary key), while the stable
-- `name` is kept unique so the idempotent `upsertCronSchedule` and the by-name
-- management operations continue to address a schedule by its natural key.
--
-- The (status, nextRunAt) index backs the due-schedule query, and the
-- (leaseOwner, leaseExpiresAt) index backs the ownership-lease queries used to
-- distribute schedules across a fleet of processes.
CREATE TABLE IF NOT EXISTS `outpostCronSchedules` (
  `id`             CHAR(36)     NOT NULL,
  `name`           VARCHAR(191) NOT NULL,
  `cronExpression` VARCHAR(191) NOT NULL,
  `timeZone`       VARCHAR(64)  NULL,
  `workflowName`   VARCHAR(191) NOT NULL,
  `payload`        LONGTEXT     NULL,
  `catchUp`        TINYINT(1)   NOT NULL DEFAULT 0,
  `status`         VARCHAR(32)  NOT NULL,
  `nextRunAt`      DATETIME(3)  NOT NULL,
  `lastRunAt`      DATETIME(3)  NULL,
  `leaseOwner`     VARCHAR(191) NULL,
  `leaseExpiresAt` DATETIME(3)  NULL,
  `createdAt`      DATETIME(3)  NOT NULL,
  `updatedAt`      DATETIME(3)  NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniqueOutpostCronSchedulesName` (`name`),
  KEY `indexOutpostCronSchedulesStatusNextRunAt` (`status`, `nextRunAt`),
  KEY `indexOutpostCronSchedulesLease` (`leaseOwner`, `leaseExpiresAt`)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
