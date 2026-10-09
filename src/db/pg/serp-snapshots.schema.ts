import { sql } from "drizzle-orm";
import { index, integer, pgTable, text } from "drizzle-orm/pg-core";
import { projects } from "./app.schema";

// Timestamps are text, matching the SQLite schema; see pg/app.schema.ts.
const isoNow = sql`to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

// Mirror of ../serp-snapshots.schema.ts; see the comments there.
export const serpSnapshots = pgTable(
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
    organic: text("organic").notNull(),
    paa: text("paa").notNull(),
    related: text("related").notNull(),
    videos: text("videos").notNull(),
    aiOverview: text("ai_overview").notNull(),
    ourPosition: integer("our_position"),
    createdAt: text("created_at").notNull().default(isoNow),
  },
  (table) => [
    index("serp_snapshots_project_keyword_collected_idx").on(
      table.projectId,
      table.keyword,
      table.collectedAt,
    ),
  ],
);
