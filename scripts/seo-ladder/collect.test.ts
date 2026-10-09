import { readFile, writeFile, mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  buildBatchFromPages,
  collectFromDirectory,
  fetchTranscripts,
  main,
} from "./collect";
import { ingestSerpSnapshotsBodySchema } from "../../src/types/schemas/serpSnapshots";

const firstPage = `
  <main id="search">
    <div class="MjjYud"><a href="https://example.com/one"><h3>One result</h3></a></div>
  </main>
`;

async function writePage(
  directory: string,
  name: string,
  html: string,
  finalUrl = "https://www.google.com/search",
) {
  await writeFile(join(directory, `${name}.html`), html, "utf8");
  await writeFile(
    join(directory, `${name}.meta.json`),
    JSON.stringify({
      query: name,
      collectedAt: "2026-10-09T10:00:00.000Z",
      finalUrl,
    }),
    "utf8",
  );
}

describe("seo ladder collector", () => {
  it("builds a four-fixture batch that passes the ingest schema", async () => {
    const result = await collectFromDirectory("fixtures/google-serp", "test");

    expect(result.blocked).toBe(false);
    expect(result.batch.snapshots).toHaveLength(4);
    expect(ingestSerpSnapshotsBodySchema.safeParse(result.batch).success).toBe(
      true,
    );
  });

  it("stops at the first CAPTCHA in a saved-page dry run", async () => {
    const directory = await mkdtemp(join(tmpdir(), "seo-ladder-test-"));
    try {
      await writePage(directory, "01-first", firstPage);
      await writePage(
        directory,
        "02-captcha",
        await readFile("fixtures/google-serp/captcha.html", "utf8"),
        "https://www.google.com/sorry/index",
      );
      await writePage(directory, "03-after", firstPage);

      const output: string[] = [];
      const stdout = vi
        .spyOn(process.stdout, "write")
        .mockImplementation((chunk) => {
          output.push(typeof chunk === "string" ? chunk : chunk.toString());
          return true;
        });
      const error = vi.spyOn(console, "error").mockImplementation(() => {});
      const exitCode = await main([
        "--from-dir",
        directory,
        "--project",
        "test",
        "--dry-run",
      ]);
      stdout.mockRestore();
      error.mockRestore();

      const batch = z
        .object({ snapshots: z.array(z.unknown()) })
        .parse(JSON.parse(output.join("")));
      expect(exitCode).toBe(2);
      expect(batch.snapshots).toHaveLength(1);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("keeps transcript fetching injectable and counts failed fetches", async () => {
    const result = await fetchTranscripts(
      [
        {
          keyword: "video query",
          device: "desktop",
          source: "fixture",
          collectedAt: "2026-10-09T10:00:00.000Z",
          organic: [],
          paa: [],
          related: [],
          videos: [
            {
              title: "Video",
              url: "https://www.youtube.com/watch?v=video_1",
            },
            {
              title: "Same video",
              url: "https://www.youtube.com/watch?v=video_1&t=4",
            },
          ],
          aiOverview: { present: false },
        },
      ],
      async (command, args) => {
        expect(command).toBe("uvx");
        expect(args).toEqual([
          "--from",
          "youtube-transcript-api",
          "youtube_transcript_api",
          "video_1",
          "--format",
          "text",
        ]);
        return { stdout: "Transcript text\n" };
      },
    );

    expect(result).toMatchObject({
      skipped: 0,
      transcripts: [{ videoId: "video_1", text: "Transcript text" }],
    });
  });

  it("keeps the driver on Google's homepage/search box flow", async () => {
    const source = await readFile("scripts/seo-ladder/ego-driver.mjs", "utf8");
    expect(source).not.toContain("/search?q=");
    expect(source).not.toContain("num=");
  });

  it("does not mark a normal page blocked", () => {
    const result = buildBatchFromPages("test", [
      {
        html: firstPage,
        meta: {
          query: "one",
          collectedAt: "2026-10-09T10:00:00.000Z",
          finalUrl: "https://www.google.com/search",
        },
      },
    ]);
    expect(result.blocked).toBe(false);
    expect(result.batch.snapshots).toHaveLength(1);
  });
});
