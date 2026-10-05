import { useEffect, useState } from "react";
import { formatEventTime, isIssue, type DebugContext, type DebugEvent } from "../../shared/debug.ts";
import type { AiAction } from "../../shared/protocol.ts";
import { api } from "../api.ts";

interface ContextResponse {
  context: Omit<DebugContext, "events"> | null;
  events: DebugEvent[];
  issueCount: number;
}

/** "Chrome 141 on Windows" from a user agent string (good enough for a support panel). */
export function describeBrowser(ua: string): string {
  const browser =
    /Edg\/(\d+)/.exec(ua)?.[1] ? `Edge ${/Edg\/(\d+)/.exec(ua)![1]}` :
    /Firefox\/(\d+)/.exec(ua)?.[1] ? `Firefox ${/Firefox\/(\d+)/.exec(ua)![1]}` :
    /Chrome\/(\d+)/.exec(ua)?.[1] ? `Chrome ${/Chrome\/(\d+)/.exec(ua)![1]}` :
    /Version\/(\d+).*Safari/.exec(ua)?.[1] ? `Safari ${/Version\/(\d+)/.exec(ua)![1]}` : "Unknown browser";
  const os = /Windows/.test(ua) ? "Windows" : /iPhone|iPad/.test(ua) ? "iOS" : /Mac OS X/.test(ua) ? "macOS" : /Android/.test(ua) ? "Android" : /Linux/.test(ua) ? "Linux" : "";
  return os ? `${browser} on ${os}` : browser;
}

function EventRow({ event, timezone }: { event: DebugEvent; timezone: string }) {
  const time = formatEventTime(event.t, timezone);
  if (event.kind === "navigation") {
    return (
      <li className="ev nav">
        <span className="ev-time">{time}</span>
        <span>Visited <code>{event.url}</code></span>
      </li>
    );
  }
  if (event.kind === "network") {
    return (
      <li className={`ev ${isIssue(event) ? "bad" : ""}`}>
        <span className="ev-time">{time}</span>
        <span>
          <strong>{event.method ?? "GET"}</strong> <code>{event.url}</code>{" "}
          <span className="status">{event.status ? event.status : "failed"}</span>
          {event.durationMs != null && <span className="muted"> · {event.durationMs} ms</span>}
          {event.message && <div className="muted small">{event.message}</div>}
        </span>
      </li>
    );
  }
  return (
    <li className="ev bad">
      <span className="ev-time">{time}</span>
      <span>
        <strong>{event.message || "JavaScript error"}</strong>
        {event.source && <div className="muted small"><code>{event.source}</code></div>}
        {event.stack && (
          <details>
            <summary className="small">Stack</summary>
            <pre>{event.stack}</pre>
          </details>
        )}
      </span>
    </li>
  );
}

/**
 * P1: what the visitor's browser saw (errors, failed requests, pages visited) next to the
 * conversation, so agents don't have to ask "what browser are you on?".
 */
/** AI-11: what the AI looked up while answering, with what it sent and got back. */
function AiActions({ actions }: { actions: AiAction[] }) {
  if (!actions.length) return null;
  return (
    <>
      <h3>AI actions</h3>
      <ul className="ai-actions">
        {actions.map((a) => (
          <li key={a.id}>
            <div className="row">
              <code className="strong">{a.tool}</code>
              <span className={a.status === "ok" ? "muted" : "error"}>{a.status === "ok" ? "✓" : "failed"}{a.httpStatus ? ` · ${a.httpStatus}` : ""}</span>
              <span className="spacer" />
              <span className="muted">{a.durationMs} ms</span>
            </div>
            <div className="muted">{Object.entries(a.input).map(([k, v]) => `${k}: ${String(v)}`).join(", ") || "no input"}</div>
            {a.output && (
              <details>
                <summary className="small">Result{a.configVersion ? ` (config v${a.configVersion})` : ""}</summary>
                <pre>{a.output}</pre>
              </details>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}

export function DebugPanel({ conversationId, refreshKey }: { conversationId: string; refreshKey: number }) {
  const [data, setData] = useState<ContextResponse | null>(null);
  const [actions, setActions] = useState<AiAction[]>([]);
  const [onlyIssues, setOnlyIssues] = useState(false);

  useEffect(() => {
    api<ContextResponse>(`/conversations/${conversationId}/context`).then(setData, () => setData(null));
    api<{ actions: AiAction[] }>(`/conversations/${conversationId}/actions`).then((r) => setActions(r.actions), () => setActions([]));
  }, [conversationId, refreshKey]);

  if (!data) return <aside className="debug-panel muted small pad">Loading…</aside>;
  if (!data.context) {
    return (
      <aside className="debug-panel">
        <AiActions actions={actions} />
        <h3>Customer context</h3>
        <p className="muted small">No browser details for this conversation. They appear when the visitor writes from a page with the widget installed.</p>
      </aside>
    );
  }
  const { context } = data;
  const shown = onlyIssues ? data.events.filter(isIssue) : data.events;
  return (
    <aside className="debug-panel">
      <AiActions actions={actions} />
      <h3>Customer context</h3>
      <dl className="env small">
        <dt>Page</dt>
        <dd><code>{context.page.url}</code>{context.page.title && <div className="muted">{context.page.title}</div>}</dd>
        <dt>Browser</dt>
        <dd>{describeBrowser(context.userAgent)}</dd>
        <dt>Screen</dt>
        <dd>{context.viewport.w}×{context.viewport.h}</dd>
        <dt>Locale</dt>
        <dd>{context.language}{context.timezone && ` · ${context.timezone}`}</dd>
      </dl>
      <div className="row">
        <h3>What happened</h3>
        <span className="spacer" />
        {data.issueCount > 0 && <span className="issue-count">⚠ {data.issueCount}</span>}
      </div>
      <label className="check small">
        <input type="checkbox" checked={onlyIssues} onChange={(e) => setOnlyIssues(e.target.checked)} /> Errors only
      </label>
      {shown.length === 0 ? (
        <p className="muted small">Nothing went wrong in their browser.</p>
      ) : (
        <ol className="timeline small">
          {shown.map((e, i) => (
            <EventRow key={`${e.t}-${i}`} event={e} timezone={context.timezone} />
          ))}
        </ol>
      )}
      <p className="muted small">Captured by the widget in the visitor's browser and masked (emails, tokens, query values). No request bodies.</p>
    </aside>
  );
}
