CREATE TABLE `serp_video_transcripts` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`video_id` text NOT NULL,
	`transcript` text NOT NULL,
	`language` text,
	`fetched_at` text NOT NULL,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `serp_video_transcripts_project_video_idx` ON `serp_video_transcripts` (`project_id`,`video_id`);