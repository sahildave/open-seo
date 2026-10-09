import { z } from "zod";
import { SerpSnapshotService } from "@/server/features/serp-snapshots/services/SerpSnapshotService";
import { mcpResponse } from "@/server/mcp/formatters";
import { buildProjectMeta } from "@/server/mcp/context";
import { optionalMetaOutputSchema } from "@/server/mcp/output-schemas";
import { withMcpProjectAuth } from "@/server/mcp/project-auth";
import { projectIdSchema } from "@/server/mcp/schemas";
import {
  MAX_SNAPSHOTS_PER_INGEST,
  serpSnapshotInputSchema,
} from "@/types/schemas/serpSnapshots";

const ingestInputSchema = {
  projectId: projectIdSchema,
  snapshots: z
    .array(serpSnapshotInputSchema)
    .min(1)
    .max(MAX_SNAPSHOTS_PER_INGEST)
    .describe(
      `Up to ${MAX_SNAPSHOTS_PER_INGEST} SERP captures, one per keyword per collection.`,
    ),
} as const;

export const ingestSerpSnapshotsTool = {
  name: "ingest_serp_snapshots",
  config: {
    title: "Ingest SERP snapshots",
    description:
      "Stores Google results-page captures gathered outside OpenSEO (for example by a browser-driven collector): top organic results, People Also Ask, related searches, videos and the AI Overview, per keyword. Computes the project's own organic position from its domain. Uses no credits.",
    inputSchema: ingestInputSchema,
    outputSchema: z.looseObject({
      inserted: z.array(
        z.looseObject({
          id: z.string(),
          keyword: z.string(),
          collectedAt: z.string(),
          ourPosition: z.number().nullable(),
        }),
      ),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: false,
      openWorldHint: false,
      destructiveHint: false,
      idempotentHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof ingestInputSchema>>, context) => {
      const inserted = await SerpSnapshotService.ingest(
        context.project,
        args.snapshots,
      );
      return mcpResponse({
        text:
          `Stored ${inserted.length} SERP snapshot(s):\n` +
          inserted
            .map(
              (row) =>
                `- ${row.keyword}  ours:${row.ourPosition ?? "not ranked"}`,
            )
            .join("\n"),
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: { inserted },
      });
    },
  ),
};

const listInputSchema = {
  projectId: projectIdSchema,
  keyword: z
    .string()
    .trim()
    .min(1)
    .max(200)
    .optional()
    .describe("Exact keyword to filter by."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Latest N snapshots to return. Defaults to 10."),
  diff: z
    .boolean()
    .optional()
    .describe(
      "Compare each snapshot with the previous capture of the same keyword, device and market: URLs that entered or left, position changes, new PAA questions.",
    ),
} as const;

export const listSerpSnapshotsTool = {
  name: "list_serp_snapshots",
  config: {
    title: "List SERP snapshots",
    description:
      "Lists stored SERP captures for a project, newest first, optionally for one keyword. With diff=true each snapshot carries what changed since the previous capture. Uses no credits.",
    inputSchema: listInputSchema,
    outputSchema: z.looseObject({
      snapshots: z.array(z.looseObject({ id: z.string() })),
      ...optionalMetaOutputSchema,
    }),
    annotations: {
      readOnlyHint: true,
      openWorldHint: false,
      destructiveHint: false,
    },
  },
  handler: withMcpProjectAuth(
    async (args: z.infer<z.ZodObject<typeof listInputSchema>>, context) => {
      const results = await SerpSnapshotService.list({
        projectId: args.projectId,
        keyword: args.keyword,
        limit: args.limit ?? 10,
        diff: args.diff ?? false,
      });
      const text =
        results.length === 0
          ? "No SERP snapshots yet."
          : results
              .map(({ snapshot, diff }) => {
                const head = `- ${snapshot.keyword} (${snapshot.device}, ${snapshot.collectedAt})  ours:${snapshot.ourPosition ?? "not ranked"}  organic:${snapshot.organic.length}  paa:${snapshot.paa.length}  aiOverview:${snapshot.aiOverview.present ? "yes" : "no"}`;
                if (diff === undefined) return head;
                if (diff === null) return `${head}\n  first capture`;
                return `${head}\n  vs ${diff.previousCollectedAt}: entered ${diff.entered.length}, left ${diff.left.length}, moved ${diff.moved.length}, new PAA ${diff.newPaa.length}`;
              })
              .join("\n");
      return mcpResponse({
        text,
        meta: buildProjectMeta(context, args.projectId),
        structuredContent: {
          snapshots: results.map(({ snapshot, diff }) =>
            diff === undefined ? snapshot : { ...snapshot, diff },
          ),
        },
      });
    },
  ),
};
