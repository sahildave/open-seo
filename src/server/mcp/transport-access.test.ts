import type { Client } from "@libsql/client";
import { McpServer } from "@modelcontextprotocol/server";
import { afterAll, beforeAll, beforeEach, expect, it, vi } from "vitest";
import { MCP_AUTH_CONTEXT_PROP } from "./context";
import { handleSelfHostedOpenSeoMcpRequest } from "./transport";

const mocks = vi.hoisted(() => ({ jwtVerify: vi.fn() }));
const database = await vi.hoisted(async () => {
  const { createClient } = await import("@libsql/client");
  return { client: createClient({ url: "file::memory:" }) };
});

vi.mock("cloudflare:workers", () => ({
  env: {
    DATABASE_PROVIDER: "d1",
    TEAM_DOMAIN: "https://team.cloudflareaccess.com",
    POLICY_AUD: "aud",
  },
}));
vi.mock("jose", () => ({
  createRemoteJWKSet: vi.fn(),
  jwtVerify: mocks.jwtVerify,
}));
vi.mock("@/db", async () => {
  const { drizzle } = await import("drizzle-orm/libsql");
  const schema = await import("@/db/better-auth-schema");
  return { db: drizzle(database.client, { schema }) };
});
vi.mock("@/db/d1/client", () => ({ d1Db: null }));
vi.mock("@/db/pg/client", () => ({ pgDb: null }));
vi.mock("@/lib/auth", () => ({
  getHostedBaseUrl: () => "https://open-seo.test",
}));
vi.mock("@/server/mcp/server", () => ({
  createOpenSeoMcpServer: (props: {
    [MCP_AUTH_CONTEXT_PROP]: {
      userId: string;
      userEmail: string;
      organizationId: string;
    };
  }) => {
    const server = new McpServer({ name: "test", version: "1" });
    // Expose the identity a real tool receives, through an actual MCP call.
    server.registerTool("identity", {}, () => ({
      content: [
        { type: "text", text: JSON.stringify(props[MCP_AUTH_CONTEXT_PROP]) },
      ],
    }));
    return server;
  },
}));

const ctx: ExecutionContext = {
  waitUntil() {},
  passThroughOnException() {},
  props: {},
};

function callIdentity() {
  return handleSelfHostedOpenSeoMcpRequest(
    new Request("https://open-seo.test/mcp", {
      method: "POST",
      headers: {
        "cf-access-jwt-assertion": "verified-token",
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/call",
        params: { name: "identity", arguments: {} },
      }),
    }),
    "cloudflare_access",
    {},
    ctx,
  );
}

let client: Client;
beforeAll(async () => {
  client = database.client;
  await client.executeMultiple(`
    CREATE TABLE user (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, email TEXT NOT NULL UNIQUE,
      email_verified INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL DEFAULT 1, updated_at INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE organization (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, slug TEXT,
      logo TEXT, created_at INTEGER, metadata TEXT
    );
  `);
});
afterAll(() => client.close());
beforeEach(async () => {
  mocks.jwtVerify.mockResolvedValue({
    payload: { common_name: "openseo-agents.access" },
  });
  await client.executeMultiple("DELETE FROM user; DELETE FROM organization;");
});

it("serves MCP tools as the shared workspace owner for a service-token JWT", async () => {
  await client.executeMultiple(`
    INSERT INTO user (id, name, email, created_at) VALUES
      ('later-user', 'Later', 'later@example.com', 2),
      ('owner', 'Owner', 'owner@example.com', 1);
  `);

  const response = await callIdentity();

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            userId: "owner",
            userEmail: "owner@example.com",
            organizationId: "shared-workspace",
            baseUrl: "https://open-seo.test",
          }),
        },
      ],
    },
  });
  expect(
    (await client.execute("SELECT id FROM user ORDER BY id")).rows,
  ).toEqual([{ id: "later-user" }, { id: "owner" }]);
});

it("keeps a user JWT's own identity even when another user owns the workspace", async () => {
  await client.executeMultiple(`
    INSERT INTO user (id, name, email) VALUES
      ('owner', 'Owner', 'owner@example.com'),
      ('signed-in-user', 'Person', 'person@example.com');
  `);
  mocks.jwtVerify.mockResolvedValue({
    payload: { sub: "signed-in-user", email: "person@example.com" },
  });

  const response = await callIdentity();

  expect(response.status).toBe(200);
  expect(await response.json()).toMatchObject({
    result: {
      content: [
        {
          type: "text",
          text: JSON.stringify({
            userId: "signed-in-user",
            userEmail: "person@example.com",
            organizationId: "shared-workspace",
            baseUrl: "https://open-seo.test",
          }),
        },
      ],
    },
  });
});

it("rejects a service-token JWT before anyone has signed in", async () => {
  await expect(callIdentity()).rejects.toThrow("UNAUTHENTICATED");
  expect((await client.execute("SELECT id FROM user")).rows).toEqual([]);
});
