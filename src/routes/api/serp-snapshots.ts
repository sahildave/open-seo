import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { getAuthMode } from "@/lib/auth-mode";
import { resolveCloudflareAccessOrganizationId } from "@/middleware/ensure-user/cloudflareAccess";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { SerpSnapshotService } from "@/server/features/serp-snapshots/services/SerpSnapshotService";
import { ingestSerpSnapshotsBodySchema } from "@/types/schemas/serpSnapshots";

// Script-friendly twin of the ingest_serp_snapshots MCP tool, so a collector
// can push captures with one HTTP call. Behind Cloudflare Access a caller
// authenticates as a user (cf-access-token from `cloudflared access token`)
// or with an Access service token (CF-Access-Client-Id/-Secret) that the
// Access application's policy admits.
async function resolveOrganizationId(headers: Headers) {
  if (getAuthMode(env.AUTH_MODE) === "cloudflare_access") {
    return resolveCloudflareAccessOrganizationId(headers);
  }
  return (await resolveUserContextFromHeaders(headers)).organizationId;
}

async function handleSerpSnapshotIngest(request: Request): Promise<Response> {
  let organizationId: string;
  try {
    organizationId = await resolveOrganizationId(request.headers);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const body = ingestSerpSnapshotsBodySchema.safeParse(
    await request.json().catch(() => null),
  );
  if (!body.success) {
    return Response.json(
      { error: "Invalid body", issues: body.error.issues },
      { status: 400 },
    );
  }

  // One 404 for unknown and foreign projects, so ids can't be probed.
  const project = await ProjectRepository.getProjectForOrganization(
    body.data.projectId,
    organizationId,
  );
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const inserted = await SerpSnapshotService.ingest(
    project,
    body.data.snapshots,
  );
  return Response.json({ inserted }, { status: 201 });
}

export const Route = createFileRoute("/api/serp-snapshots")({
  server: {
    handlers: {
      POST: ({ request }) => handleSerpSnapshotIngest(request),
    },
  },
});
