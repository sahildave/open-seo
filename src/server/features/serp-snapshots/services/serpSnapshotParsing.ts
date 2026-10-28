import type { SerpSnapshotRow } from "../repositories/SerpSnapshotRepository";
import type { SerpSnapshotInput } from "@/types/schemas/serpSnapshots";
type OrganicResult = SerpSnapshotInput["organic"][number];

export function parseSerpSnapshot(row: SerpSnapshotRow) {
  return {
    id: row.id,
    keyword: row.keyword,
    locationCode: row.locationCode,
    languageCode: row.languageCode,
    device: row.device,
    source: row.source,
    collectedAt: row.collectedAt,
    ourPosition: row.ourPosition,
    // Written by ingest() from validated input, so the shapes are known.
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    organic: JSON.parse(row.organic) as OrganicResult[],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    paa: JSON.parse(row.paa) as string[],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    related: JSON.parse(row.related) as string[],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    videos: JSON.parse(row.videos) as SerpSnapshotInput["videos"],
    // oxlint-disable-next-line typescript/no-unsafe-type-assertion -- see above
    aiOverview: JSON.parse(row.aiOverview) as SerpSnapshotInput["aiOverview"],
  };
}

export type SerpSnapshot = ReturnType<typeof parseSerpSnapshot>;
