/**
 * Push a ranking-ladder run's SERP captures (the JSON files the EgoLite
 * collector leaves in ~/.cache/<product>-seo/<date>/) into a deployed OpenSEO
 * through POST /api/serp-snapshots.
 *
 * Usage:
 *   pnpm tsx scripts/ingest-serp-cache.ts --project <id> --dir <run dir> [--dry-run]
 *
 * Reads <dir>/serp-*.json and <dir>/new/serp-new-*.json (both collector
 * shapes). --dry-run validates against the ingest schema and prints what would
 * be sent and what is dropped; nothing leaves the machine.
 *
 * Env for a real push:
 *   OPENSEO_URL                       e.g. https://open-seo-selfhost.<sub>.workers.dev
 *   CF_ACCESS_CLIENT_ID/_SECRET       an Access service token (non-interactive), or
 *   CF_ACCESS_TOKEN                   output of `cloudflared access token -app $OPENSEO_URL`
 */

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import process from "node:process";
import {
  ingestSerpSnapshotsBodySchema,
  type SerpSnapshotInput,
} from "../src/types/schemas/serpSnapshots";
import { parseArgs } from "./cli-utils";

type Raw = Record<string, any>;

// Collector fields the snapshot schema has no column for. Listed on every run
// so nothing is dropped silently.
const DROPPED = [
  "n, finalUrl / results_url / hasSearchUrl, captcha (run metadata)",
  "gitsuInTop10 / gitsu_in_organic (the server recomputes our position from organic)",
  "organic[].domain (derivable from url)",
  "aiOverviewMentionsGitsu / ai_overview.names_gitsu (no column: AI Overview naming the product)",
  "ai_overview.product_names_seen / names_any_product_hint",
  "videos[].domain, videos[].text (channel is parsed out of text when present)",
  "note / videosNote (collector caveats)",
  "related on tracked files: Google's tab bar (AI Mode, Videos, ...), not related searches",
];

function readJson(path: string): Raw {
  return JSON.parse(readFileSync(path, "utf8"));
}

function listFiles(dir: string, pattern: RegExp) {
  try {
    return readdirSync(dir)
      .filter((name) => pattern.test(name))
      .sort((a, b) => a.localeCompare(b, "en", { numeric: true }))
      .map((name) => join(dir, name));
  } catch {
    return [];
  }
}

const isDuration = (text: string) => /^\d{1,2}(:\d{2}){1,2}$/u.test(text);

// The collector lists one video several times (thumbnail, title, duration).
// Keep one entry per URL, the first real title, and the channel from the
// "YouTube · <channel>" line when the card text carries it.
function mapVideos(raw: Raw[]): SerpSnapshotInput["videos"] {
  const byUrl = new Map<string, SerpSnapshotInput["videos"][number]>();
  for (const video of raw) {
    const title = String(video.title ?? "").trim();
    const channel =
      /YouTube · ([^\n]+)/u.exec(String(video.text ?? ""))?.[1]?.trim() ?? null;
    const existing = byUrl.get(video.url);
    if (!existing) {
      byUrl.set(video.url, {
        url: video.url,
        title: isDuration(title) ? "" : title,
        channel,
        position: video.position ?? byUrl.size + 1,
      });
      continue;
    }
    if (!existing.title && title && !isDuration(title)) existing.title = title;
    existing.channel ??= channel;
  }
  return [...byUrl.values()];
}

function toSnapshot(raw: Raw, tracked: boolean): SerpSnapshotInput {
  const aiOverview = raw.ai_overview ?? {};
  return {
    keyword: raw.query,
    device: "desktop",
    source: "ego-browser",
    collectedAt: raw.readAt ?? raw.collected_at,
    organic: raw.organic.map((result: Raw) => ({
      position: result.position,
      title: result.title,
      url: result.url,
    })),
    paa: raw.paa.filter(
      (q: unknown) => typeof q === "string" && q.trim().length > 0,
    ),
    related: tracked ? [] : raw.related,
    videos: mapVideos(raw.videos),
    aiOverview: {
      present: Boolean(raw.aiOverviewPresent ?? aiOverview.present),
      excerpt: aiOverview.text ?? null,
    },
  } as SerpSnapshotInput;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (!args.project || !args.dir) {
    console.error("Usage: --project <id> --dir <run dir> [--dry-run]");
    process.exit(2);
  }

  const tracked = listFiles(args.dir, /^serp-\d+\.json$/u).map((f) =>
    toSnapshot(readJson(f), true),
  );
  const added = listFiles(join(args.dir, "new"), /^serp-new-\d+\.json$/u).map(
    (f) => toSnapshot(readJson(f), false),
  );

  const parsed = ingestSerpSnapshotsBodySchema.safeParse({
    projectId: args.project,
    snapshots: [...tracked, ...added],
  });
  if (!parsed.success) {
    console.error(JSON.stringify(parsed.error.issues, null, 2));
    process.exit(1);
  }

  for (const s of parsed.data.snapshots) {
    console.log(
      `${s.collectedAt}  ${s.keyword.padEnd(38)} organic ${s.organic.length}  paa ${s.paa.length}  videos ${s.videos.length}  aiOverview ${s.aiOverview.present}`,
    );
  }
  console.log(
    `\n${tracked.length} tracked + ${added.length} new = ${parsed.data.snapshots.length} snapshots`,
  );
  console.log(`Not sent (no column):\n- ${DROPPED.join("\n- ")}`);

  if (args["dry-run"]) return;

  const base = process.env.OPENSEO_URL;
  if (!base) throw new Error("Set OPENSEO_URL");
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
    headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
    headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
  } else if (process.env.CF_ACCESS_TOKEN) {
    headers["cf-access-token"] = process.env.CF_ACCESS_TOKEN;
  } else {
    throw new Error("Set CF_ACCESS_CLIENT_ID/_SECRET or CF_ACCESS_TOKEN");
  }

  const response = await fetch(new URL("/api/serp-snapshots", base), {
    method: "POST",
    headers,
    body: JSON.stringify(parsed.data),
    redirect: "manual",
  });
  console.log(`\nPOST /api/serp-snapshots → ${response.status}`);
  const body = await response.text();
  console.log(body);
  if (response.status === 201) {
    const result = JSON.parse(body);
    console.log("Rank tracking mirror:", result.mirror);
  }
  if (response.status !== 201) process.exit(1);
}

await main();
