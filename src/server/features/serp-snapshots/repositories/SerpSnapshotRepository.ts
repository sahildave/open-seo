import { and, desc, eq, lt, inArray, sql } from "drizzle-orm";
import { db } from "@/db";
import { runBatch } from "@/db/runBatch";
import { serpSnapshots } from "@/db/schema";

export type SerpSnapshotRow = typeof serpSnapshots.$inferSelect;
type NewSerpSnapshotRow = typeof serpSnapshots.$inferInsert;

// One row per statement: a row binds 15 parameters and D1 caps a statement at
// ~100, so multi-row inserts would need chunking for no real gain at <=50 rows.
async function insertMany(rows: NewSerpSnapshotRow[]) {
  await runBatch((tx) =>
    rows.map((row) => tx.insert(serpSnapshots).values(row)),
  );
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

async function listForMarket(params: {
  projectId: string;
  locationCode: number;
  languageCode: string;
  days?: string[];
}) {
  if (params.days?.length === 0) return [];
  return db
    .select()
    .from(serpSnapshots)
    .where(
      and(
        eq(serpSnapshots.projectId, params.projectId),
        eq(serpSnapshots.locationCode, params.locationCode),
        eq(serpSnapshots.languageCode, params.languageCode),
        // Captures are UTC ISO strings. At most 50 incoming days bind at once,
        // staying below D1's parameter limit on both database providers.
        params.days
          ? inArray(
              sql<string>`substr(${serpSnapshots.collectedAt}, 1, 10)`,
              params.days,
            )
          : undefined,
      ),
    )
    .orderBy(serpSnapshots.collectedAt, serpSnapshots.id);
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
  listForMarket,
  listLatest,
  getPrevious,
};
