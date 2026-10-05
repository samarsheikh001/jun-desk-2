import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api, registerPasskey, type Me } from "./api.ts";
import { AiPanel } from "./AiPanel.tsx";
import { SavedRepliesPanel, TagsPanel } from "./settings/InboxPanels.tsx";
import { AppearancePanel, HoursPanel, type InboxSettings } from "./settings/WidgetPanels.tsx";
import { useAction } from "./useAction.ts";

interface Passkey { id: string; name: string | null; backedUp: number; createdAt: number; lastUsedAt: number | null }
type Role = "owner" | "admin" | "agent";
interface Member { id: string; name: string; email: string | null; role: Role }
interface Invite { id: string; role: Role; createdBy: string; createdAt: number; expiresAt: number }

const RANK: Record<Role, number> = { owner: 3, admin: 2, agent: 1 };
const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "never");

export function SettingsPage({ me }: { me: Me }) {
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
    <main className="content">
      {workspace && <InstallPanel workspaceId={workspace.workspaceId} canEdit={workspace.role !== "agent"} />}
      {workspace && <WidgetSettings workspaceId={workspace.workspaceId} workspaceName={workspace.workspaceName} canEdit={workspace.role !== "agent"} />}
      {workspace && <AiPanel workspaceId={workspace.workspaceId} canEdit={workspace.role !== "agent"} />}
      {workspace && <SavedRepliesPanel workspaceId={workspace.workspaceId} />}
      {workspace && <TagsPanel workspaceId={workspace.workspaceId} canEdit={workspace.role !== "agent"} />}

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

      {workspace && <TokensPanel workspaceId={workspace.workspaceId} />}
      {workspace && me.user && <TeamPanel workspaceId={workspace.workspaceId} myRole={workspace.role} myId={me.user.id} />}
    </main>
  );
}

function InstallPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const [widgetKey, setWidgetKey] = useState<string | null>(null);
  const [proactive, setProactive] = useState(true);
  const [copied, setCopied] = useState(false);
  const [domains, setDomains] = useState("");
  const [savedDomains, setSavedDomains] = useState("");
  const { busy, error, run } = useAction();
  useEffect(() => {
    api<{ inbox: { widgetKey: string; settings: { proactive?: boolean; allowedDomains?: string[] } } | null }>(`/workspaces/${workspaceId}/inbox`).then((r) => {
      setWidgetKey(r.inbox?.widgetKey ?? null);
      setProactive(r.inbox?.settings.proactive !== false);
      const list = (r.inbox?.settings.allowedDomains ?? []).join(", ");
      setDomains(list);
      setSavedDomains(list);
    });
  }, [workspaceId]);
  const saveDomains = () =>
    run(async () => {
      const r = await api<{ settings: { allowedDomains?: string[] } }>(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { allowedDomains: domains } });
      const list = (r.settings.allowedDomains ?? []).join(", ");
      setDomains(list);
      setSavedDomains(list);
    });
  const toggleProactive = async (value: boolean) => {
    setProactive(value);
    await api(`/workspaces/${workspaceId}/inbox`, { method: "PATCH", body: { proactive: value } });
  };
  if (!widgetKey) return null;

  const snippet = `<script src="${window.location.origin}/widget.js" data-key="${widgetKey}" async></script>`;
  return (
    <section className="panel">
      <div className="row">
        <h2>Install the chat widget</h2>
        <span className="spacer" />
        <a className="button ghost small" href={`/demo.html?key=${widgetKey}`} target="_blank" rel="noreferrer">Open demo page</a>
      </div>
      <p className="muted small">Paste this before <code>&lt;/body&gt;</code> on your site. The loader is tiny; the chat itself loads only when a visitor opens it.</p>
      <div className="invite">
        <div className="row">
          <code>{snippet}</code>
          <button className="small" onClick={async () => { await navigator.clipboard.writeText(snippet); setCopied(true); }}>{copied ? "Copied ✓" : "Copy"}</button>
        </div>
      </div>
      <label className="check small" style={{ marginTop: 12 }}>
        <input type="checkbox" checked={proactive} disabled={!canEdit} onChange={(e) => void toggleProactive(e.target.checked)} />
        Offer help when something breaks on the page (e.g. "Looks like your payment didn't go through. Want a hand?")
      </label>
      <div className="field" style={{ marginTop: 12 }}>
        <span className="small strong">Allowed websites</span>
        <div className="row">
          <input value={domains} onChange={(e) => setDomains(e.target.value)} disabled={!canEdit} placeholder="Any website (e.g. acme.com, *.acme.com)" style={{ flex: 1 }} />
          {canEdit && <button className="small" disabled={busy || domains === savedDomains} onClick={saveDomains}>Save</button>}
        </div>
        <small className="muted">
          Your widget key is public, so anyone could copy the snippet. List your sites and the widget won't open, track visitors or use AI anywhere else. Use <code>*.acme.com</code> for subdomains. This desk ({window.location.host}) always works for testing.
        </small>
        {error && <small className="error">{error}</small>}
      </div>
      <p className="muted small">
        Cookie banner? Add <code>data-consent="required"</code>: the widget then stores nothing and doesn't show the visitor on your live list until you call <code>JunDesk.consent(true)</code>.
      </p>
      {canEdit && <IdentityPanel workspaceId={workspaceId} />}
    </section>
  );
}

