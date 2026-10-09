import { safeHostname } from "@/shared/safe-url";
import type {
  SerpSnapshotInput,
  SerpVideoTranscriptInput,
} from "@/types/schemas/serpSnapshots";
import {
  SerpSnapshotRepository,
  type SerpVideoTranscriptRow,
  type SerpSnapshotRow,
} from "../repositories/SerpSnapshotRepository";

type SnapshotProject = {
  id: string;
  domain: string | null;
  locationCode: number;
  languageCode: string;
};

type OrganicResult = SerpSnapshotInput["organic"][number];
type SnapshotVideo = SerpSnapshotInput["videos"][number];
type AttachedTranscript = {
  videoId: string;
  text: string;
  language: string | null;
  fetchedAt: string;
};

function bareHost(value: string) {
  const withProtocol = /^[a-z][a-z\d+.-]*:\/\//i.test(value)
    ? value
    : `https://${value}`;
  return safeHostname(withProtocol.trim().toLowerCase());
}

// Best organic position of the project's domain (subdomains count), or null
// when the project has no domain or does not rank in the captured results.
function findOurPosition(domain: string | null, organic: OrganicResult[]) {
  const ours = domain ? bareHost(domain) : null;
  if (!ours) return null;
  const positions = organic
    .filter((result) => {
      const host = bareHost(result.url);
      return host === ours || host?.endsWith(`.${ours}`);
    })
    .map((result) => result.position);
  return positions.length > 0 ? Math.min(...positions) : null;
}

async function ingest(
  project: SnapshotProject,
  snapshots: SerpSnapshotInput[],
  transcripts: SerpVideoTranscriptInput[] = [],
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
    ourPosition: findOurPosition(project.domain, snapshot.organic),
  }));
  await SerpSnapshotRepository.insertMany(rows);
  await SerpSnapshotRepository.insertTranscripts(
    transcripts.map((transcript) => ({
      id: crypto.randomUUID(),
      projectId: project.id,
      videoId: transcript.videoId,
      transcript: transcript.text,
      language: transcript.language ?? null,
      fetchedAt: new Date(transcript.fetchedAt).toISOString(),
    })),
  );
  return rows.map((row) => ({
    id: row.id,
    keyword: row.keyword,
    collectedAt: row.collectedAt,
    ourPosition: row.ourPosition,
  }));
}

function parseRow(row: SerpSnapshotRow) {
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

export type SerpSnapshot = Omit<ReturnType<typeof parseRow>, "videos"> & {
  videos: Array<SnapshotVideo & { transcript?: AttachedTranscript }>;
};

function videoIdFromUrl(url: string) {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === "youtu.be") {
      return parsed.pathname.slice(1).split("/")[0] || null;
    }
    if (!/(^|\.)youtube\.com$/.test(hostname)) return null;
    if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[0] === "shorts" || parts[0] === "embed"
      ? (parts[1] ?? null)
      : null;
  } catch {
    return null;
  }
}

function attachTranscripts(
  snapshot: ReturnType<typeof parseRow>,
  transcripts: Map<string, SerpVideoTranscriptRow>,
): SerpSnapshot {
  return {
    ...snapshot,
    videos: snapshot.videos.map((video) => {
      const videoId = videoIdFromUrl(video.url);
      const transcript = videoId ? transcripts.get(videoId) : undefined;
      if (!transcript) return video;
      const attached: AttachedTranscript = {
        videoId: transcript.videoId,
        text: transcript.transcript,
        language: transcript.language,
        fetchedAt: transcript.fetchedAt,
      };
      return { ...video, transcript: attached };
    }),
  };
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

export type SerpSnapshotDiff = ReturnType<typeof diffSnapshots>;

async function list(params: {
  projectId: string;
  keyword?: string;
  limit: number;
  diff: boolean;
  includeTranscripts?: boolean;
}) {
  const rows = await SerpSnapshotRepository.listLatest(params);
  const parsedRows = rows.map((row) => ({ row, snapshot: parseRow(row) }));
  const transcriptMap = params.includeTranscripts
    ? await SerpSnapshotRepository.listTranscripts(
        params.projectId,
        parsedRows.flatMap(({ snapshot }) =>
          snapshot.videos.flatMap((video) => {
            const videoId = videoIdFromUrl(video.url);
            return videoId ? [videoId] : [];
          }),
        ),
      )
    : new Map<string, SerpVideoTranscriptRow>();

  return Promise.all(
    parsedRows.map(async ({ row, snapshot: parsedSnapshot }) => {
      const snapshot = params.includeTranscripts
        ? attachTranscripts(parsedSnapshot, transcriptMap)
        : parsedSnapshot;
      if (!params.diff) return { snapshot, diff: undefined };
      const previous = await SerpSnapshotRepository.getPrevious(row);
      return {
        snapshot,
        // null = first capture for this keyword/device/market; nothing to diff.
        diff: previous ? diffSnapshots(snapshot, parseRow(previous)) : null,
      };
    }),
  );
}

export const SerpSnapshotService = {
  ingest,
  list,
};
