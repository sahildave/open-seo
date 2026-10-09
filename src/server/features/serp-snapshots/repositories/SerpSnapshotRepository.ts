import { and, desc, eq, inArray, lt } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { serpSnapshots, serpVideoTranscripts } from "@/db/schema";

export type SerpSnapshotRow = typeof serpSnapshots.$inferSelect;
type NewSerpSnapshotRow = typeof serpSnapshots.$inferInsert;
type NewSerpVideoTranscriptRow = typeof serpVideoTranscripts.$inferInsert;

export type SerpVideoTranscriptRow = typeof serpVideoTranscripts.$inferSelect;

// One row per statement: a row binds 15 parameters and D1 caps a statement at
// ~100, so multi-row inserts would need chunking for no real gain at <=50 rows.
async function insertMany(rows: NewSerpSnapshotRow[]) {
  await runBatch((tx) =>
    rows.map((row) => tx.insert(serpSnapshots).values(row)),
  );
}

async function insertTranscripts(rows: NewSerpVideoTranscriptRow[]) {
  if (rows.length === 0) return;
  await runBatch((tx) =>
    rows.map((row) =>
      tx.insert(serpVideoTranscripts).values(row).onConflictDoNothing(),
    ),
  );
}

async function listTranscripts(projectId: string, videoIds: string[]) {
  if (videoIds.length === 0) return new Map<string, SerpVideoTranscriptRow>();

  const rows = await db
    .select()
    .from(serpVideoTranscripts)
    .where(
      and(
        eq(serpVideoTranscripts.projectId, projectId),
        inArray(serpVideoTranscripts.videoId, [...new Set(videoIds)]),
      ),
    );
  return new Map(rows.map((row) => [row.videoId, row]));
}

async function listLatest(params: {
  projectId: string;
  keyword?: string;
  limit: number;
}) {
  return db
    .select()
    .from(serpSnapshots)
    .where(
      and(
        eq(serpSnapshots.projectId, params.projectId),
        params.keyword === undefined
          ? undefined
          : eq(serpSnapshots.keyword, params.keyword),
      ),
    )
    .orderBy(desc(serpSnapshots.collectedAt), desc(serpSnapshots.id))
    .limit(params.limit);
}

// The snapshot collected immediately before `row` for the same keyword,
// device and market — the baseline a diff compares against.
async function getPrevious(row: SerpSnapshotRow) {
  const [previous] = await db
    .select()
    .from(serpSnapshots)
    .where(
      and(
        eq(serpSnapshots.projectId, row.projectId),
        eq(serpSnapshots.keyword, row.keyword),
        eq(serpSnapshots.device, row.device),
        eq(serpSnapshots.locationCode, row.locationCode),
        eq(serpSnapshots.languageCode, row.languageCode),
        lt(serpSnapshots.collectedAt, row.collectedAt),
      ),
    )
    .orderBy(desc(serpSnapshots.collectedAt))
    .limit(1);
  return previous ?? null;
}

export const SerpSnapshotRepository = {
  insertMany,
  insertTranscripts,
  listTranscripts,
  listLatest,
  getPrevious,
};
