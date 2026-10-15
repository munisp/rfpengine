CREATE TABLE `fixed_bid_audit` (
	`id` varchar(36) NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`baselineId` varchar(36) NOT NULL,
	`caseId` varchar(36),
	`actorId` int NOT NULL,
	`action` enum('BASELINE_CREATED','BASELINE_REVISED','CASE_SAVED') NOT NULL,
	`reason` text NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fixed_bid_audit_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `fixed_bid_baselines` (
	`id` varchar(36) NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`seriesId` varchar(36) NOT NULL,
	`revision` int NOT NULL,
	`previousId` varchar(36),
	`name` varchar(160) NOT NULL,
	`bidPrice` decimal(18,2) NOT NULL,
	`labor` decimal(18,2) NOT NULL,
	`other` decimal(18,2) NOT NULL,
	`overheadBps` int NOT NULL,
	`minimumMarginBps` int NOT NULL,
	`currency` varchar(3) NOT NULL,
	`periodStart` varchar(10) NOT NULL,
	`periodEnd` varchar(10) NOT NULL,
	`assumptions` text NOT NULL,
	`revisionReason` text,
	`requestKey` varchar(80) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fixed_bid_baselines_id` PRIMARY KEY(`id`),
	CONSTRAINT `fixed_bid_series_revision_uq` UNIQUE(`seriesId`,`revision`),
	CONSTRAINT `fixed_bid_request_uq` UNIQUE(`workspaceId`,`requestKey`)
);
--> statement-breakpoint
CREATE TABLE `fixed_bid_cases` (
	`id` varchar(36) NOT NULL,
	`baselineId` varchar(36) NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`name` varchar(160) NOT NULL,
	`laborChangeBps` int NOT NULL,
	`otherChangeBps` int NOT NULL,
	`overheadChangeBps` int NOT NULL,
	`extraCost` decimal(18,2) NOT NULL,
	`rationale` text NOT NULL,
	`result` json NOT NULL,
	`requestKey` varchar(80) NOT NULL,
	`requestHash` varchar(64) NOT NULL,
	`createdBy` int NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `fixed_bid_cases_id` PRIMARY KEY(`id`),
	CONSTRAINT `fixed_case_request_uq` UNIQUE(`workspaceId`,`requestKey`)
);
--> statement-breakpoint
ALTER TABLE `fixed_bid_audit` ADD CONSTRAINT `fixed_bid_audit_workspaceId_bid_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `bid_workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixed_bid_audit` ADD CONSTRAINT `fixed_bid_audit_baselineId_fixed_bid_baselines_id_fk` FOREIGN KEY (`baselineId`) REFERENCES `fixed_bid_baselines`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixed_bid_audit` ADD CONSTRAINT `fixed_bid_audit_actorId_users_id_fk` FOREIGN KEY (`actorId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixed_bid_baselines` ADD CONSTRAINT `fixed_bid_baselines_workspaceId_bid_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `bid_workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixed_bid_baselines` ADD CONSTRAINT `fixed_bid_baselines_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixed_bid_cases` ADD CONSTRAINT `fixed_bid_cases_baselineId_fixed_bid_baselines_id_fk` FOREIGN KEY (`baselineId`) REFERENCES `fixed_bid_baselines`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixed_bid_cases` ADD CONSTRAINT `fixed_bid_cases_workspaceId_bid_workspaces_id_fk` FOREIGN KEY (`workspaceId`) REFERENCES `bid_workspaces`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `fixed_bid_cases` ADD CONSTRAINT `fixed_bid_cases_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `fixed_audit_baseline_idx` ON `fixed_bid_audit` (`baselineId`);--> statement-breakpoint
CREATE INDEX `fixed_bid_workspace_idx` ON `fixed_bid_baselines` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `fixed_case_baseline_idx` ON `fixed_bid_cases` (`baselineId`);