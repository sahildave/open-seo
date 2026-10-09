import { beforeEach, describe, expect, it, vi } from "vitest";
import { resolveCloudflareAccessOrganizationId } from "./cloudflareAccess";

const mocks = vi.hoisted(() => ({
  jwtVerify: vi.fn(),
  resolveSharedWorkspaceContext: vi.fn(),
}));

vi.mock("cloudflare:workers", () => ({
  env: {
    TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    POLICY_AUD: "aud",
  },
}));
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: mocks.jwtVerify,
}));
vi.mock("@/server/auth/delegated-organization", () => ({
  ensureSharedWorkspaceOrganization: async () => "shared-workspace",
}));
vi.mock("./delegated", () => ({
  resolveSharedWorkspaceContext: mocks.resolveSharedWorkspaceContext,
}));

const headers = new Headers({ "cf-access-jwt-assertion": "token" });

describe("resolveCloudflareAccessOrganizationId", () => {
  beforeEach(() => {
    mocks.resolveSharedWorkspaceContext.mockResolvedValue({
      organizationId: "shared-workspace",
    });
  });

  it("admits a verified service token to the shared workspace", async () => {
    mocks.jwtVerify.mockResolvedValue({
      payload: { sub: "", common_name: "abc.access" },
    });
    await expect(resolveCloudflareAccessOrganizationId(headers)).resolves.toBe(
      "shared-workspace",
    );
    expect(mocks.resolveSharedWorkspaceContext).not.toHaveBeenCalled();
  });

  it("rejects a verified token that is neither a user nor a service token", async () => {
    mocks.jwtVerify.mockResolvedValue({ payload: { sub: "" } });
    await expect(
      resolveCloudflareAccessOrganizationId(headers),
    ).rejects.toThrow("UNAUTHENTICATED");
  });
});
