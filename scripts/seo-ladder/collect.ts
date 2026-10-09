import { execFile as execFileCallback, spawn } from "node:child_process";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { mkdtemp, readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { z } from "zod";
import {
  parseGoogleSerp,
  type ParsedSerp,
} from "../../src/server/features/serp-snapshots/parser/parseGoogleSerp";
import {
  ingestSerpSnapshotsBodySchema,
  type SerpSnapshotInput,
  type SerpVideoTranscriptInput,
} from "../../src/types/schemas/serpSnapshots";

const execFile = promisify(execFileCallback);
const MAX_QUERIES = 25;
const AUTOCOMPLETE_COOLDOWN_MS = 60 * 60 * 1000;
const GOOGLE_SUGGEST_URL = "https://suggestqueries.google.com/complete/search";

const savedPageMetaSchema = z
  .object({
    query: z.string().trim().min(1),
    collectedAt: z.iso.datetime({ offset: true }).optional(),
    capturedAt: z.iso.datetime({ offset: true }).optional(),
    finalUrl: z.string().url().optional(),
    url: z.string().url().optional(),
  })
  .refine((meta) => meta.collectedAt ?? meta.capturedAt, {
    message: "metadata must include collectedAt or capturedAt",
  });

const trackedQueriesResponseSchema = z.object({
  project: z.object({
    id: z.string(),
    domain: z.string().nullable(),
    locationCode: z.number().int(),
    languageCode: z.string(),
  }),
  queries: z.array(z.string()),
  seeds: z.array(z.string()),
});

const autocompleteResponseSchema = z.tuple([z.string(), z.array(z.string())]);

type SavedPage = {
  html: string;
  meta: z.infer<typeof savedPageMetaSchema>;
};

export type CollectBatch = {
  projectId: string;
  snapshots: SerpSnapshotInput[];
  transcripts: SerpVideoTranscriptInput[];
};

export type TranscriptExec = (
  command: string,
  args: readonly string[],
) => Promise<{ stdout: string }>;

class CollectorError extends Error {
  constructor(
    readonly exitCode: 2 | 3 | 4,
    message: string,
  ) {
    super(message);
  }
}

function parseCliArgs(argv: string[]) {
  let projectId: string | undefined;
  let fromDir: string | undefined;
  let dryRun = false;
  let autocomplete = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--project") {
      projectId = argv[index + 1];
      index += 1;
    } else if (arg === "--from-dir") {
      fromDir = argv[index + 1];
      index += 1;
    } else if (arg === "--dry-run") {
      dryRun = true;
    } else if (arg === "--autocomplete") {
      autocomplete = true;
    } else {
      throw new CollectorError(4, `Unknown argument: ${arg}`);
    }
  }

  if (!projectId) throw new CollectorError(4, "--project is required");
  if (fromDir && autocomplete) {
    throw new CollectorError(
      4,
      "--from-dir and --autocomplete cannot be combined",
    );
  }
  if (dryRun && !fromDir) {
    throw new CollectorError(4, "--dry-run requires --from-dir");
  }
  return { projectId, fromDir, dryRun, autocomplete };
}

async function readSavedPages(directory: string): Promise<SavedPage[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const metaFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".meta.json"))
    .map((entry) => entry.name);
  const pages: SavedPage[] = [];

  for (const metaFile of metaFiles) {
    const stem = metaFile.slice(0, -".meta.json".length);
    const htmlPath = join(directory, `${stem}.html`);
    const rawMeta: unknown = JSON.parse(
      await readFile(join(directory, metaFile), "utf8"),
    );
    const parsedMeta = savedPageMetaSchema.safeParse(rawMeta);
    if (!parsedMeta.success) {
      throw new CollectorError(4, `Invalid metadata: ${metaFile}`);
    }
    pages.push({
      html: await readFile(htmlPath, "utf8"),
      meta: parsedMeta.data,
    });
  }
  return pages.sort((left, right) => {
    const leftTime = left.meta.collectedAt ?? left.meta.capturedAt;
    const rightTime = right.meta.collectedAt ?? right.meta.capturedAt;
    return Date.parse(leftTime ?? "") - Date.parse(rightTime ?? "");
  });
}

