import {
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { projects } from "./app.schema";

// Externally collected Google SERP snapshots (e.g. a browser-driven collector
// on the owner's machine), pushed in through MCP or POST /api/serp-snapshots.
// Each row is one keyword's results page as captured at collectedAt, kept
// whole so later snapshots can be diffed against it. The list-shaped fields
// are JSON text: a snapshot is an immutable capture, never queried by its
// parts.
export const serpSnapshots = sqliteTable(
  "serp_snapshots",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    keyword: text("keyword").notNull(),
    locationCode: integer("location_code").notNull(),
    languageCode: text("language_code").notNull(),
    device: text("device", { enum: ["desktop", "mobile"] }).notNull(),
    source: text("source").notNull(),
    collectedAt: text("collected_at").notNull(),
    organic: text("organic").notNull(), // JSON [{position,title,url,snippet?}]
    paa: text("paa").notNull(), // JSON string[]
    related: text("related").notNull(), // JSON string[]
    videos: text("videos").notNull(), // JSON [{title,url,channel?,position?}]
    aiOverview: text("ai_overview").notNull(), // JSON {present,excerpt?,citedUrls?}
    // The project domain's best organic position at ingest; null = absent.
    ourPosition: integer("our_position"),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    index("serp_snapshots_project_keyword_collected_idx").on(
      table.projectId,
      table.keyword,
      table.collectedAt,
    ),
  ],
);

// One transcript is shared by every snapshot that contains the same YouTube
// video for a project. The collector may retry a batch, so the project/video
// key is the idempotency boundary for transcript inserts.
export const serpVideoTranscripts = sqliteTable(
  "serp_video_transcripts",
  {
    id: text("id").primaryKey(),
    projectId: text("project_id")
      .notNull()
      .references(() => projects.id, { onDelete: "cascade" }),
    videoId: text("video_id").notNull(),
    transcript: text("transcript").notNull(),
    language: text("language"),
    fetchedAt: text("fetched_at").notNull(),
    createdAt: text("created_at")
      .notNull()
      .default(sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`),
  },
  (table) => [
    uniqueIndex("serp_video_transcripts_project_video_idx").on(
      table.projectId,
      table.videoId,
    ),
  ],
);
