import type { RegistrationResponseJSON } from "@simplewebauthn/server";
import { Hono } from "hono";
import { finishRegistration, startRegistration } from "../auth/passkeys.ts";
import { createSession, requireUser } from "../auth/session.ts";
import { newId, randomToken, sha256 } from "../lib/crypto.ts";
import { email, object, readJson, text } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

async function requireRole(c: AppContext, workspaceId: string, allowed: Role[]): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?")
    .bind(workspaceId, c.get("user").id)
    .first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  if (!allowed.includes(row.role)) throw new HttpError(403, "forbidden", "You don't have permission to do that.");
  return row.role;
}

async function findInvite(c: AppContext, token: string) {
  const invite = await c.env.DB.prepare(
    `SELECT i.token_hash AS tokenHash, i.workspace_id AS workspaceId, i.role, w.name AS workspaceName
     FROM invites i JOIN workspaces w ON w.id = i.workspace_id
     WHERE i.token_hash = ? AND i.used_at IS NULL AND i.expires_at > ?`,
  )
    .bind(await sha256(token), Date.now())
    .first<{ tokenHash: string; workspaceId: string; role: Role; workspaceName: string }>();
  if (!invite) throw new HttpError(410, "invite_invalid", "This invite link is invalid, used, or expired.");
  return invite;
}

export const workspaces = new Hono<AppEnv>();

workspaces.get("/workspaces/:id/members", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  await requireRole(c, workspaceId, ["owner", "admin", "agent"]);
  const rows = await c.env.DB.prepare(
    `SELECT u.id, u.name, u.email, m.role, m.created_at AS joinedAt FROM members m
     JOIN users u ON u.id = m.user_id WHERE m.workspace_id = ? ORDER BY m.created_at`,
  )
    .bind(workspaceId)
    .all();
  return c.json({ members: rows.results });
});

workspaces.post("/workspaces/:id/invites", requireUser, async (c) => {
  const workspaceId = c.req.param("id");
  await requireRole(c, workspaceId, ["owner", "admin"]);
  const body = await readJson(c.req);
  const role = text(body, "role", { max: 10 });
  if (role !== "admin" && role !== "agent") throw new HttpError(400, "invalid_field", "Role must be admin or agent.");

  const token = randomToken();
  const now = Date.now();
  await c.env.DB.prepare(
    "INSERT INTO invites (token_hash, workspace_id, role, created_by, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)",
  )
    .bind(await sha256(token), workspaceId, role, c.get("user").id, now, now + INVITE_TTL_MS)
    .run();
  return c.json({ url: `${new URL(c.req.url).origin}/invite/${token}`, expiresAt: now + INVITE_TTL_MS });
});

workspaces.get("/invites/:token", async (c) => {
  const invite = await findInvite(c, c.req.param("token"));
  return c.json({ workspaceName: invite.workspaceName, role: invite.role });
});

workspaces.post("/invites/:token/options", async (c) => {
  const invite = await findInvite(c, c.req.param("token"));
  const body = await readJson(c.req);
  const user = { id: newId("usr"), name: text(body, "name", { max: 100 }), email: email(body) };
  const taken = await c.env.DB.prepare("SELECT 1 FROM users WHERE email = ?").bind(user.email).first();
  if (taken) throw new HttpError(409, "email_taken", "An account with that email already exists. Sign in instead.");
  return c.json(await startRegistration(c, "invite", user, { user, inviteHash: invite.tokenHash, workspaceId: invite.workspaceId, role: invite.role }));
});

workspaces.post("/invites/:token/verify", async (c) => {
  const body = await readJson(c.req);
  type Payload = { userId: string; user: { id: string; name: string; email: string }; inviteHash: string; workspaceId: string; role: Role };
  const invite = await findInvite(c, c.req.param("token"));
  const now = Date.now();
  const { userId } = await finishRegistration<Payload>(c, "invite", object<RegistrationResponseJSON>(body, "response"), (p) => {
    if (p.inviteHash !== invite.tokenHash) throw new HttpError(400, "invite_mismatch", "This passkey was started for a different invite.");
    return [
      c.env.DB.prepare("UPDATE invites SET used_at = ? WHERE token_hash = ? AND used_at IS NULL").bind(now, p.inviteHash),
      c.env.DB.prepare("INSERT INTO users (id, name, email, created_at) VALUES (?, ?, ?, ?)").bind(p.user.id, p.user.name, p.user.email, now),
      c.env.DB.prepare("INSERT INTO members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)").bind(p.workspaceId, p.user.id, p.role, now),
    ];
  });
  await createSession(c, userId);
  return c.json({ ok: true });
});