function youtubeVideoId(url: string) {
  try {
    const parsed = new URL(url);
    if (parsed.hostname === "youtu.be") {
      return parsed.pathname.slice(1).split("/")[0] || null;
    }
    if (!/(^|\.)youtube\.com$/i.test(parsed.hostname)) return null;
    if (parsed.pathname === "/watch") return parsed.searchParams.get("v");
    const parts = parsed.pathname.split("/").filter(Boolean);
    return parts[0] === "shorts" || parts[0] === "embed"
      ? (parts[1] ?? null)
      : null;
  } catch {
    return null;
  }
}

function isSorryUrl(value: string | undefined) {
  return value ? /\/sorry(?:[/?#]|$)/i.test(value) : false;
}

function pageToSnapshot(page: SavedPage) {
  if (isSorryUrl(page.meta.finalUrl ?? page.meta.url)) {
    return { kind: "blocked" as const, reason: "sorry" as const };
  }

  const parsed: ParsedSerp = parseGoogleSerp(page.html);
  if (parsed.kind === "blocked") return parsed;
  const collectedAt = page.meta.collectedAt ?? page.meta.capturedAt;
  if (!collectedAt)
    return { kind: "blocked" as const, reason: "sorry" as const };

  return {
    kind: "results" as const,
    snapshot: {
      keyword: page.meta.query,
      device: "desktop" as const,
      source: "ego-browser",
      collectedAt,
      organic: parsed.organic,
      paa: parsed.paa,
      related: parsed.related,
      videos: parsed.videos,
      aiOverview: parsed.aiOverview,
    } satisfies SerpSnapshotInput,
  };
}

export function buildBatchFromPages(
  projectId: string,
  pages: SavedPage[],
): { batch: CollectBatch; blocked: boolean } {
  const snapshots: SerpSnapshotInput[] = [];
  let blocked = false;
  for (const page of pages) {
    const result = pageToSnapshot(page);
    if (result.kind === "blocked") {
      blocked = true;
      break;
    }
    snapshots.push(result.snapshot);
  }

  const batch: CollectBatch = { projectId, snapshots, transcripts: [] };
  if (snapshots.length > 0) {
    const validated = ingestSerpSnapshotsBodySchema.safeParse(batch);
    if (!validated.success) {
      throw new CollectorError(
        4,
        "Collector produced an invalid snapshot batch",
      );
    }
    return { batch: validated.data, blocked };
  }
  return { batch, blocked };
}

export async function collectFromDirectory(
  directory: string,
  projectId: string,
): Promise<{ batch: CollectBatch; blocked: boolean }> {
  return buildBatchFromPages(projectId, await readSavedPages(directory));
}

async function defaultTranscriptExec(
  command: string,
  args: readonly string[],
): Promise<{ stdout: string }> {
  const result = await execFile(command, [...args]);
  return { stdout: result.stdout };
}

export async function fetchTranscript(
  videoId: string,
  execTranscript: TranscriptExec = defaultTranscriptExec,
) {
  try {
    const result = await execTranscript("uvx", [
      "--from",
      "youtube-transcript-api",
      "youtube_transcript_api",
      videoId,
      "--format",
      "text",
    ]);
    const text = result.stdout.trim();
    return text || null;
  } catch {
    return null;
  }
}

export async function fetchTranscripts(
  snapshots: SerpSnapshotInput[],
  execTranscript: TranscriptExec = defaultTranscriptExec,
): Promise<{ transcripts: SerpVideoTranscriptInput[]; skipped: number }> {
  const videoIds = [
    ...new Set(
      snapshots.flatMap((snapshot) =>
        snapshot.videos.flatMap((video) => {
          const id = youtubeVideoId(video.url);
          return id ? [id] : [];
        }),
      ),
    ),
  ];
  const transcripts: SerpVideoTranscriptInput[] = [];
  let skipped = 0;
  for (const videoId of videoIds) {
    const text = await fetchTranscript(videoId, execTranscript);
    if (!text) {
      skipped += 1;
      continue;
    }
    transcripts.push({
      videoId,
      text,
      fetchedAt: new Date().toISOString(),
    });
  }
  return { transcripts, skipped };
}

function authHeaders() {
  const headers = new Headers({ "content-type": "application/json" });
  const serviceToken = process.env.OPENSEO_SERVICE_TOKEN;
  if (serviceToken) headers.set("authorization", `Bearer ${serviceToken}`);
  const accessToken = process.env.CF_ACCESS_TOKEN;
  if (accessToken) headers.set("cf-access-token", accessToken);
  const accessClientId = process.env.CF_ACCESS_CLIENT_ID;
  const accessClientSecret = process.env.CF_ACCESS_CLIENT_SECRET;
  if (accessClientId && accessClientSecret) {
    headers.set("cf-access-client-id", accessClientId);
    headers.set("cf-access-client-secret", accessClientSecret);
  }
  return headers;
}

function baseUrl() {
  return (process.env.OPENSEO_URL ?? "http://localhost:3001").replace(
    /\/$/,
    "",
  );
}

async function fetchTrackedQueries(projectId: string) {
  let response: Response;
  try {
    response = await fetch(
      `${baseUrl()}/api/ranking-ladder/queries?projectId=${encodeURIComponent(projectId)}`,
      { headers: authHeaders() },
    );
  } catch {
    throw new CollectorError(
      4,
      "OpenSEO was unreachable while reading tracked queries",
    );
  }
  if (!response.ok) {
    throw new CollectorError(
      4,
      `OpenSEO returned ${response.status} for tracked queries`,
    );
  }
  const raw: unknown = await response.json();
  const parsed = trackedQueriesResponseSchema.safeParse(raw);
  if (!parsed.success)
    throw new CollectorError(4, "OpenSEO returned invalid tracked queries");
  return parsed.data;
}

async function postBatch(batch: CollectBatch) {
  let response: Response;
  try {
    response = await fetch(`${baseUrl()}/api/serp-snapshots`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify(batch),
    });
  } catch {
    throw new CollectorError(
      4,
      "OpenSEO was unreachable while posting snapshots",
    );
  }
  if (!response.ok) {
    throw new CollectorError(
      4,
      `OpenSEO returned ${response.status} while posting snapshots`,
    );
  }
}

type DriverResult = { blocked: boolean };

async function runDriver(
  runDir: string,
  queries: string[],
): Promise<DriverResult> {
  const driverPath = fileURLToPath(
    new URL("./ego-driver.mjs", import.meta.url),
  );
  const args = ["nodejs", driverPath, "--run-dir", runDir];
  for (const query of queries.slice(0, MAX_QUERIES))
    args.push("--query", query);

  return new Promise((resolveDriver, rejectDriver) => {
    const child = spawn("ego-browser", args, {
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });
    child.once("error", () => {
      rejectDriver(new CollectorError(3, "EgoLite was unreachable"));
    });
    child.once("close", (code) => {
      if (code === 0 || code === 2) {
        resolveDriver({ blocked: code === 2 });
        return;
      }
      rejectDriver(
        new CollectorError(3, stderr.trim() || "EgoLite collection failed"),
      );
    });
  });
}

async function recordSearchPass() {
  const path = join(homedir(), ".cache", "seo-ladder", "last-pass");
  try {
    await mkdir(join(homedir(), ".cache", "seo-ladder"), { recursive: true });
    await writeFile(path, `${Date.now()}\n`, "utf8");
  } catch {
    // A cache timestamp is a guardrail, not a reason to discard a collected batch.
  }
}

async function readLastSearchPass() {
  const path = join(homedir(), ".cache", "seo-ladder", "last-pass");
  try {
    const value = Number.parseInt(await readFile(path, "utf8"), 10);
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

async function runAutocomplete(projectId: string) {
  const lastPass = await readLastSearchPass();
  if (lastPass !== null && Date.now() - lastPass < AUTOCOMPLETE_COOLDOWN_MS) {
    throw new CollectorError(
      4,
      "Autocomplete is unavailable within 60 minutes of the last search pass",
    );
  }
  const tracked = await fetchTrackedQueries(projectId);
  const suggestions: Array<{ seed: string; suggestions: string[] }> = [];
  for (const seed of tracked.seeds.slice(0, MAX_QUERIES)) {
    const url = `${GOOGLE_SUGGEST_URL}?client=firefox&q=${encodeURIComponent(seed)}`;
    try {
      const response = await fetch(url);
      if (!response.ok) continue;
      const raw: unknown = await response.json();
      const parsed = autocompleteResponseSchema.safeParse(raw);
      if (parsed.success)
        suggestions.push({ seed, suggestions: parsed.data[1] });
    } catch {
      // One suggestion endpoint failure does not erase the other seeds.
    }
  }
  const runDir = await mkdtemp(join(tmpdir(), "seo-ladder-autocomplete-"));
  await writeFile(
    join(runDir, "autocomplete.json"),
    JSON.stringify(
      { projectId, collectedAt: new Date().toISOString(), suggestions },
      null,
      2,
    ),
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ runDir, projectId, suggestions }, null, 2)}\n`,
  );
  return 0;
}

async function runLive(projectId: string) {
  const tracked = await fetchTrackedQueries(projectId);
  const runDir = await mkdtemp(join(tmpdir(), "seo-ladder-"));
  let driver: DriverResult;
  try {
    driver = await runDriver(runDir, tracked.queries.slice(0, MAX_QUERIES));
  } catch (error) {
    if (error instanceof CollectorError) throw error;
    throw new CollectorError(3, "EgoLite was unreachable");
  }
  await recordSearchPass();

  const collected = await collectFromDirectory(runDir, projectId);
  const transcriptResult = await fetchTranscripts(collected.batch.snapshots);
  const batch: CollectBatch = {
    ...collected.batch,
    transcripts: transcriptResult.transcripts,
  };
  if (batch.snapshots.length > 0) await postBatch(batch);
  await writeFile(
    join(runDir, "run.log.json"),
    JSON.stringify(
      {
        projectId,
        collectedAt: new Date().toISOString(),
        snapshots: batch.snapshots.length,
        transcripts: batch.transcripts.length,
        transcriptFailures: transcriptResult.skipped,
        blocked: driver.blocked || collected.blocked,
      },
      null,
      2,
    ),
    "utf8",
  );
  process.stdout.write(
    `Collected ${batch.snapshots.length} snapshot(s); skipped ${transcriptResult.skipped} transcript(s).\n`,
  );
  return driver.blocked || collected.blocked ? 2 : 0;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    const args = parseCliArgs(argv);
    if (args.autocomplete) return await runAutocomplete(args.projectId);
    if (args.fromDir) {
      const result = await collectFromDirectory(args.fromDir, args.projectId);
      if (args.dryRun) {
        process.stdout.write(`${JSON.stringify(result.batch, null, 2)}\n`);
      } else if (result.batch.snapshots.length > 0) {
        const transcriptResult = await fetchTranscripts(result.batch.snapshots);
        await postBatch({
          ...result.batch,
          transcripts: transcriptResult.transcripts,
        });
      }
      if (result.blocked) {
        console.error("Collection stopped at a Google CAPTCHA or sorry page.");
        return 2;
      }
      return 0;
    }
    return await runLive(args.projectId);
  } catch (error) {
    if (error instanceof CollectorError) {
      console.error(error.message);
      return error.exitCode;
    }
    console.error(error instanceof Error ? error.message : "Collection failed");
    return 4;
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  process.exitCode = await main();
}
