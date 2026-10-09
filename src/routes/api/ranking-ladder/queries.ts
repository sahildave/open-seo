import { createFileRoute } from "@tanstack/react-router";
import { env } from "cloudflare:workers";
import { getAuthMode } from "@/lib/auth-mode";
import { resolveCloudflareAccessOrganizationId } from "@/middleware/ensure-user/cloudflareAccess";
import { resolveUserContextFromHeaders } from "@/middleware/ensure-user/resolve";
import { ProjectRepository } from "@/server/features/projects/repositories/ProjectRepository";
import { RankingLadderQueryRepository } from "@/server/features/keywords/repositories/RankingLadderQueryRepository";

async function resolveOrganizationId(headers: Headers) {
  if (getAuthMode(env.AUTH_MODE) === "cloudflare_access") {
    return resolveCloudflareAccessOrganizationId(headers);
  }
  return (await resolveUserContextFromHeaders(headers)).organizationId;
}

export async function handleRankingLadderQueriesRequest(
  request: Request,
): Promise<Response> {
  let organizationId: string;
  try {
    organizationId = await resolveOrganizationId(request.headers);
  } catch {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const projectId = new URL(request.url).searchParams.get("projectId");
  if (!projectId) {
    return Response.json({ error: "projectId is required" }, { status: 400 });
  }

  // One 404 for unknown and foreign projects, so project ids cannot be probed.
  const project = await ProjectRepository.getProjectForOrganization(
    projectId,
    organizationId,
  );
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 });
  }

  const queries = await RankingLadderQueryRepository.listForProject(project.id);
  return Response.json({
    project: {
      id: project.id,
      domain: project.domain,
      locationCode: project.locationCode,
      languageCode: project.languageCode,
    },
    ...queries,
  });
}

export const Route = createFileRoute("/api/ranking-ladder/queries")({
  server: {
    handlers: {
      GET: ({ request }) => handleRankingLadderQueriesRequest(request),
    },
  },
});
