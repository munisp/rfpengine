CREATE TABLE `capture_jobs` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`kind` enum('sync','response') NOT NULL,
	`status` enum('Queued','Running','Succeeded','Failed') NOT NULL DEFAULT 'Queued',
	`dedupeKey` varchar(190) NOT NULL,
	`payload` json NOT NULL,
	`attempts` int NOT NULL DEFAULT 0,
	`leaseToken` varchar(36),
	`leaseUntil` timestamp,
	`error` text,
	`result` json,
	`availableAt` timestamp NOT NULL DEFAULT (now()),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `capture_jobs_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_job_dedupe_uq` UNIQUE(`ownerUserId`,`dedupeKey`)
);
--> statement-breakpoint
CREATE TABLE `capture_matches` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`profileId` varchar(36) NOT NULL,
	`opportunityId` varchar(36) NOT NULL,
	`profileVersion` int NOT NULL,
	`opportunityVersion` int NOT NULL,
	`evaluatedOn` varchar(10) NOT NULL,
	`result` json NOT NULL,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `capture_matches_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_match_pair_uq` UNIQUE(`profileId`,`opportunityId`)
);
--> statement-breakpoint
CREATE TABLE `capture_opportunities` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`sourceId` varchar(36) NOT NULL,
	`externalKey` varchar(64) NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`contentHash` varchar(64) NOT NULL,
	`data` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `capture_opportunities_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_opp_source_key_uq` UNIQUE(`sourceId`,`externalKey`)
);
--> statement-breakpoint
CREATE TABLE `capture_opportunity_revisions` (
	`id` varchar(36) NOT NULL,
	`opportunityId` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`data` json NOT NULL,
	`contentHash` varchar(64) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `capture_opportunity_revisions_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_opp_revision_uq` UNIQUE(`opportunityId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `capture_profiles` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`data` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `capture_profiles_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `capture_responses` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`profileId` varchar(36) NOT NULL,
	`opportunityId` varchar(36) NOT NULL,
	`profileVersion` int NOT NULL,
	`opportunityVersion` int NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`automatedWorkspaceVersion` int NOT NULL DEFAULT 1,
	`profileSnapshot` json NOT NULL,
	`opportunitySnapshot` json NOT NULL,
	`status` enum('Created','Analyzing','Drafting','In review','Failed') NOT NULL,
	`error` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `capture_responses_id` PRIMARY KEY(`id`),
	CONSTRAINT `capture_response_revision_uq` UNIQUE(`profileId`,`opportunityId`,`profileVersion`,`opportunityVersion`)
);
--> statement-breakpoint
CREATE TABLE `capture_runs` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`status` enum('Running','Succeeded','Partial','Failed') NOT NULL,
	`processed` int NOT NULL DEFAULT 0,
	`succeeded` int NOT NULL DEFAULT 0,
	`failed` int NOT NULL DEFAULT 0,
	`error` text,
	`startedAt` timestamp NOT NULL DEFAULT (now()),
	`finishedAt` timestamp,
	CONSTRAINT `capture_runs_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `capture_settings` (
	`ownerUserId` int NOT NULL,
	`policy` json NOT NULL,
	`taskUid` varchar(128),
	`active` boolean NOT NULL DEFAULT false,
	`registrationUntil` timestamp,
	`runLeaseToken` varchar(36),
	`runLeaseUntil` timestamp,
	`lastRunAt` timestamp,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `capture_settings_ownerUserId` PRIMARY KEY(`ownerUserId`),
	CONSTRAINT `capture_settings_task_uq` UNIQUE(`taskUid`)
);
--> statement-breakpoint
CREATE TABLE `capture_sources` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`data` json NOT NULL,
	`nextCursor` text,
	`lastSyncAt` timestamp,
	`lastError` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `capture_sources_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `capture_jobs` ADD CONSTRAINT `capture_jobs_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_matches` ADD CONSTRAINT `capture_matches_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_matches` ADD CONSTRAINT `capture_matches_profileId_capture_profiles_id_fk` FOREIGN KEY (`profileId`) REFERENCES `capture_profiles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_matches` ADD CONSTRAINT `capture_matches_opportunityId_capture_opportunities_id_fk` FOREIGN KEY (`opportunityId`) REFERENCES `capture_opportunities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_opportunities` ADD CONSTRAINT `capture_opportunities_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_opportunities` ADD CONSTRAINT `capture_opportunities_sourceId_capture_sources_id_fk` FOREIGN KEY (`sourceId`) REFERENCES `capture_sources`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_opportunity_revisions` ADD CONSTRAINT `capture_revision_opp_fk` FOREIGN KEY (`opportunityId`) REFERENCES `capture_opportunities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_profiles` ADD CONSTRAINT `capture_profiles_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_responses` ADD CONSTRAINT `capture_responses_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_responses` ADD CONSTRAINT `capture_responses_profileId_capture_profiles_id_fk` FOREIGN KEY (`profileId`) REFERENCES `capture_profiles`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_responses` ADD CONSTRAINT `capture_responses_opportunityId_capture_opportunities_id_fk` FOREIGN KEY (`opportunityId`) REFERENCES `capture_opportunities`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_responses` ADD CONSTRAINT `capture_responses_workspaceId_bid_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `bid_workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_runs` ADD CONSTRAINT `capture_runs_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_settings` ADD CONSTRAINT `capture_settings_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `capture_sources` ADD CONSTRAINT `capture_sources_ownerUserId_users_id_fk` FOREIGN KEY (`ownerUserId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `capture_job_queue_idx` ON `capture_jobs` (`ownerUserId`,`status`,`availableAt`);--> statement-breakpoint
CREATE INDEX `capture_match_owner_idx` ON `capture_matches` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `capture_opp_owner_idx` ON `capture_opportunities` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `capture_profile_owner_idx` ON `capture_profiles` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `capture_response_owner_idx` ON `capture_responses` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `capture_run_owner_idx` ON `capture_runs` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `capture_source_owner_idx` ON `capture_sources` (`ownerUserId`);