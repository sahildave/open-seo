CREATE TABLE `serp_snapshots` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`keyword` text NOT NULL,
	`location_code` integer NOT NULL,
	`language_code` text NOT NULL,
	`device` text NOT NULL,
	`source` text NOT NULL,
	`collected_at` text NOT NULL,
	`organic` text NOT NULL,
	`paa` text NOT NULL,
	`related` text NOT NULL,
	`videos` text NOT NULL,
	`ai_overview` text NOT NULL,
	`our_position` integer,
	`created_at` text DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')) NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `serp_snapshots_project_keyword_collected_idx` ON `serp_snapshots` (`project_id`,`keyword`,`collected_at`);