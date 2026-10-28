import { sort } from "remeda";
import { readdirSync, readFileSync } from "node:fs";
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
  const migrations = sort(
    readdirSync("drizzle/sqlite").filter((file) => file.endsWith(".sql")),
    (a, b) => a.localeCompare(b),
  );
  for (const file of migrations) {
    await client.executeMultiple(
      readFileSync(`drizzle/sqlite/${file}`, "utf8").replaceAll(
        "--> statement-breakpoint",
        "",
      ),
    );
  }
  await client.executeMultiple(`
    PRAGMA foreign_keys = ON;
    INSERT INTO organization (id, name, slug, created_at) VALUES ('org_1', 'Test', 'test', 0);
    INSERT INTO projects (id, organization_id, name, domain) VALUES ('proj_1', 'org_1', 'Test', 'gitsu.app');
  `);
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
  it("maps daily positions, URLs and SERP features into rank history", async () => {
    await SerpSnapshotService.ingest(project, [
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
    ]);
    expect(
      (
        await client.execute(
          "SELECT keyword, position, url, checked_at, serp_features FROM rank_snapshots ORDER BY checked_at",
        )
      ).rows,
    ).toEqual([
      {
        keyword: "github projects client",
        position: 1,
        url: "https://gitsu.app/old",
        checked_at: "2026-10-01 10:00:00",
        serp_features: '["organic"]',
      },
      {
        keyword: "github projects client",
        position: 2,
        url: "https://docs.gitsu.app/guide",
        checked_at: "2026-10-02 06:30:00",
        serp_features: '["organic","people_also_ask","video","ai_overview"]',
      },
    ]);
  });

  it("backfills stored history when the first manual tracker is created", async () => {
    await SerpSnapshotService.ingest({ ...project, domain: null }, [
      snapshot({}),
    ]);
    const { mirror } = await SerpSnapshotService.ingest(project, [
      snapshot({ collectedAt: "2026-10-02T10:00:00Z" }),
    ]);
    expect(mirror.runsWritten).toBe(2);
    expect(
      (
        await client.execute(
          "SELECT started_at FROM rank_check_runs ORDER BY started_at",
        )
      ).rows,
    ).toEqual([
      { started_at: "2026-10-01 10:00:00" },
      { started_at: "2026-10-02 10:00:00" },
    ]);
  });

  it("retries full backfill after the first mirror fails without writing a run", async () => {
    vi.spyOn(
      RankTrackingRepository,
      "upsertCollectedRun",
    ).mockRejectedValueOnce(new Error("mirror failed"));
    await expect(
      SerpSnapshotService.ingest(project, [
        snapshot({}),
        snapshot({ collectedAt: "2026-10-02T10:00:00Z" }),
      ]),
    ).rejects.toThrow("mirror failed");
    const configs = await RankTrackingRepository.getConfigsForProject(
      project.id,
    );
    expect(configs).toHaveLength(1);

    await SerpSnapshotService.ingest(project, [
      snapshot({ collectedAt: "2026-10-03T10:00:00Z" }),
    ]);
    const runs = await client.execute(
      "SELECT id FROM rank_check_runs ORDER BY started_at",
    );
    expect(runs.rows).toEqual([
      { id: `serp-${configs[0].id}-2026-10-01` },
      { id: `serp-${configs[0].id}-2026-10-02` },
      { id: `serp-${configs[0].id}-2026-10-03` },
    ]);
  });

  it("keeps rank history idempotent when the same batch is ingested again", async () => {
    const batch = [snapshot({})];
    await SerpSnapshotService.ingest(project, batch);
    await SerpSnapshotService.ingest(project, batch);
    expect(
      (
        await client.execute(`SELECT
      (SELECT count(*) FROM rank_tracking_configs) AS configs,
      (SELECT count(*) FROM rank_tracking_keywords) AS keywords,
      (SELECT count(*) FROM rank_check_runs) AS runs,
      (SELECT count(*) FROM rank_snapshots) AS ranks`)
      ).rows[0],
    ).toEqual({ configs: 1, keywords: 1, runs: 1, ranks: 1 });
  });

  it("keeps the latest capture within a day across out-of-order pushes", async () => {
    await SerpSnapshotService.ingest(project, [
      snapshot({
        collectedAt: "2026-10-01T11:00:00Z",
        organic: organic("https://other.app", "https://gitsu.app/new"),
      }),
    ]);
    await SerpSnapshotService.ingest(project, [
      snapshot({ organic: organic("https://gitsu.app/old") }),
    ]);
    expect(
      (
        await client.execute(
          "SELECT position, url, checked_at FROM rank_snapshots",
        )
      ).rows,
    ).toEqual([
      {
        position: 2,
        url: "https://gitsu.app/new",
        checked_at: "2026-10-01 11:00:00",
      },
    ]);
  });

  it("leaves scheduled trackers unchanged and reports their skipped markets", async () => {
    await RankTrackingRepository.createConfig({
      id: "scheduled",
      projectId: project.id,
      domain: project.domain,
      locationCode: 2840,
      languageCode: "en",
      devices: "desktop",
      serpDepth: 10,
      scheduleInterval: "weekly",
    });
    await RankTrackingRepository.addKeywordsToConfig([
      { id: "existing", configId: "scheduled", keyword: "existing" },
    ]);
    const { mirror } = await SerpSnapshotService.ingest(project, [
      snapshot({
        device: "mobile",
        organic: [{ position: 15, title: "Gitsu", url: "https://gitsu.app/" }],
      }),
    ]);
    const [config] = await RankTrackingRepository.getConfigsForProject(
      project.id,
    );
    expect(config).toMatchObject({
      id: "scheduled",
      devices: "desktop",
      serpDepth: 10,
      scheduleInterval: "weekly",
    });
    expect(
      (await RankTrackingRepository.getKeywordsForConfig("scheduled")).map(
        (k) => k.keyword,
      ),
    ).toEqual(["existing"]);
    expect(mirror).toEqual({
      configsTouched: 0,
      runsWritten: 0,
      skippedMarkets: [{ locationCode: 2840, languageCode: "en" }],
    });
  });

  it("mirrors only the incoming UTC days after a tracker exists", async () => {
    await SerpSnapshotService.ingest(project, [snapshot({})]);
    // This offset falls on October 2 in UTC, despite the local October 3 date.
    const { mirror } = await SerpSnapshotService.ingest(project, [
      snapshot({ collectedAt: "2026-10-03T01:00:00+05:30" }),
    ]);
    expect(mirror.runsWritten).toBe(1);
    expect(
      (
        await client.execute(
          "SELECT started_at FROM rank_check_runs ORDER BY started_at",
        )
      ).rows,
    ).toEqual([
      { started_at: "2026-10-01 10:00:00" },
      { started_at: "2026-10-02 19:30:00" },
    ]);
  });

  it("creates manual trackers with devices and depth covering the captures", async () => {
    await SerpSnapshotService.ingest(project, [
      snapshot({}),
      snapshot({
        device: "mobile",
        organic: [{ position: 15, title: "Other", url: "https://other.app" }],
      }),
    ]);
    expect(
      await RankTrackingRepository.getConfigsForProject(project.id),
    ).toEqual([
      expect.objectContaining({
        scheduleInterval: "manual",
        devices: "both",
        serpDepth: 20,
      }),
    ]);
  });

  it("summarizes daily keyword coverage and UTC collection bounds", async () => {
    await SerpSnapshotService.ingest(project, [
      snapshot({}),
      snapshot({ collectedAt: "2026-10-02T12:00:00+05:30" }),
      snapshot({ keyword: "other", collectedAt: "2026-10-02T08:00:00Z" }),
    ]);
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
  });

  it("stores captures without mirroring when the project has no domain", async () => {
    const { mirror } = await SerpSnapshotService.ingest(
      { ...project, domain: null },
      [snapshot({})],
    );
    expect(mirror.configsTouched).toBe(0);
    expect(
      await RankTrackingRepository.getConfigsForProject(project.id),
    ).toEqual([]);
    expect(
      (await client.execute("SELECT count(*) AS total FROM serp_snapshots"))
        .rows[0].total,
    ).toBe(1);
  });

  it("separates languages into their own trackers", async () => {
    await SerpSnapshotService.ingest(project, [
      snapshot({}),
      snapshot({ languageCode: "fr" }),
    ]);
    expect(
      (await RankTrackingRepository.getConfigsForProject(project.id)).map(
        (c) => c.languageCode,
      ),
    ).toEqual(expect.arrayContaining(["en", "fr"]));
    expect(
      (await client.execute("SELECT count(*) AS total FROM rank_check_runs"))
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
