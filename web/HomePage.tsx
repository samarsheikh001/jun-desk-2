import { useCallback, useEffect, useState } from "react";
import { api, registerPasskey, type Me } from "./api.ts";
import { useAction } from "./useAction.ts";

interface Passkey { id: string; name: string | null; backedUp: number; createdAt: number; lastUsedAt: number | null }
type Role = "owner" | "admin" | "agent";
interface Member { id: string; name: string; email: string | null; role: Role }
interface Invite { id: string; role: Role; createdBy: string; createdAt: number; expiresAt: number }

const RANK: Record<Role, number> = { owner: 3, admin: 2, agent: 1 };
const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "never");

export function HomePage({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const workspace = me.memberships?.[0];
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const { busy, error, run } = useAction();

  const loadPasskeys = useCallback(async () => {
    setPasskeys((await api<{ passkeys: Passkey[] }>("/passkeys")).passkeys);
  }, []);
  useEffect(() => {
    loadPasskeys().catch(() => {});
  }, [loadPasskeys]);

  return (
    <div className="app">
      <header>
        <div className="brand">Jun Desk</div>
        <span className="muted">{workspace?.workspaceName}</span>
        <span className="spacer" />
        <span>{me.user?.name}</span>
        <button className="ghost" onClick={() => run(async () => { await api("/auth/logout", { body: {} }); onSignOut(); })}>Sign out</button>
      </header>
      <main className="content">
        <section className="panel notice">
          <h2>You're in 🎉</h2>
          <p className="muted">The inbox, widget and AI agent arrive in the next milestones (M1–M2). For now you can manage passkeys and your team.</p>
        </section>

        {error && <p className="error">{error}</p>}

        <section className="panel">
          <div className="row">
            <h2>Your passkeys</h2>
            <span className="spacer" />
            <button disabled={busy} onClick={() => run(async () => { await registerPasskey("/passkeys"); await loadPasskeys(); })}>Add passkey</button>
          </div>
          <p className="muted small">Add a passkey on a second device so you can't get locked out.</p>
          <ul className="list">
            {passkeys.map((p) => (
              <li key={p.id}>
                <span>{p.name ?? "Passkey"} {p.backedUp ? <em className="tag">synced</em> : null}</span>
                <span className="muted small">added {date(p.createdAt)} · last used {date(p.lastUsedAt)}</span>
                {passkeys.length > 1 && (
                  <button className="ghost small" disabled={busy} onClick={() => run(async () => { await api(`/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }); await loadPasskeys(); })}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        </section>

        {workspace && me.user && <TeamPanel workspaceId={workspace.workspaceId} myRole={workspace.role} myId={me.user.id} />}
      </main>
    </div>
  );
}

function TeamPanel({ workspaceId, myRole, myId }: { workspaceId: string; myRole: Role; myId: string }) {
  const [members, setMembers] = useState<Member[]>([]);
  const [invites, setInvites] = useState<Invite[]>([]);
  const [inviteRole, setInviteRole] = useState<"agent" | "admin">("agent");
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const { busy, error, run } = useAction();
  const canInvite = myRole === "owner" || myRole === "admin";
  const base = `/workspaces/${workspaceId}`;

  const load = useCallback(async () => {
    setMembers((await api<{ members: Member[] }>(`${base}/members`)).members);
    if (canInvite) setInvites((await api<{ invites: Invite[] }>(`${base}/invites`)).invites);
  }, [base, canInvite]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const createInvite = () =>
    run(async () => {
      setCopied(false);
      setInviteUrl((await api<{ url: string }>(`${base}/invites`, { body: { role: inviteRole } })).url);
      await load();
    });

  const copy = async () => {
    if (!inviteUrl) return;
    await navigator.clipboard.writeText(inviteUrl);
    setCopied(true);
  };

  return (
    <section className="panel">
      <div className="row">
        <h2>Team</h2>
        <span className="spacer" />
        {canInvite && (
          <>
            <select value={inviteRole} onChange={(e) => setInviteRole(e.target.value as "agent" | "admin")} aria-label="Invite role">
              <option value="agent">Agent</option>
              {myRole === "owner" && <option value="admin">Admin</option>}
            </select>
            <button disabled={busy} onClick={createInvite}>Create invite link</button>
          </>
        )}
      </div>
      <p className="muted small">
        Each person signs in with their own passkey. Invite links work once and expire after 7 days.
        {myRole === "owner" && " Admins can invite and manage agents; only you can manage admins."}
      </p>

      {inviteUrl && (
        <div className="invite">
          <span className="small">Send this link to the person you're inviting. It's shown only once.</span>
          <div className="row">
            <code>{inviteUrl}</code>
            <button className="small" onClick={copy}>{copied ? "Copied ✓" : "Copy"}</button>
          </div>
        </div>
      )}
      {error && <p className="error">{error}</p>}

      <ul className="list">
        {members.map((m) => {
          const manageable = RANK[myRole] > RANK[m.role];
          return (
            <li key={m.id}>
              <span>{m.name}{m.id === myId && <span className="muted"> (you)</span>}</span>
              <span className="muted small">{m.email}</span>
              {manageable ? (
                <>
                  <select
                    value={m.role}
                    disabled={busy}
                    aria-label={`Role for ${m.name}`}
                    onChange={(e) => run(async () => { await api(`${base}/members/${m.id}`, { method: "PATCH", body: { role: e.target.value } }); await load(); })}
                  >
                    <option value="agent">agent</option>
                    {myRole === "owner" && <option value="admin">admin</option>}
                  </select>
                  <button
                    className="ghost small"
                    disabled={busy}
                    onClick={() => {
                      if (!confirm(`Remove ${m.name}? They'll be signed out and lose access.`)) return;
                      run(async () => { await api(`${base}/members/${m.id}`, { method: "DELETE" }); await load(); });
                    }}
                  >
                    Remove
                  </button>
                </>
              ) : (
                <em className="tag">{m.role}</em>
              )}
            </li>
          );
        })}
      </ul>

      {canInvite && invites.length > 0 && (
        <>
          <h3>Pending invites</h3>
          <ul className="list">
            {invites.map((i) => (
              <li key={i.id}>
                <span>{i.role === "admin" ? "Admin" : "Agent"} invite</span>
                <span className="muted small">by {i.createdBy} · expires {date(i.expiresAt)}</span>
                <button className="ghost small" disabled={busy} onClick={() => run(async () => { await api(`${base}/invites/${encodeURIComponent(i.id)}`, { method: "DELETE" }); await load(); })}>Revoke</button>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