/** V-03: the secret the customer's backend signs identity tokens with. */
function IdentityPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}/identity`;
  const [secret, setSecret] = useState<string | null | undefined>(undefined);
  const [shown, setShown] = useState(false);
  const { busy, error, run } = useAction();
  useEffect(() => {
    api<{ secret: string | null }>(base).then((r) => setSecret(r.secret), () => setSecret(null));
  }, [base]);
  if (secret === undefined) return null;
  const example = `// On your server, for the signed-in user (any JWT library; HS256):
const userToken = jwt.sign(
  { sub: user.id, email: user.email, name: user.name, attributes: { plan: user.plan } },
  process.env.JUN_IDENTITY_SECRET,
  { algorithm: "HS256", expiresIn: "1h" },
);
// In the page: data-user-token="<userToken>" on the script tag, or
JunDesk.identify(userToken);   // and JunDesk.logout() when they sign out`;
  return (
    <div className="identity">
      <h3>Identify signed-in customers</h3>
      <p className="muted small">
        Your backend signs a short-lived token saying who the user is. Agents then see a verified name, email and attributes, the AI can greet them and look up <em>their</em> account
        ({"{user.id}"} in tools), and their chats follow them across devices. Without a valid token, visitors stay anonymous.
      </p>
      {secret ? (
        <>
          <div className="invite">
            <div className="row">
              <code className="small">{shown ? secret : `${secret.slice(0, 8)}${"•".repeat(24)}`}</code>
              <button className="ghost small" onClick={() => setShown(!shown)}>{shown ? "Hide" : "Show"}</button>
              <button className="ghost small" onClick={() => void navigator.clipboard?.writeText(secret)}>Copy</button>
            </div>
          </div>
          <pre className="code small">{example}</pre>
          <div className="row">
            <button className="ghost small" disabled={busy} onClick={() => { if (confirm("Rotate the secret? Tokens signed with the old one stop working right away.")) run(async () => setSecret((await api<{ secret: string }>(base, { body: {} })).secret)); }}>Rotate secret</button>
            <button className="ghost small" disabled={busy} onClick={() => { if (confirm("Turn off identity verification? Everyone becomes anonymous.")) run(async () => { await api(base, { method: "DELETE" }); setSecret(null); }); }}>Turn off</button>
          </div>
        </>
      ) : (
        <button className="small" disabled={busy} onClick={() => run(async () => { setSecret((await api<{ secret: string }>(base, { body: {} })).secret); setShown(true); })}>Create identity secret</button>
      )}
      {error && <p className="error small">{error}</p>}
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

interface TokenRow {
  id: string;
  name: string;
  createdAt: number;
  lastUsedAt: number | null;
}

/** Personal API tokens for the `jun` CLI (pull, push, eval). */
function TokensPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}/tokens`;
  const [tokens, setTokens] = useState<TokenRow[]>([]);
  const [created, setCreated] = useState<string | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setTokens((await api<{ tokens: TokenRow[] }>(base)).tokens), [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const create = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const name = String(new FormData(form).get("name"));
    run(async () => {
      setCreated((await api<{ token: string }>(base, { body: { name } })).token);
      form.reset();
      await load();
    });
  };

  return (
    <section className="panel">
      <h2>API tokens</h2>
      <p className="muted small">
        For the <code>jun</code> CLI: keep the agent in git, run evals and push changes (<code>npm run jun -- login {window.location.origin}</code> in your Jun Desk checkout). A token acts as you, for this workspace's agent config only.
      </p>
      {created && (
        <div className="invite">
          <span className="small strong">Copy it now: it won't be shown again.</span>
          <code className="small">{created}</code>
          <button className="ghost small" onClick={() => { void navigator.clipboard?.writeText(created); }}>Copy</button>
        </div>
      )}
      <form className="row" onSubmit={create} style={{ marginTop: 12 }}>
        <input name="name" placeholder="Token name, e.g. laptop or GitHub Actions" required maxLength={80} style={{ flex: 1 }} />
        <button disabled={busy}>Create token</button>
      </form>
      {error && <p className="error small">{error}</p>}
      {tokens.length > 0 && (
        <ul className="list">
          {tokens.map((t) => (
            <li key={t.id} className="row">
              <span className="strong">{t.name}</span>
              <span className="muted small">created {new Date(t.createdAt).toLocaleDateString()} · {t.lastUsedAt ? `last used ${new Date(t.lastUsedAt).toLocaleDateString()}` : "never used"}</span>
              <span className="spacer" />
              <button className="ghost small" disabled={busy} onClick={() => run(async () => { await api(`${base}/${t.id}`, { method: "DELETE" }); await load(); })}>Revoke</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** W-04 appearance and I-10 hours share the widget inbox's settings. */
function WidgetSettings({ workspaceId, workspaceName, canEdit }: { workspaceId: string; workspaceName: string; canEdit: boolean }) {
  const [inbox, setInbox] = useState<{ widgetKey: string; settings: InboxSettings } | null>(null);
  useEffect(() => {
    api<{ inbox: { widgetKey: string; settings: InboxSettings } | null }>(`/workspaces/${workspaceId}/inbox`).then((r) => setInbox(r.inbox), () => {});
  }, [workspaceId]);
  if (!inbox) return null;
  const onSaved = (settings: InboxSettings) => setInbox({ ...inbox, settings });
  return (
    <>
      <AppearancePanel workspaceId={workspaceId} widgetKey={inbox.widgetKey} workspaceName={workspaceName} settings={inbox.settings} canEdit={canEdit} onSaved={onSaved} />
      <HoursPanel workspaceId={workspaceId} settings={inbox.settings} canEdit={canEdit} onSaved={onSaved} />
    </>
  );
}
