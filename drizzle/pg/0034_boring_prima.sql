CREATE TABLE "serp_video_transcripts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"video_id" text NOT NULL,
	"transcript" text NOT NULL,
	"language" text,
	"fetched_at" text NOT NULL,
	"created_at" text DEFAULT to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') NOT NULL
);
--> statement-breakpoint
ALTER TABLE "serp_video_transcripts" ADD CONSTRAINT "serp_video_transcripts_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "serp_video_transcripts_project_video_idx" ON "serp_video_transcripts" USING btree ("project_id","video_id");