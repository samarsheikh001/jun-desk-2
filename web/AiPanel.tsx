import { useCallback, useEffect, useRef, useState, type FormEvent } from "react";
import { api } from "./api.ts";
import { navigate } from "./lib/router.ts";
import { useAction } from "./useAction.ts";
import { Card } from "@/components/ui/card.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select.tsx";

type ProviderId = "openai" | "workers-ai" | "chatgpt";
type AiJob = "answer" | "brief" | "nudge" | "draft" | "topics" | "judge" | "suggestions";

interface AiState {
  settings: { enabled: boolean; provider: ProviderId; model: string | null; models: Partial<Record<AiJob, string>>; instructions: string; monthlyReplyCap: number };
  defaults: Record<ProviderId, string>;
  effectiveModels: Record<AiJob, string>;
  openaiKeyConfigured: boolean;
  devChatgpt: { available: boolean; connected: boolean; email: string | null };
  usage: { month: string; replies: number; inputTokens: number; outputTokens: number };
}

const PROVIDER_LABELS: Record<ProviderId, string> = {
  "workers-ai": "Workers AI (built in, no key needed)",
  openai: "OpenAI (API key)",
  chatgpt: "ChatGPT sign-in (your plan)",
};

// AI-16: every AI job, in Settings order.
const JOBS: { job: AiJob; label: string; hint: string }[] = [
  { job: "answer", label: "Replies to visitors", hint: "Also the replies evals test." },
  { job: "brief", label: "Handoff briefs", hint: "Fast job: a short summary for your team." },
  { job: "nudge", label: "Nudges and openers", hint: "Fast job: one line when a visitor gets stuck." },
  { job: "draft", label: "Issue drafts", hint: "Bug reports written from a conversation." },
  { job: "topics", label: "Topic labels", hint: "Fast job: labels for Reports." },
  { job: "judge", label: "Eval grading", hint: "Checks eval replies against your criteria." },
  { job: "suggestions", label: "Suggested questions", hint: "Drafts the widget's questions from your knowledge (Appearance)." },
];
// "Suggested for ChatGPT": the small model for fast jobs, the workspace model for the rest.
const CHATGPT_FAST_MODEL = "gpt-6-luna";
const FAST_JOBS: AiJob[] = ["nudge", "topics", "brief"];

