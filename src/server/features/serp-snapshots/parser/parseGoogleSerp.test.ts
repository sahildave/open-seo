import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import {
  serpSnapshotInputSchema,
  type SerpSnapshotInput,
} from "@/types/schemas/serpSnapshots";
import { parseGoogleSerp } from "./parseGoogleSerp";

const FIXTURE_DIR = "fixtures/google-serp";
const FIXTURES = [
  "claude-code-kanban-board",
  "github-projects-vs-jira",
  "github-sub-issues",
  "zenhub-alternatives",
];

function fixture(name: string) {
  return readFileSync(join(FIXTURE_DIR, `${name}.html`), "utf8");
}

function videoId(url: string) {
  return new URL(url).searchParams.get("v");
}

function asSnapshotInput(
  parsed: Exclude<ReturnType<typeof parseGoogleSerp>, { kind: "blocked" }>,
  name: string,
): SerpSnapshotInput {
  const meta = z
    .object({ capturedAt: z.string() })
    .parse(
      JSON.parse(readFileSync(join(FIXTURE_DIR, `${name}.meta.json`), "utf8")),
    );
  return {
    keyword: name,
    device: "desktop",
    source: "fixture",
    collectedAt: meta.capturedAt,
    organic: parsed.organic,
    paa: parsed.paa,
    related: parsed.related,
    videos: parsed.videos,
    aiOverview: parsed.aiOverview,
  };
}

describe("parseGoogleSerp", () => {
  it.each(FIXTURES)("parses the saved %s results page", (name) => {
    const parsed = parseGoogleSerp(fixture(name));

    expect(parsed.kind).toBe("results");
    if (parsed.kind === "blocked") return;

    expect(parsed.organic.length).toBeLessThanOrEqual(10);
    expect(parsed.organic.map((result) => result.position)).toEqual(
      parsed.organic.map((_, index) => index + 1),
    );
    expect(
      parsed.organic.every(
        (result) => !/google\.[^/]+$/i.test(new URL(result.url).hostname),
      ),
    ).toBe(true);

    const hasPaa = fixture(name).includes("related-question-pair");
    if (hasPaa) {
      expect(parsed.paa.length).toBeGreaterThan(0);
      expect(parsed.paa.every((question) => !question.includes("{"))).toBe(
        true,
      );
    }

    const ids = parsed.videos.map((video) => videoId(video.url));
    expect(ids).toEqual([...new Set(ids)]);
    expect(
      serpSnapshotInputSchema.safeParse(asSnapshotInput(parsed, name)).success,
    ).toBe(true);
  });

  it("returns blocked for a CAPTCHA page", () => {
    expect(parseGoogleSerp(fixture("captcha"))).toEqual({
      kind: "blocked",
      reason: "captcha",
    });
  });

  it("deduplicates a carousel video and its description links by video id", () => {
    const parsed = parseGoogleSerp(`
      <main id="search">
        <section aria-label="Videos">
          <a href="https://www.youtube.com/watch?v=duplicate123"><div class="V5XKdd"><span class="cHaqb">The title</span><span class="Sg4azc">YouTube · Channel</span></div></a>
          <a href="https://www.youtube.com/watch?v=duplicate123&t=90"><div class="q9yZOe"><span>From 01:30</span><span>Description line</span></div></a>
        </section>
      </main>
    `);

    expect(parsed.kind).toBe("results");
    if (parsed.kind === "blocked") return;
    expect(parsed.videos).toHaveLength(1);
    expect(parsed.videos[0]).toMatchObject({
      title: "The title",
      url: "https://www.youtube.com/watch?v=duplicate123",
      position: 1,
    });
  });

  it("strips CSS leaked after a PAA question and reads an AI overview citation", () => {
    const parsed = parseGoogleSerp(`
      <main id="search">
        <section class="related-question-pair" data-q="What is a useful answer? .class{color:red}"></section>
        <section class="ai-overview">
          <h2>AI Overview</h2>
          <p>A concise answer appears here.</p>
          <a href="https://example.com/source">Source</a>
        </section>
      </main>
    `);

    expect(parsed.kind).toBe("results");
    if (parsed.kind === "blocked") return;
    expect(parsed.paa).toEqual(["What is a useful answer?"]);
    expect(parsed.aiOverview).toEqual({
      present: true,
      excerpt: "A concise answer appears here.",
      citedUrls: ["https://example.com/source"],
    });
  });
});
