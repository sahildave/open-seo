import { db } from "@/db";
import { user } from "@/db/schema";
import {
  ensureDelegatedOrganizationForUser,
  ensureSharedWorkspaceOrganization,
} from "@/server/auth/delegated-organization";
import { asc, eq } from "drizzle-orm";
import { AppError } from "@/server/lib/errors";
import type { EnsuredUserContext } from "./types";

const LOCAL_ADMIN_USER_ID = "local-admin";
const LOCAL_ADMIN_EMAIL = "admin@localhost";

// Externally-authenticated users (Cloudflare Access, local_noauth) are stored
// in better-auth's `user` table just like hosted users — only the way we
// authenticate them differs (per-request, no better-auth session). Keeping a
// single user table means the OAuth `account` grant and every app table that
// references `user.id` resolve the same way in all auth modes.
function deriveUserName(email: string) {
  return email.split("@")[0] || "OpenSEO";
}

export async function ensureUserRecord(userId: string, userEmail: string) {
  const existing = await db.query.user.findFirst({
    columns: { email: true },
    where: eq(user.id, userId),
  });

  if (!existing) {
    // Concurrent first-load requests can all see "no row" and race to insert
    // the same id; onConflictDoNothing on the PK makes the losers no-ops instead
    // of failing. Scoped to the id so a genuine email-unique collision (two
    // distinct ids sharing an email) still surfaces loudly.
    await db
      .insert(user)
      .values({
        id: userId,
        name: deriveUserName(userEmail),
        email: userEmail,
        emailVerified: true,
      })
      .onConflictDoNothing({ target: user.id });

    return userEmail;
  }

  if (existing.email !== userEmail) {
    await db
      .update(user)
      .set({ email: userEmail, name: deriveUserName(userEmail) })
      .where(eq(user.id, userId));

    return userEmail;
  }

  return existing.email;
}

async function resolveDelegatedContext(
  userId: string,
  userEmail: string,
): Promise<EnsuredUserContext> {
  const ensuredEmail = await ensureUserRecord(userId, userEmail);
  const organizationId = await ensureDelegatedOrganizationForUser(
    userId,
    ensuredEmail,
  );

  return {
    userId,
    userEmail: ensuredEmail,
    // Delegated auth (Cloudflare Access / local) has no unverified state.
    emailVerified: true,
    organizationId,
    // Delegated orgs are one-implicit-user with no member rows; that user has
    // full control of their own workspace.
    role: "owner",
  };
}

// Cloudflare Access mode: everyone the Access policy lets in works in one
// shared workspace, keeping their own user identity. Per-user workspaces were
// the pre-shared-workspace behavior; workspace-merge.ts folds those in.
export async function resolveSharedWorkspaceContext(
  userId: string,
  userEmail: string,
): Promise<EnsuredUserContext> {
  const ensuredEmail = await ensureUserRecord(userId, userEmail);
  const organizationId = await ensureSharedWorkspaceOrganization();

  return {
    userId,
    userEmail: ensuredEmail,
    emailVerified: true,
    organizationId,
    // The Access policy is the authorization boundary; everyone it admits has
    // full control of the shared workspace.
    role: "owner",
  };
}

export async function resolveLocalNoAuthContext(): Promise<EnsuredUserContext> {
  return resolveDelegatedContext(LOCAL_ADMIN_USER_ID, LOCAL_ADMIN_EMAIL);
}

export async function resolveSharedWorkspaceOwnerContext(): Promise<EnsuredUserContext> {
  // Access workspaces have no member rows. The first person who signed in
  // owns the workspace; machine callers reuse that identity without creating
  // or updating a user record.
  const [owner] = await db
    .select({ id: user.id, email: user.email })
    .from(user)
    .orderBy(asc(user.createdAt), asc(user.id))
    .limit(1);

  if (!owner) throw new AppError("UNAUTHENTICATED");

  return {
    userId: owner.id,
    userEmail: owner.email,
    emailVerified: true,
    organizationId: await ensureSharedWorkspaceOrganization(),
    role: "owner",
  };
}
