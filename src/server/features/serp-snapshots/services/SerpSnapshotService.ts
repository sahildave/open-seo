import { findOurResult } from "./serpSnapshotPosition";
import type { SerpSnapshotInput } from "@/types/schemas/serpSnapshots";
import { mirrorToRankTracking } from "./mirrorToRankTracking";
import { parseSerpSnapshot, type SerpSnapshot } from "./serpSnapshotParsing";
import { SerpSnapshotRepository } from "../repositories/SerpSnapshotRepository";

type SnapshotProject = {
  id: string;
  domain: string | null;
  locationCode: number;
  languageCode: string;
};

async function ingest(
  project: SnapshotProject,
  snapshots: SerpSnapshotInput[],
) {
  const rows = snapshots.map((snapshot) => ({
    id: crypto.randomUUID(),
    projectId: project.id,
    keyword: snapshot.keyword,
    locationCode: snapshot.locationCode ?? project.locationCode,
    languageCode: snapshot.languageCode ?? project.languageCode,
    device: snapshot.device,
    source: snapshot.source,
    // Normalized to UTC ISO so collected_at orders lexicographically.
    collectedAt: new Date(snapshot.collectedAt).toISOString(),
    organic: JSON.stringify(snapshot.organic),
    paa: JSON.stringify(snapshot.paa),
    related: JSON.stringify(snapshot.related),
    videos: JSON.stringify(snapshot.videos),
    aiOverview: JSON.stringify(snapshot.aiOverview),
    ourPosition:
      findOurResult(project.domain, snapshot.organic)?.position ?? null,
  }));
  await SerpSnapshotRepository.insertMany(rows);
  const mirror = await mirrorToRankTracking(project, rows);
  const inserted = rows.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    collectedAt: row.collectedAt,
    ourPosition: row.ourPosition,
  }));
  return { inserted, mirror };
}

// Compare URLs without the noise Google adds between captures.
function urlKey(url: string) {
  try {
    const parsed = new URL(url);
    const path = parsed.pathname.replace(/\/+$/, "");
    return `${parsed.hostname.replace(/^www\./, "").toLowerCase()}${path}${parsed.search}`;
  } catch {
    return url;
  }
}

function diffSnapshots(current: SerpSnapshot, previous: SerpSnapshot) {
  const before = new Map(
    previous.organic.map((result) => [urlKey(result.url), result]),
  );
  const after = new Map(
    current.organic.map((result) => [urlKey(result.url), result]),
  );
  const previousPaa = new Set(previous.paa);
  return {
    previousSnapshotId: previous.id,
    previousCollectedAt: previous.collectedAt,
    entered: current.organic
      .filter((result) => !before.has(urlKey(result.url)))
      .map(({ url, position }) => ({ url, position })),
    left: previous.organic
      .filter((result) => !after.has(urlKey(result.url)))
      .map(({ url, position }) => ({ url, position })),
    moved: current.organic.flatMap((result) => {
      const old = before.get(urlKey(result.url));
      return old && old.position !== result.position
        ? [{ url: result.url, from: old.position, to: result.position }]
        : [];
    }),
    newPaa: current.paa.filter((question) => !previousPaa.has(question)),
    ourPosition: { from: previous.ourPosition, to: current.ourPosition },
  };
}

async function list(params: {
  projectId: string;
  keyword?: string;
  limit: number;
  diff: boolean;
}) {
  const rows = await SerpSnapshotRepository.listLatest(params);
  return Promise.all(
    rows.map(async (row) => {
      const snapshot = parseSerpSnapshot(row);
      if (!params.diff) return { snapshot, diff: undefined };
      const previous = await SerpSnapshotRepository.getPrevious(row);
      return {
        snapshot,
        // null = first capture for this keyword/device/market; nothing to diff.
        diff: previous
          ? diffSnapshots(snapshot, parseSerpSnapshot(previous))
          : null,
      };
    }),
  );
}

export const SerpSnapshotService = {
  ingest,
  list,
};
