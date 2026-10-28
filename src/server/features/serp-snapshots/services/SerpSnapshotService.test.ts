import { readFileSync } from "node:fs";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { SerpSnapshotService } from "./SerpSnapshotService";
import { RankTrackingRepository } from "@/server/features/rank-tracking/repositories/RankTrackingRepository";
import type { SerpSnapshotInput } from "@/types/schemas/serpSnapshots";

// Real in-memory SQLite built from the shipped migration, so ordering and the
// "previous capture" lookup run as generated SQL.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

const { client, testDb } = await vi.hoisted(async () => {
  const { createClient } = await import("@libsql/client");
  const { drizzle } = await import("drizzle-orm/libsql");
  const sqliteClient = createClient({ url: "file::memory:" });
  return { client: sqliteClient, testDb: drizzle(sqliteClient) };
});
vi.mock("@/db", () => ({ db: testDb }));
vi.mock("@/db/runBatch", () => ({
  runBatch: async (
    build: (tx: typeof testDb) => Parameters<typeof testDb.batch>[0][number][],
  ) => {
    const [first, ...rest] = build(testDb);
    if (first) await testDb.batch([first, ...rest]);
  },
}));

beforeAll(async () => {
  await client.executeMultiple(
    [
      `PRAGMA foreign_keys = ON; CREATE TABLE projects (id text PRIMARY KEY, organization_id text, archived_at text);`,
      `INSERT INTO projects (id) VALUES ('proj_1');`,
      ...[
        "0007_sour_risque.sql",
        "0008_luxuriant_colossus.sql",
        "0009_smart_kitty_pryde.sql",
        "0011_colorful_dark_beast.sql",
        "0029_location_name.sql",
        "0045_slimy_master_chief.sql",
        "0051_rank_keyword_pins.sql",
        "0059_thankful_aaron_stack.sql",
        "0063_serp_snapshots.sql",
      ].flatMap((file) =>
        readFileSync(`drizzle/sqlite/${file}`, "utf8").split(
          "--> statement-breakpoint",
        ),
      ),
    ].join("\n"),
  );
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.executeMultiple(
    "DELETE FROM serp_snapshots; DELETE FROM rank_snapshots; DELETE FROM rank_check_runs; DELETE FROM rank_tracking_keywords; DELETE FROM rank_tracking_configs;",
  );
});

const project = {
  id: "proj_1",
  domain: "gitsu.app",
  locationCode: 2840,
  languageCode: "en",
};

function snapshot(overrides: Partial<SerpSnapshotInput>): SerpSnapshotInput {
  return {
    keyword: "github projects client",
    device: "desktop",
    source: "ego-browser",
    collectedAt: "2026-10-01T10:00:00.000Z",
    organic: [],
    paa: [],
    related: [],
    videos: [],
    aiOverview: { present: false },
    ...overrides,
  };
}

const organic = (...urls: string[]) =>
  urls.map((url, i) => ({ position: i + 1, title: url, url }));

