import { and, asc, eq, inArray } from "drizzle-orm";
import { db } from "@/db";
import {
  savedKeywordTagAssignments,
  savedKeywordTags,
  savedKeywords,
} from "@/db/schema";

const MAX_RANKING_LADDER_QUERIES = 25;

async function listForProject(projectId: string) {
  const rows = await db
    .select({
      keyword: savedKeywords.keyword,
      tagName: savedKeywordTags.normalizedName,
    })
    .from(savedKeywords)
    .innerJoin(
      savedKeywordTagAssignments,
      eq(savedKeywordTagAssignments.savedKeywordId, savedKeywords.id),
    )
    .innerJoin(
      savedKeywordTags,
      and(
        eq(savedKeywordTags.id, savedKeywordTagAssignments.tagId),
        eq(savedKeywordTags.projectId, projectId),
      ),
    )
    .where(
      and(
        eq(savedKeywords.projectId, projectId),
        inArray(savedKeywordTags.normalizedName, [
          "ranking-ladder",
          "ranking-seed",
        ]),
      ),
    )
    .orderBy(
      asc(savedKeywords.createdAt),
      asc(savedKeywords.id),
      asc(savedKeywordTags.normalizedName),
    );

  const queries: string[] = [];
  const seeds: string[] = [];
  const seenQueries = new Set<string>();
  const seenSeeds = new Set<string>();
  for (const row of rows) {
    if (row.tagName === "ranking-ladder" && !seenQueries.has(row.keyword)) {
      seenQueries.add(row.keyword);
      queries.push(row.keyword);
    }
    if (row.tagName === "ranking-seed" && !seenSeeds.has(row.keyword)) {
      seenSeeds.add(row.keyword);
      seeds.push(row.keyword);
    }
  }

  return {
    queries: queries.slice(0, MAX_RANKING_LADDER_QUERIES),
    seeds: seeds.slice(0, MAX_RANKING_LADDER_QUERIES),
  };
}

export const RankingLadderQueryRepository = { listForProject } as const;
