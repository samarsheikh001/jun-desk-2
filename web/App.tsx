import { useCallback, useEffect, useState, type FormEvent, type InputHTMLAttributes, type ReactNode } from "react";
import { api, describeError, registerPasskey, signInWithPasskey, type Me } from "./api.ts";

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    api<Me>("/me").then(setMe, (e) => setLoadError(describeError(e)));
  }, []);
  useEffect(refresh, [refresh]);

  const path = window.location.pathname;
  const invite = path.match(/^\/invite\/([\w-]+)$/);
  const done = () => {
    window.history.replaceState(null, "", "/");
    refresh();
  };

  if (loadError) return <Card title="Can't reach Jun Desk"><p className="error">{loadError}</p></Card>;
  if (!me) return <div className="center muted">Loading…</div>;
  if (invite?.[1]) return <InvitePage token={invite[1]} onDone={done} />;
  if (path === "/recover") return <RecoverPage onDone={done} />;
  if (!me.setupComplete) return <SetupPage onDone={done} />;
  if (!me.user) return <LoginPage onDone={refresh} />;
  return <HomePage me={me} onSignOut={refresh} />;
}

function Card({ title, subtitle, children }: { title: string; subtitle?: string; children: ReactNode }) {
  return (
    <main className="center">
      <div className="card">
        <div className="brand">Jun Desk</div>
        <h1>{title}</h1>
        {subtitle && <p className="muted">{subtitle}</p>}
        {children}
      </div>
    </main>
  );
}

function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (action: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (e) {
      setError(describeError(e));
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

function Field({ label, hint, ...props }: { label: string; hint?: string } & InputHTMLAttributes<HTMLInputElement>) {
  return (
    <label className="field">
      <span>{label}</span>
      <input {...props} />
      {hint && <small className="muted">{hint}</small>}
    </label>
  );
}

const formValues = (e: FormEvent<HTMLFormElement>) => Object.fromEntries(new FormData(e.currentTarget)) as Record<string, string>;

function SetupPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    run(async () => {
      await registerPasskey("/setup", { token: v.token, workspaceName: v.workspaceName, name: v.name, email: v.email });
      onDone();
    });
  };
  return (
    <Card title="Set up your desk" subtitle="Create the owner account. You'll sign in with a passkey: your fingerprint, face, or device PIN.">
      <form onSubmit={submit}>
        <Field label="Setup token" name="token" type="password" required autoComplete="off" hint="The SETUP_TOKEN you chose when deploying." />
        <Field label="Workspace name" name="workspaceName" required placeholder="Acme Support" />
        <Field label="Your name" name="name" required autoComplete="name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? "Waiting for passkey…" : "Create passkey and finish setup"}</button>
      </form>
    </Card>
  );
}

function LoginPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  return (
    <Card title="Sign in" subtitle="Use the passkey you created for this desk.">
      {error && <p className="error">{error}</p>}
      <button disabled={busy} onClick={() => run(async () => { await signInWithPasskey(); onDone(); })}>
        {busy ? "Waiting for passkey…" : "Sign in with passkey"}
      </button>
      <p className="muted small">Lost access to your passkeys? <a href="/recover">Recover the owner account</a></p>
    </Card>
  );
}

function RecoverPage({ onDone }: { onDone: () => void }) {
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const { token } = formValues(e);
    run(async () => {
      await registerPasskey("/recover", { token });
      onDone();
    });
  };
  return (
    <Card title="Recover owner access" subtitle="Enter the setup token to add a new passkey to the owner account.">
      <form onSubmit={submit}>
        <Field label="Setup token" name="token" type="password" required autoComplete="off" />
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? "Waiting for passkey…" : "Add a new passkey"}</button>
      </form>
      <p className="muted small"><a href="/">Back to sign in</a></p>
    </Card>
  );
}

function InvitePage({ token, onDone }: { token: string; onDone: () => void }) {
  const [invite, setInvite] = useState<{ workspaceName: string; role: string } | null>(null);
  const { busy, error, run } = useAction();
  const [loadError, setLoadError] = useState<string | null>(null);
  useEffect(() => {
    api<{ workspaceName: string; role: string }>(`/invites/${token}`).then(setInvite, (e) => setLoadError(describeError(e)));
  }, [token]);

  if (loadError) return <Card title="Invite not available"><p className="error">{loadError}</p></Card>;
  if (!invite) return <div className="center muted">Loading…</div>;
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const v = formValues(e);
    run(async () => {
      await registerPasskey(`/invites/${token}`, { name: v.name, email: v.email });
      onDone();
    });
  };
  return (
    <Card title={`Join ${invite.workspaceName}`} subtitle={`You've been invited as ${invite.role === "admin" ? "an admin" : "an agent"}.`}>
      <form onSubmit={submit}>
        <Field label="Your name" name="name" required autoComplete="name" />
        <Field label="Email" name="email" type="email" required autoComplete="email" />
        {error && <p className="error">{error}</p>}
        <button disabled={busy}>{busy ? "Waiting for passkey…" : "Create passkey and join"}</button>
      </form>
    </Card>
  );
}

interface Passkey { id: string; name: string | null; backedUp: number; createdAt: number; lastUsedAt: number | null }
interface Member { id: string; name: string; email: string | null; role: string }

function HomePage({ me, onSignOut }: { me: Me; onSignOut: () => void }) {
  const workspace = me.memberships?.[0];
  const [passkeys, setPasskeys] = useState<Passkey[]>([]);
  const [members, setMembers] = useState<Member[]>([]);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    setPasskeys((await api<{ passkeys: Passkey[] }>("/passkeys")).passkeys);
    if (workspace) setMembers((await api<{ members: Member[] }>(`/workspaces/${workspace.workspaceId}/members`)).members);
  }, [workspace]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const canInvite = workspace?.role === "owner" || workspace?.role === "admin";
  const date = (ms: number | null) => (ms ? new Date(ms).toLocaleDateString() : "never");

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
            <button disabled={busy} onClick={() => run(async () => { await registerPasskey("/passkeys"); await load(); })}>Add passkey</button>
          </div>
          <p className="muted small">Add a passkey on a second device so you can't get locked out.</p>
          <ul className="list">
            {passkeys.map((p) => (
              <li key={p.id}>
                <span>{p.name ?? "Passkey"} {p.backedUp ? <em className="tag">synced</em> : null}</span>
                <span className="muted small">added {date(p.createdAt)} · last used {date(p.lastUsedAt)}</span>
                {passkeys.length > 1 && (
                  <button className="ghost small" disabled={busy} onClick={() => run(async () => { await api(`/passkeys/${encodeURIComponent(p.id)}`, { method: "DELETE" }); await load(); })}>Remove</button>
                )}
              </li>
            ))}
          </ul>
        </section>

        <section className="panel">
          <div className="row">
            <h2>Team</h2>
            <span className="spacer" />
            {canInvite && workspace && (
              <button disabled={busy} onClick={() => run(async () => {
                setInviteUrl((await api<{ url: string }>(`/workspaces/${workspace.workspaceId}/invites`, { body: { role: "agent" } })).url);
              })}>Invite agent</button>
            )}
          </div>
          {inviteUrl && (
            <p className="invite">Send this link (valid 7 days, single use):<br /><code>{inviteUrl}</code></p>
          )}
          <ul className="list">
            {members.map((m) => (
              <li key={m.id}>
                <span>{m.name}</span>
                <span className="muted small">{m.email}</span>
                <em className="tag">{m.role}</em>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
