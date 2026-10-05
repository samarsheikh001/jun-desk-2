import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { ISSUE_BODY_MAX, ISSUE_TITLE_MAX } from "../../shared/issues.ts";
import type { ConversationIssue, IssueProvider } from "../../shared/protocol.ts";
import { api, describeError } from "../api.ts";
import type { TrackerStatus } from "../settings/IssueTrackersPanel.tsx";

interface Draft {
  title: string;
  body: string;
  source: "ai" | "template";
  notice: string | null;
}

const LAST_PROVIDER = "jun.issueProvider";
const NAMES: Record<IssueProvider, string> = { github: "GitHub", linear: "Linear" };

/** The configured trackers, in a stable order. */
export function configuredProviders(trackers: TrackerStatus | null): IssueProvider[] {
  if (!trackers) return [];
  return (["github", "linear"] as const).filter((p) => trackers[p].configured);
}

function rememberedProvider(available: IssueProvider[]): IssueProvider {
  try {
    const last = window.localStorage.getItem(LAST_PROVIDER);
    if (last === "github" || last === "linear") {
      if (available.includes(last)) return last;
    }
  } catch {
    // storage blocked: fall back to the first one
  }
  return available[0]!;
}

/**
 * S-08: "Create issue". The AI drafts, the agent edits, picks GitHub or Linear (when both are set
 * up) and files it. Nothing is sent to a tracker until they press Create issue.
 */
export function IssueDialog({ conversationId, trackers, onClose, onCreated }: { conversationId: string; trackers: TrackerStatus; onClose: () => void; onCreated: (issue: ConversationIssue) => void }) {
  const available = configuredProviders(trackers);
  const dialog = useRef<HTMLDialogElement>(null);
  const [provider, setProvider] = useState<IssueProvider>(() => rememberedProvider(available));
  const [draft, setDraft] = useState<Draft | null>(null);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [labels, setLabels] = useState("bug");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per dialog: a retried or double-clicked Create never files twice.
  const clientId = useMemo(() => crypto.randomUUID(), []);

  useEffect(() => {
    if (dialog.current && !dialog.current.open) dialog.current.showModal();
    let cancelled = false;
    api<Draft>(`/conversations/${conversationId}/issue-draft`, { body: {} }).then(
      (d) => {
        if (cancelled) return;
        setDraft(d);
        setTitle(d.title);
        setBody(d.body);
      },
      (e: unknown) => !cancelled && setError(describeError(e)),
    );
    return () => {
      cancelled = true;
    };
  }, [conversationId]);

  const pick = (next: IssueProvider) => {
    setProvider(next);
    try {
      window.localStorage.setItem(LAST_PROVIDER, next);
    } catch {
      // not remembered; fine
    }
  };

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const names = provider === "github" ? labels.split(",").map((l) => l.trim()).filter(Boolean) : [];
      const { issue } = await api<{ issue: ConversationIssue }>(`/conversations/${conversationId}/issues`, { body: { provider, title, body, labels: names, clientId } });
      onCreated(issue);
    } catch (err) {
      setError(describeError(err));
      setBusy(false);
    }
  };

  const target = provider === "github" ? trackers.github.repo : trackers.linear.team ? `${trackers.linear.team.name} (${trackers.linear.team.key})` : "";
  return (
    <dialog ref={dialog} className="issue-dialog" aria-labelledby="issue-dialog-title" onClose={onClose} onCancel={(e) => busy && e.preventDefault()}>
      <form onSubmit={submit}>
        <div className="row">
          <h2 id="issue-dialog-title">Create issue</h2>
          <span className="spacer" />
          {available.length > 1 ? (
            <span className="segmented" role="radiogroup" aria-label="Where to file it">
              {available.map((p) => (
                <button key={p} type="button" role="radio" aria-checked={provider === p} className={provider === p ? "active" : ""} disabled={busy} onClick={() => pick(p)}>
                  {NAMES[p]}
                </button>
              ))}
            </span>
          ) : (
            <span className="muted small">{NAMES[provider]}</span>
          )}
        </div>
        <p className="muted small issue-target">
          Files to <code>{target}</code>
        </p>
        {!draft ? (
          error ? (
            <p className="error small">{error}</p>
          ) : (
            <p className="muted issue-drafting" role="status"><span className="typing" aria-hidden="true"><span /><span /><span /></span> Drafting from the conversation and the visitor's browser…</p>
          )
        ) : (
          <>
            <p className="muted small">
              {draft.source === "ai" ? "Drafted by the AI from the conversation and the masked browser details. Check it: it's filed exactly as written." : draft.notice}
            </p>
            <label className="field">
              <span>Title</span>
              <input value={title} onChange={(e) => setTitle(e.target.value)} maxLength={ISSUE_TITLE_MAX} required autoFocus />
            </label>
            <label className="field">
              <span>Description <span className="muted small">(Markdown)</span></span>
              <textarea className="issue-body" value={body} onChange={(e) => setBody(e.target.value)} maxLength={ISSUE_BODY_MAX} spellCheck={false} />
            </label>
            {provider === "github" && (
              <label className="field">
                <span>Labels <span className="muted small">(comma-separated; GitHub only applies labels that exist)</span></span>
                <input value={labels} onChange={(e) => setLabels(e.target.value)} placeholder="bug, billing" />
              </label>
            )}
            {error && <p className="error small">{error}</p>}
          </>
        )}
        <div className="row issue-actions">
          <span className="muted small">Visitors never see this.</span>
          <span className="spacer" />
          <button type="button" className="ghost" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button>
          <button disabled={!draft || busy || !title.trim()}>{busy ? "Creating…" : `Create in ${NAMES[provider]}`}</button>
        </div>
      </form>
    </dialog>
  );
}