export function AiPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/ai`;
  const [state, setState] = useState<AiState | null>(null);
  const [provider, setProvider] = useState<ProviderId>("workers-ai");
  const [model, setModel] = useState("");
  const [models, setModels] = useState<Partial<Record<AiJob, string>>>({});
  const [saved, setSaved] = useState(false);
  // Deployed desks: the sign-in returns to a 127.0.0.1 page that doesn't load; its address is pasted here.
  const [pasting, setPasting] = useState(false);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    const next = await api<AiState>(base);
    setState(next);
    setProvider(next.settings.provider);
    setModel(next.settings.model ?? "");
    setModels(next.settings.models ?? {});
  }, [base]);
  useEffect(() => {
    load().catch(() => {});
    // Back from ChatGPT sign-in.
    if (new URLSearchParams(window.location.search).get("chatgpt") === "connected") window.history.replaceState(null, "", "/settings");
  }, [load]);
  // Linked from Reports' "AI is off" card.
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (state && window.location.hash === "#ai-assistant") panel.current?.scrollIntoView({ block: "start" });
  }, [state !== null]);

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
          model,
          models,
          monthlyReplyCap: Number(data.get("cap")),
        },
      });
      await load();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  const workspaceModel = model.trim() || state.defaults[provider];
  const overrides = JOBS.filter(({ job }) => models[job]?.trim()).length;
  const providers: ProviderId[] = ["workers-ai", "openai", ...(state.devChatgpt.available || state.settings.provider === "chatgpt" ? (["chatgpt"] as const) : [])];

  return (
    <Card className="panel" id="ai-assistant" ref={panel}>
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
          <NativeSelect value={provider} onChange={(e) => setProvider(e.target.value as ProviderId)} disabled={!canEdit}>
            {providers.map((p) => (
              <NativeSelectOption key={p} value={p}>{PROVIDER_LABELS[p]}</NativeSelectOption>
            ))}
          </NativeSelect>
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
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => run(async () => { const { url, paste } = await api<{ url: string; paste: boolean }>(`${base}/chatgpt/start`, { body: {} }); if (!paste) { window.location.href = url; return; } window.open(url, "_blank", "noopener"); setPasting(true); })}>
                {state.devChatgpt.connected ? "Reconnect" : "Sign in with ChatGPT"}
              </Button>
            )}
            {canEdit && state.devChatgpt.connected && (
              <Button variant="outline" size="sm" type="button" disabled={busy} onClick={() => run(async () => { await api(`${base}/chatgpt`, { method: "DELETE" }); await load(); })}>Disconnect</Button>
            )}
            {pasting && (
              <div className="stack chatgpt-paste">
                <span>After you approve in the new tab, it ends on a page that doesn't load (<code>http://127.0.0.1:1455/auth/callback?…</code>). Copy that page's address and paste it here.</span>
                <div className="row">
                  <Input name="callbackUrl" placeholder="http://127.0.0.1:1455/auth/callback?code=…" aria-label="Sign-in return address" autoComplete="off" />
                  <Button size="sm" type="button" disabled={busy} onClick={(e) => { const input = e.currentTarget.parentElement?.querySelector("input"); run(async () => { await api(`${base}/chatgpt/finish`, { body: { callbackUrl: input?.value ?? "" } }); setPasting(false); await load(); }); }}>Finish</Button>
                </div>
              </div>
            )}
            <div className="muted">Replies spend the signed-in ChatGPT plan. Only for a private desk: OpenAI's terms cover plan usage for your own use, not for serving the public.</div>
          </div>
        )}
        <label className="field">
          <span>Model <span className="muted">(optional)</span></span>
          <Input name="model" value={model} onChange={(e) => setModel(e.target.value)} placeholder={state.defaults[provider]} disabled={!canEdit} />
        </label>
        <details className="job-models" open={overrides > 0}>
          <summary className="small">Advanced: model per task{overrides > 0 ? ` (${overrides} set)` : ""}</summary>
          <div className="job-models-body">
            <p className="small muted">
              Each task uses the model above unless you name another model from the same provider. Fast jobs (nudge, topics, brief) do well on a small model. If the provider
              doesn't recognise a model here, that task falls back to the model above.
            </p>
            {canEdit && provider === "chatgpt" && (
              <div className="row">
                <Button variant="outline" size="sm" type="button" onClick={() => setModels(Object.fromEntries(FAST_JOBS.map((job) => [job, CHATGPT_FAST_MODEL])))}>
                  Suggested for ChatGPT
                </Button>
                <span className="muted small">{CHATGPT_FAST_MODEL} for the fast jobs; the rest stay on the model above.</span>
              </div>
            )}
            <div className="job-model-grid">
              {JOBS.map(({ job, label, hint }) => (
                <label className="field" key={job}>
                  <span>{label}</span>
                  <Input
                    name={`model-${job}`}
                    value={models[job] ?? ""}
                    onChange={(e) => setModels((m) => ({ ...m, [job]: e.target.value }))}
                    placeholder={workspaceModel}
                    disabled={!canEdit}
                    autoComplete="off"
                    spellCheck={false}
                  />
                  <small className="muted">{hint}</small>
                </label>
              ))}
            </div>
          </div>
        </details>
        <p className="small muted">
          Tone, rules, procedures and tools are in{" "}
          <a href="/agent" onClick={(e) => { e.preventDefault(); navigate("/agent"); }}>Agent</a>, as files you can also keep in git.
        </p>
        <label className="field">
          <span>Monthly reply cap</span>
          <Input name="cap" type="number" min={0} defaultValue={state.settings.monthlyReplyCap} disabled={!canEdit} />
          <small className="muted">When reached, chats go straight to your team. The assistant never just goes silent.</small>
        </label>
        {error && <p className="error">{error}</p>}
        {canEdit && <div className="row"><Button disabled={busy}>Save</Button>{saved && <span className="muted small">Saved ✓</span>}</div>}
      </form>
    </Card>
  );
}
