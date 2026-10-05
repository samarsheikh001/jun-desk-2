import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";
import { SourceDetail } from "./SourceDetail.tsx";

interface SourceRow {
  id: string;
  kind: "website" | "snippet";
  url: string | null;
  title: string;
  status: "pending" | "syncing" | "ready" | "error";
  pageCount: number;
  pendingJobs: number;
  chunkCount: number;
  error: string | null;
  lastSyncedAt: number | null;
}

interface Hit {
  id: string;
  title: string;
  heading: string;
  url: string | null;
  text: string;
  score: number;
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

const ago = (ms: number | null) => {
  if (!ms) return "never";
  const minutes = Math.round((Date.now() - ms) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : new Date(ms).toLocaleDateString();
};

export function KnowledgePage({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/knowledge`;
  const [sources, setSources] = useState<SourceRow[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => setSources((await api<{ sources: SourceRow[] }>(base)).sources), [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  // Poll while something is crawling.
  const syncing = sources?.some((s) => s.status === "syncing" || s.status === "pending");
  useEffect(() => {
    if (!syncing) return;
    const timer = setInterval(() => load().catch(() => {}), 2500);
    return () => clearInterval(timer);
  }, [syncing, load]);

  const addWebsite = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const url = String(new FormData(form).get("url"));
    run(async () => {
      await api(`${base}/websites`, { body: { url } });
      form.reset();
      await load();
    });
  };

  const addSnippet = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = e.currentTarget;
    const data = new FormData(form);
    run(async () => {
      await api(`${base}/snippets`, { body: { title: data.get("title"), body: data.get("body") } });
      form.reset();
      await load();
    });
  };

  return (
    <main className="content">
      <section className="panel">
        <h2>Knowledge</h2>
        <p className="muted small">
          The AI assistant answers only from what's here, and cites it. Add your docs site (we read its sitemap or follow its links, and re-sync daily) or write snippets for anything that isn't on the web.
        </p>
        {canEdit && (
          <div className="kb-forms">
            <form onSubmit={addWebsite} className="row">
              <input name="url" type="url" required placeholder="https://docs.yourcompany.com" aria-label="Website URL" />
              <button disabled={busy}>Add website</button>
            </form>
            <details>
              <summary className="small">Add a snippet (FAQ, policy, internal note)</summary>
              <form onSubmit={addSnippet}>
                <input name="title" required placeholder="Title, e.g. Refund policy" aria-label="Snippet title" />
                <textarea name="body" required rows={5} placeholder="Write the answer the way you'd explain it to a customer." aria-label="Snippet text" />
                <button disabled={busy}>Save snippet</button>
              </form>
            </details>
          </div>
        )}
        {error && <p className="error">{error}</p>}
        {sources === null ? (
          <p className="muted small">Loading…</p>
        ) : sources.length === 0 ? (
          <p className="muted small">Nothing yet. Add your docs site to get started.</p>
        ) : (
          <ul className="list">
            {sources.map((s) => (
              <li key={s.id} className="kb-source">
                <button className="link kb-title" onClick={() => setExpanded(expanded === s.id ? null : s.id)} aria-expanded={expanded === s.id}>
                  {expanded === s.id ? "▾" : "▸"} {s.kind === "website" ? "🌐" : "📝"} {s.title}
                </button>
                <span className="muted small">
                  {s.status === "syncing" || s.status === "pending"
                    ? `Syncing… ${s.pendingJobs > 0 ? `${plural(s.pendingJobs, "page")} queued` : ""}`
                    : s.status === "error"
                      ? <span className="error">{s.error ?? "Error"}</span>
                      : `${s.kind === "website" ? `${plural(s.pageCount, "page")} · ` : ""}${plural(s.chunkCount, "chunk")} · synced ${ago(s.lastSyncedAt)}`}
                </span>
                {canEdit && (
                  <>
                    <button className="ghost small" disabled={busy || s.status === "syncing"} onClick={() => run(async () => { await api(`${base}/${s.id}/sync`, { body: {} }); await load(); })}>Re-sync</button>
                    <button
                      className="ghost small"
                      disabled={busy}
                      onClick={() => {
                        if (!confirm(`Remove "${s.title}" from the knowledge base?`)) return;
                        run(async () => { await api(`${base}/${s.id}`, { method: "DELETE" }); await load(); });
                      }}
                    >
                      Remove
                    </button>
                  </>
                )}
                {expanded === s.id && <SourceDetail base={base} sourceId={s.id} canEdit={canEdit} onChanged={() => load().catch(() => {})} />}
              </li>
            ))}
          </ul>
        )}
      </section>
      <SearchTester base={base} />
    </main>
  );
}

/** Shows exactly which chunks the AI would get for a question. */
function SearchTester({ base }: { base: string }) {
  const [hits, setHits] = useState<Hit[] | null>(null);
  const { busy, error, run } = useAction();
  const submit = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const query = String(new FormData(e.currentTarget).get("query"));
    run(async () => setHits((await api<{ hits: Hit[] }>(`${base}/search`, { body: { query } })).hits));
  };
  return (
    <section className="panel">
      <h2>Test a question</h2>
      <p className="muted small">See which knowledge the AI would use to answer.</p>
      <form onSubmit={submit} className="row">
        <input name="query" required placeholder="e.g. How do I get a refund?" aria-label="Question" />
        <button disabled={busy}>{busy ? "Searching…" : "Search"}</button>
      </form>
      {error && <p className="error">{error}</p>}
      {hits && (hits.length === 0 ? <p className="muted small">No matching knowledge. The AI would hand this to a person.</p> : (
        <ol className="hits">
          {hits.map((h) => (
            <li key={h.id}>
              <div className="row small">
                <strong>{h.title}{h.heading ? ` › ${h.heading}` : ""}</strong>
                <span className="spacer" />
                <span className="muted">relevance {h.score.toFixed(2)}</span>
              </div>
              {h.url && <a className="small" href={h.url} target="_blank" rel="noreferrer">{h.url}</a>}
              <p className="small muted">{h.text.length > 300 ? `${h.text.slice(0, 300)}…` : h.text}</p>
            </li>
          ))}
        </ol>
      ))}
    </section>
  );
}