describe("ingest", () => {
  it("mirrors collection days into manual rank history with positions, URLs and features", async () => {
    const { mirror } = await SerpSnapshotService.ingest(project, [
      snapshot({
        keyword: "GitHub Projects Client",
        organic: organic("https://gitsu.app/old"),
      }),
      snapshot({
        collectedAt: "2026-10-02T12:00:00+05:30",
        organic: organic(
          "https://notgitsu.app/",
          "https://docs.gitsu.app/guide",
          "https://gitsu.app/",
        ),
        paa: ["What is Gitsu?"],
        videos: [{ title: "Gitsu", url: "https://youtube.com/watch?v=gitsu" }],
        aiOverview: { present: true },
      }),
      snapshot({
        keyword: "other",
        device: "mobile",
        collectedAt: "2026-10-02T08:00:00Z",
        organic: [{ position: 15, title: "Other", url: "https://other.app" }],
      }),
    ]);
    expect(mirror).toEqual({
      configsTouched: 1,
      runsWritten: 2,
    });
    const [config] = await RankTrackingRepository.getConfigsForProject(
      project.id,
    );
    expect(config).toMatchObject({
      domain: "gitsu.app",
      locationCode: 2840,
      languageCode: "en",
      locationName: null,
      scheduleInterval: "manual",
      devices: "both",
      serpDepth: 20,
    });
    expect(
      await RankTrackingRepository.getDueConfigsWithOrganization("2099-01-01"),
    ).toEqual([]);
    const keywords = await RankTrackingRepository.getKeywordsForConfig(
      config.id,
    );
    expect(keywords.map((k) => k.keyword)).toEqual(
      expect.arrayContaining(["github projects client", "other"]),
    );
    expect(keywords[0]).toMatchObject({
      searchVolume: null,
      keywordDifficulty: null,
      cpc: null,
    });
    expect(
      (
        await client.execute(
          "SELECT keywords_total, keywords_checked, is_subset_run, started_at, completed_at FROM rank_check_runs ORDER BY started_at",
        )
      ).rows,
    ).toEqual([
      {
        keywords_total: 1,
        keywords_checked: 1,
        is_subset_run: 1,
        started_at: "2026-10-01 10:00:00",
        completed_at: "2026-10-01 10:00:00",
      },
      {
        keywords_total: 2,
        keywords_checked: 2,
        is_subset_run: 0,
        started_at: "2026-10-02 06:30:00",
        completed_at: "2026-10-02 08:00:00",
      },
    ]);
    const ranks = await RankTrackingRepository.getSnapshotsForRun(
      `serp-${config.id}-2026-10-02`,
    );
    expect(ranks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          keyword: "github projects client",
          device: "desktop",
          position: 2,
          url: "https://docs.gitsu.app/guide",
          checkedAt: "2026-10-02 06:30:00",
          serpFeatures: JSON.stringify([
            "organic",
            "people_also_ask",
            "video",
            "ai_overview",
          ]),
        }),
        expect.objectContaining({
          keyword: "other",
          device: "mobile",
          position: null,
          url: null,
          serpFeatures: '["organic"]',
        }),
      ]),
    );
  });

  it("backfills stored captures and keeps daily ranks idempotent while accepting newer captures", async () => {
    const batch = [snapshot({ organic: organic("https://gitsu.app/old") })];
    await SerpSnapshotService.ingest(project, batch);
    // Simulate captures stored before mirroring shipped.
    await client.executeMultiple(
      "DELETE FROM rank_snapshots; DELETE FROM rank_tracking_configs;",
    );
    await SerpSnapshotService.ingest(project, [
      snapshot({ keyword: "second", collectedAt: "2026-10-02T10:00:00Z" }),
    ]);
    const counts = async () =>
      (
        await client.execute(`SELECT
      (SELECT count(*) FROM rank_tracking_configs) AS configs,
      (SELECT count(*) FROM rank_tracking_keywords) AS keywords,
      (SELECT count(*) FROM rank_check_runs) AS runs,
      (SELECT count(*) FROM rank_snapshots) AS ranks`)
      ).rows[0];
    expect(await counts()).toEqual({
      configs: 1,
      keywords: 2,
      runs: 2,
      ranks: 2,
    });
    await SerpSnapshotService.ingest(project, batch);
    expect(await counts()).toEqual({
      configs: 1,
      keywords: 2,
      runs: 2,
      ranks: 2,
    });
    await SerpSnapshotService.ingest(project, [
      snapshot({
        collectedAt: "2026-10-01T11:00:00Z",
        organic: organic("https://other.app", "https://gitsu.app/new"),
      }),
    ]);
    await SerpSnapshotService.ingest(project, batch);
    expect(await counts()).toEqual({
      configs: 1,
      keywords: 2,
      runs: 2,
      ranks: 2,
    });
    const [config] = await RankTrackingRepository.getConfigsForProject(
      project.id,
    );
    expect(
      await RankTrackingRepository.getSnapshotsForRun(
        `serp-${config.id}-2026-10-01`,
      ),
    ).toEqual([
      expect.objectContaining({
        position: 2,
        url: "https://gitsu.app/new",
        checkedAt: "2026-10-01 11:00:00",
      }),
    ]);
  });

  it("skips mirroring without a domain and separates languages into their own configs", async () => {
    expect(
      (
        await SerpSnapshotService.ingest({ ...project, domain: null }, [
          snapshot({}),
        ])
      ).mirror.configsTouched,
    ).toBe(0);
    const { mirror } = await SerpSnapshotService.ingest(project, [
      snapshot({ languageCode: "fr" }),
    ]);
    expect(mirror).toEqual({
      configsTouched: 2,
      runsWritten: 2,
    });
    expect(
      (await RankTrackingRepository.getConfigsForProject(project.id)).map(
        (c) => c.languageCode,
      ),
    ).toEqual(expect.arrayContaining(["en", "fr"]));
    expect(
      (await client.execute("SELECT count(*) AS total FROM rank_snapshots"))
        .rows[0].total,
    ).toBe(2);
    expect(
      (await client.execute("SELECT count(*) AS total FROM serp_snapshots"))
        .rows[0].total,
    ).toBe(2);
  });

  it("takes the project's best position, counting www and subdomains", async () => {
    const {
      inserted: [ranked, absent],
    } = await SerpSnapshotService.ingest(project, [
      snapshot({
        organic: organic(
          "https://github.com/a",
          "https://docs.gitsu.app/guide",
          "https://www.gitsu.app/",
        ),
      }),
      snapshot({ organic: organic("https://notgitsu.app/") }),
    ]);
    expect(ranked?.ourPosition).toBe(2);
    expect(absent?.ourPosition).toBeNull();
  });
});

describe("list with diff", () => {
  it("diffs each capture against the previous one for the same keyword", async () => {
    await SerpSnapshotService.ingest(project, [
      snapshot({
        collectedAt: "2026-10-01T10:00:00.000Z",
        organic: organic("https://a.com/", "https://b.com/", "https://c.com/"),
        paa: ["What is gitsu?"],
      }),
      // A non-UTC offset must still order after the first capture.
      snapshot({
        collectedAt: "2026-10-02T12:00:00+05:30",
        organic: organic(
          "https://b.com",
          "https://a.com/",
          "https://gitsu.app/",
        ),
        paa: ["What is gitsu?", "Is gitsu free?"],
      }),
      snapshot({ keyword: "other keyword" }),
    ]);

    const results = await SerpSnapshotService.list({
      projectId: "proj_1",
      keyword: "github projects client",
      limit: 10,
      diff: true,
    });

    expect(results.map((r) => r.snapshot.collectedAt)).toEqual([
      "2026-10-02T06:30:00.000Z",
      "2026-10-01T10:00:00.000Z",
    ]);
    expect(results[0]?.diff).toMatchObject({
      entered: [{ url: "https://gitsu.app/", position: 3 }],
      left: [{ url: "https://c.com/", position: 3 }],
      moved: [
        { url: "https://b.com", from: 2, to: 1 },
        { url: "https://a.com/", from: 1, to: 2 },
      ],
      newPaa: ["Is gitsu free?"],
      ourPosition: { from: null, to: 3 },
    });
    expect(results[1]?.diff).toBeNull();
  });
});
