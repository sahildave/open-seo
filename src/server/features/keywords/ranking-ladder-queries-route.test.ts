import { beforeEach, describe, expect, it, vi } from "vitest";
import { handleRankingLadderQueriesRequest } from "@/routes/api/ranking-ladder/queries";

const mocks = vi.hoisted(() => ({
  resolveUserContextFromHeaders: vi.fn(),
  getProjectForOrganization: vi.fn(),
  listForProject: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({ env: { AUTH_MODE: "hosted" } }));
vi.mock("@/middleware/ensure-user/resolve", () => ({
  resolveUserContextFromHeaders: mocks.resolveUserContextFromHeaders,
}));
vi.mock("@/server/features/projects/repositories/ProjectRepository", () => ({
  ProjectRepository: {
    getProjectForOrganization: mocks.getProjectForOrganization,
  },
}));
vi.mock(
  "@/server/features/keywords/repositories/RankingLadderQueryRepository",
  () => ({
    RankingLadderQueryRepository: { listForProject: mocks.listForProject },
  }),
);

const project = {
  id: "project-1",
  domain: "example.com",
  locationCode: 2840,
  languageCode: "en",
};

beforeEach(() => {
  mocks.resolveUserContextFromHeaders.mockResolvedValue({
    organizationId: "org-1",
  });
  mocks.getProjectForOrganization.mockResolvedValue(project);
  mocks.listForProject.mockResolvedValue({
    queries: Array.from({ length: 25 }, (_, index) => `tracked ${index + 1}`),
    seeds: ["autocomplete seed"],
  });
});

describe("GET /api/ranking-ladder/queries", () => {
  it("returns tagged tracked queries and caps the query list at 25", async () => {
    const response = await handleRankingLadderQueriesRequest(
      new Request(
        "https://app.example.com/api/ranking-ladder/queries?projectId=project-1",
      ),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      project,
      queries: Array.from({ length: 25 }, (_, index) => `tracked ${index + 1}`),
      seeds: ["autocomplete seed"],
    });
    expect(mocks.listForProject).toHaveBeenCalledWith("project-1");
  });

  it("returns one 404 for an unknown or foreign project", async () => {
    mocks.getProjectForOrganization.mockResolvedValue(null);

    const response = await handleRankingLadderQueriesRequest(
      new Request(
        "https://app.example.com/api/ranking-ladder/queries?projectId=foreign",
      ),
    );

    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Project not found" });
    expect(mocks.listForProject).not.toHaveBeenCalled();
  });
});
