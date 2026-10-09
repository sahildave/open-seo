import { z } from "zod";
import { safeHttpUrl } from "@/shared/safe-url";

// Wire contract for externally collected SERP snapshots, shared by the
// ingest_serp_snapshots MCP tool and POST /api/serp-snapshots. Collectors send
// null for "not captured", so optional fields accept null as well as absence.

const httpUrl = z
  .string()
  .max(2048)
  .refine((value) => safeHttpUrl(value) !== null, "Must be an http(s) URL");

const shortText = z.string().trim().min(1).max(500);

export const MAX_SNAPSHOTS_PER_INGEST = 50;

export const serpSnapshotInputSchema = z.object({
  keyword: z.string().trim().min(1).max(200),
  locationCode: z
    .number()
    .int()
    .positive()
    .nullish()
    .describe("DataForSEO location code. Defaults to the project's."),
  languageCode: z
    .string()
    .trim()
    .min(2)
    .max(10)
    .nullish()
    .describe("Language code. Defaults to the project's."),
  device: z.enum(["desktop", "mobile"]).default("desktop"),
  source: z
    .string()
    .trim()
    .min(1)
    .max(64)
    .default("ego-browser")
    .describe("Collector that captured the page."),
  collectedAt: z.iso
    .datetime({ offset: true })
    .describe("ISO timestamp of the capture."),
  organic: z
    .array(
      z.object({
        position: z.number().int().min(1).max(100),
        title: z.string().trim().max(500),
        url: httpUrl,
        snippet: z.string().max(2000).nullish(),
      }),
    )
    .max(100),
  paa: z.array(shortText).max(50).default([]),
  related: z.array(shortText).max(50).default([]),
  videos: z
    .array(
      z.object({
        title: z.string().trim().max(500),
        url: httpUrl,
        channel: z.string().max(200).nullish(),
        position: z.number().int().min(1).max(100).nullish(),
      }),
    )
    .max(50)
    .default([]),
  aiOverview: z
    .object({
      present: z.boolean(),
      excerpt: z.string().max(5000).nullish(),
      citedUrls: z.array(httpUrl).max(50).nullish(),
    })
    .default({ present: false }),
});

export type SerpSnapshotInput = z.infer<typeof serpSnapshotInputSchema>;

export const ingestSerpSnapshotsBodySchema = z.object({
  projectId: z.string().min(1),
  snapshots: z
    .array(serpSnapshotInputSchema)
    .min(1)
    .max(MAX_SNAPSHOTS_PER_INGEST),
});
