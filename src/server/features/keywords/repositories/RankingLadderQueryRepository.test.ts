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

const state = vi.hoisted(() => {
  let currentDb: unknown;
  return {
    setDb(db: unknown) {
      currentDb = db;
    },
    getDb() {
      return currentDb;
    },
  };
});

vi.mock("@/db", () => ({
  get db() {
    return state.getDb();
  },
}));
vi.mock("cloudflare:workers", () => ({ env: { DATABASE_PROVIDER: "d1" } }));

let client: Client;
let listForProject: (
  projectId: string,
) => Promise<{ queries: string[]; seeds: string[] }>;

beforeAll(async () => {
  client = createClient({ url: "file::memory:" });
  state.setDb(drizzle(client));
  await client.executeMultiple(`
    CREATE TABLE saved_keywords (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      keyword text NOT NULL,
      location_code integer NOT NULL,
      language_code text NOT NULL,
      created_at text NOT NULL
    );
    CREATE TABLE saved_keyword_tags (
      id text PRIMARY KEY,
      project_id text NOT NULL,
      name text NOT NULL,
      normalized_name text NOT NULL,
      color text,
      created_at text NOT NULL
    );
    CREATE TABLE saved_keyword_tag_assignments (
      saved_keyword_id text NOT NULL,
      tag_id text NOT NULL,
      created_at text NOT NULL,
      UNIQUE(saved_keyword_id, tag_id)
    );
  `);

  // The repository binds to the provider-aware db module, so this import must
  // happen after the in-memory provider is installed.
  ({
    RankingLadderQueryRepository: { listForProject },
  } = await import("./RankingLadderQueryRepository"));
});

afterAll(() => client.close());

beforeEach(async () => {
  await client.execute("DELETE FROM saved_keyword_tag_assignments");
  await client.execute("DELETE FROM saved_keyword_tags");
  await client.execute("DELETE FROM saved_keywords");

  await client.executeMultiple(`
    INSERT INTO saved_keyword_tags (id, project_id, name, normalized_name, created_at)
      VALUES
        ('tag-ladder', 'project-1', 'Ranking ladder', 'ranking-ladder', '2026-10-01'),
        ('tag-seed', 'project-1', 'Ranking seed', 'ranking-seed', '2026-10-01'),
        ('tag-other', 'project-1', 'Other', 'other', '2026-10-01');
    INSERT INTO saved_keywords (id, project_id, keyword, location_code, language_code, created_at)
      VALUES
        ('untagged', 'project-1', 'untagged keyword', 2840, 'en', '2026-10-01'),
        ('seed', 'project-1', 'autocomplete seed', 2840, 'en', '2026-10-02');
    INSERT INTO saved_keyword_tag_assignments (saved_keyword_id, tag_id, created_at)
      VALUES
        ('untagged', 'tag-other', '2026-10-01'),
        ('seed', 'tag-seed', '2026-10-02');
  `);

  const values = Array.from(
    { length: 26 },
    (_, index) =>
      `('ladder-${String(index + 1).padStart(2, "0")}', 'project-1', 'tracked ${index + 1}', 2840, 'en', '2026-10-${String(index + 3).padStart(2, "0")}')`,
  );
  await client.execute(
    `INSERT INTO saved_keywords (id, project_id, keyword, location_code, language_code, created_at) VALUES ${values.join(",")}`,
  );
  await client.execute(
    `INSERT INTO saved_keyword_tag_assignments (saved_keyword_id, tag_id, created_at) VALUES ${values.map((_, index) => `('ladder-${String(index + 1).padStart(2, "0")}', 'tag-ladder', '2026-10-01')`).join(",")}`,
  );
});

describe("RankingLadderQueryRepository", () => {
  it("returns only ranking tags and caps tracked queries at 25", async () => {
    await expect(listForProject("project-1")).resolves.toEqual({
      queries: Array.from({ length: 25 }, (_, index) => `tracked ${index + 1}`),
      seeds: ["autocomplete seed"],
    });
  });
});
