CREATE TABLE `bid_alerts` (
	`id` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`workspaceId` varchar(36),
	`title` varchar(1200) NOT NULL,
	`content` text NOT NULL,
	`read` boolean NOT NULL DEFAULT false,
	`dedupeKey` varchar(190) NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bid_alerts_id` PRIMARY KEY(`id`),
	CONSTRAINT `bid_alerts_dedupe_uq` UNIQUE(`dedupeKey`)
);
--> statement-breakpoint
CREATE TABLE `bid_deadline_schedules` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`taskUid` varchar(128),
	`active` boolean NOT NULL DEFAULT false,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bid_deadline_schedules_id` PRIMARY KEY(`id`),
	CONSTRAINT `bid_deadline_schedules_workspace_uq` UNIQUE(`workspaceId`),
	CONSTRAINT `bid_deadline_schedules_task_uid_uq` UNIQUE(`taskUid`)
);
--> statement-breakpoint
CREATE TABLE `bid_evidence_documents` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`data` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bid_evidence_documents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `bid_workspace_history` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`version` int NOT NULL,
	`authorUserId` int NOT NULL,
	`data` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `bid_workspace_history_id` PRIMARY KEY(`id`),
	CONSTRAINT `bid_workspace_history_workspace_version_uq` UNIQUE(`workspaceId`,`version`)
);
--> statement-breakpoint
CREATE TABLE `bid_workspace_members` (
	`id` int AUTO_INCREMENT NOT NULL,
	`workspaceId` varchar(36) NOT NULL,
	`userId` int NOT NULL,
	`role` enum('owner','editor','reviewer') NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bid_workspace_members_id` PRIMARY KEY(`id`),
	CONSTRAINT `bid_workspace_members_workspace_user_uq` UNIQUE(`workspaceId`,`userId`)
);
--> statement-breakpoint
CREATE TABLE `bid_workspaces` (
	`id` varchar(36) NOT NULL,
	`ownerUserId` int NOT NULL,
	`version` int NOT NULL DEFAULT 1,
	`data` json NOT NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `bid_workspaces_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE INDEX `bid_alerts_user_idx` ON `bid_alerts` (`userId`);--> statement-breakpoint
CREATE INDEX `bid_evidence_documents_owner_idx` ON `bid_evidence_documents` (`ownerUserId`);--> statement-breakpoint
CREATE INDEX `bid_workspace_history_workspace_idx` ON `bid_workspace_history` (`workspaceId`);--> statement-breakpoint
CREATE INDEX `bid_workspace_members_user_idx` ON `bid_workspace_members` (`userId`);--> statement-breakpoint
CREATE INDEX `bid_workspaces_owner_idx` ON `bid_workspaces` (`ownerUserId`);