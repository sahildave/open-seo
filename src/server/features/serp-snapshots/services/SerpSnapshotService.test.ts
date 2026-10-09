import { readFileSync } from "node:fs";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import type * as ServiceModule from "./SerpSnapshotService";
import type { SerpSnapshotInput } from "@/types/schemas/serpSnapshots";

// Real in-memory SQLite built from the shipped migration, so ordering and the
// "previous capture" lookup run as generated SQL.

vi.mock("cloudflare:workers", () => ({
  env: { DATABASE_PROVIDER: "d1" },
}));

let client: Client;
let SerpSnapshotService: typeof ServiceModule.SerpSnapshotService;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  const testDb = drizzle(client);
  vi.doMock("@/db", () => ({ db: testDb }));
  vi.doMock("@/db/runBatch", () => ({
    runBatch: async (build: (tx: unknown) => Promise<unknown>[]) => {
      for (const statement of build(testDb)) await statement;
    },
  }));
  await client.executeMultiple(
    [
      `CREATE TABLE projects (id text PRIMARY KEY);`,
      `INSERT INTO projects (id) VALUES ('proj_1');`,
      ...readFileSync("drizzle/sqlite/0055_serp_snapshots.sql", "utf8").split(
        "--> statement-breakpoint",
      ),
    ].join("\n"),
  );
  ({ SerpSnapshotService } = await import("./SerpSnapshotService"));
});

afterAll(() => {
  client.close();
});

beforeEach(async () => {
  await client.execute("DELETE FROM serp_snapshots");
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
  it("takes the project's best position, counting www and subdomains", async () => {
    const [ranked, absent] = await SerpSnapshotService.ingest(project, [
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
