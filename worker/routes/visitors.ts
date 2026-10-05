import { Hono } from "hono";
import { requireUser } from "../auth/session.ts";
import { newId, randomToken } from "../lib/crypto.ts";
import { readJson, text } from "../lib/validate.ts";
import { HttpError, type AppContext, type AppEnv, type Role } from "../types.ts";

// M6: identity verification settings (V-03), contacts (V-05) and agent-started chats (V-07).

const INVITE_TTL_MS = 30 * 60 * 1000;

async function memberRole(c: AppContext, workspaceId: string): Promise<Role> {
  const row = await c.env.DB.prepare("SELECT role FROM members WHERE workspace_id = ? AND user_id = ?").bind(workspaceId, c.get("user").id).first<{ role: Role }>();
  if (!row) throw new HttpError(404, "not_found", "Workspace not found.");
  return row.role;
}

async function requireAdmin(c: AppContext, workspaceId: string): Promise<void> {
  if ((await memberRole(c, workspaceId)) === "agent") throw new HttpError(403, "forbidden", "Only owners and admins can change this.");
}

export const visitors = new Hono<AppEnv>();
visitors.use("/workspaces/:id/identity", requireUser);
visitors.use("/workspaces/:id/visitors/*", requireUser);
visitors.use("/workspaces/:id/contacts/*", requireUser);

// The identity secret is shown to admins so they can put it in their backend. Rotating it
// revokes every identity token signed with the old one.
visitors.get("/workspaces/:id/identity", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const row = await c.env.DB.prepare("SELECT identity_secret FROM inboxes WHERE workspace_id = ? ORDER BY created_at LIMIT 1").bind(workspaceId).first<{ identity_secret: string | null }>();
  return c.json({ secret: row?.identity_secret ?? null });
});

visitors.post("/workspaces/:id/identity", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  const secret = `jis_${randomToken(32)}`;
  await c.env.DB.prepare("UPDATE inboxes SET identity_secret = ? WHERE workspace_id = ?").bind(secret, workspaceId).run();
  return c.json({ secret });
});

visitors.delete("/workspaces/:id/identity", async (c) => {
  const workspaceId = c.req.param("id");
  await requireAdmin(c, workspaceId);
  await c.env.DB.prepare("UPDATE inboxes SET identity_secret = NULL WHERE workspace_id = ?").bind(workspaceId).run();
  return c.json({ secret: null });
});

// V-07: an agent's opening message to a live visitor. Shown on their page; if they reply,
// the conversation starts with it and is assigned to this agent.
visitors.post("/workspaces/:id/visitors/:sid/invite", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const body = text(await readJson(c.req), "body", { max: 1000 });
  const user = c.get("user");
  const id = newId("inv");
  const now = Date.now();
  await c.env.DB.prepare("INSERT INTO visitor_invites (id, workspace_id, session_id, user_id, body, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
    .bind(id, workspaceId, c.req.param("sid"), user.id, body, now, now + INVITE_TTL_MS)
    .run();
  const workspace = await c.env.DB.prepare("SELECT name FROM workspaces WHERE id = ?").bind(workspaceId).first<{ name: string }>();
  const delivered = await c.env.WORKSPACE_HUB.getByName(workspaceId).invite(c.req.param("sid"), { id, body, from: `${user.name} from ${workspace?.name ?? "support"}` });
  if (!delivered) throw new HttpError(410, "visitor_left", "This visitor has left the site.");
  return c.json({ id });
});

// V-05: who a contact is, as the host app told us (agents only).
visitors.get("/workspaces/:id/contacts/:contactId", async (c) => {
  const workspaceId = c.req.param("id");
  await memberRole(c, workspaceId);
  const row = await c.env.DB.prepare(
    "SELECT id, name, email, external_id, verified_at, attributes, created_at, last_seen_at FROM contacts WHERE id = ? AND workspace_id = ?",
  )
    .bind(c.req.param("contactId"), workspaceId)
    .first<{ id: string; name: string | null; email: string | null; external_id: string | null; verified_at: number | null; attributes: string; created_at: number; last_seen_at: number }>();
  if (!row) throw new HttpError(404, "not_found", "Contact not found.");
  return c.json({
    contact: {
      id: row.id,
      name: row.name,
      email: row.email,
      externalId: row.external_id,
      verified: row.verified_at !== null,
      verifiedAt: row.verified_at,
      attributes: JSON.parse(row.attributes) as Record<string, string | number | boolean>,
      createdAt: row.created_at,
      lastSeenAt: row.last_seen_at,
    },
  });
});
