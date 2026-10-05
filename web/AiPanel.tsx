import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { navigate } from "./lib/router.ts";
import { useAction } from "./useAction.ts";

type ProviderId = "openai" | "workers-ai" | "chatgpt";

interface AiState {
  settings: { enabled: boolean; provider: ProviderId; model: string | null; instructions: string; monthlyReplyCap: number };
  defaults: Record<ProviderId, string>;
  openaiKeyConfigured: boolean;
  devChatgpt: { available: boolean; connected: boolean; email: string | null };
  usage: { month: string; replies: number; inputTokens: number; outputTokens: number };
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  "workers-ai": "Workers AI (built in, no key needed)",
  openai: "OpenAI (API key)",
  chatgpt: "ChatGPT sign-in (development only)",
};

export function AiPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/ai`;
  const [state, setState] = useState<AiState | null>(null);
  const [provider, setProvider] = useState<ProviderId>("workers-ai");
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    const next = await api<AiState>(base);
    setState(next);
    setProvider(next.settings.provider);
  }, [base]);
  useEffect(() => {
    load().catch(() => {});
    // Back from ChatGPT sign-in.
    if (new URLSearchParams(window.location.search).get("chatgpt") === "connected") window.history.replaceState(null, "", "/settings");
  }, [load]);

  if (!state) return null;
  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    run(async () => {
      await api(base, {
        method: "PUT",
        body: {
          enabled: data.get("enabled") === "on",
          provider,
          model: data.get("model"),
          monthlyReplyCap: Number(data.get("cap")),
        },
      });
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  const providers: ProviderId[] = ["workers-ai", "openai", ...(state.devChatgpt.available || state.settings.provider === "chatgpt" ? (["chatgpt"] as const) : [])];

  return (
    <section className="panel">
      <div className="row">
        <h2>AI assistant</h2>
        <span className="spacer" />
        <span className="muted small">
          {state.usage.replies} / {state.settings.monthlyReplyCap} replies this month
        </span>
      </div>
      <p className="muted small">When on, the assistant answers new website chats from your Knowledge, with citations, and hands off to your team when it can't help.</p>
      <form onSubmit={save} className="ai-form">
        <label className="check">
          <input type="checkbox" name="enabled" defaultChecked={state.settings.enabled} disabled={!canEdit} /> Answer new chats with AI
        </label>
        <label className="field">
          <span>Model provider</span>
          <select value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)} disabled={!canEdit}>
            {providers.map((p) => (
              <option key={p} value={p}>{PROVIDER_LABELS[p]}</option>
            ))}
          </select>
        </label>
        {provider === "openai" && !state.openaiKeyConfigured && (
          <p className="small error">Set the <code>OPENAI_API_KEY</code> Worker secret (<code>npx wrangler secret put OPENAI_API_KEY</code>) to use OpenAI.</p>
        )}
        {provider === "chatgpt" && (
          <div className="small chatgpt-box">
            {state.devChatgpt.connected ? (
              <span>Connected as <strong>{state.devChatgpt.email ?? "your ChatGPT account"}</strong>. Replies use your ChatGPT plan.</span>
            ) : (
              <span>Not connected.</span>
            )}{" "}
            {canEdit && state.devChatgpt.available && (
              <button type="button" className="ghost small" disabled={busy} onClick={() => run(async () => {
                window.location.href = (await api<{ url: string }>(`${base}/chatgpt/start`, { body: {} })).url;
              })}>
                {state.devChatgpt.connected ? "Reconnect" : "Sign in with ChatGPT"}
              </button>
            )}
            {canEdit && state.devChatgpt.connected && (
              <button type="button" className="ghost small" disabled={busy} onClick={() => run(async () => { await api(`${base}/chatgpt`, { method: "DELETE" }); await load(); })}>Disconnect</button>
            )}
            <div className="muted">For local development only: OpenAI allows plan usage in open-source apps running on your own machine. Deployed desks use an API key or Workers AI.</div>
          </div>
        )}
        <label className="field">
          <span>Model <span className="muted">(optional)</span></span>
          <input name="model" defaultValue={state.settings.model ?? ""} placeholder={state.defaults[provider]} disabled={!canEdit} />
        </label>
        <p className="small muted">
          Tone, rules, procedures and tools are in{" "}
          <a href="/agent" onClick={(e) => { e.preventDefault(); navigate("/agent"); }}>Agent</a>, as files you can also keep in git.
        </p>
        <label className="field">
          <span>Monthly reply cap</span>
          <input name="cap" type="number" min={0} defaultValue={state.settings.monthlyReplyCap} disabled={!canEdit} />
          <small className="muted">When reached, chats go straight to your team. The assistant never just goes silent.</small>
        </label>
        {error && <p className="error">{error}</p>}
        {canEdit && <div className="row"><button disabled={busy}>Save</button>{saved && <span className="muted small">Saved ✓</span>}</div>}
      </form>
    </section>
  );
}
