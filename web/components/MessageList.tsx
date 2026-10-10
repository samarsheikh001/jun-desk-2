import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { AiStep, Attachment, Message, Source } from "../../shared/protocol.ts";
import { actionStatusText, actionSummary, visibleResult, type MessageAction } from "../../shared/actions.ts";
import { mentionParts } from "../../shared/inbox.ts";
import { WIDGET_ONLY_BODY, type MessageWidget } from "../../shared/widgets.ts";
import { WidgetCard } from "../widget/chatkit/WidgetCard.tsx";
import { formatSize, formatTime, isImage, type PendingMessage } from "../lib/thread.ts";

function Attachments({ attachments }: { attachments: Attachment[] }) {
  if (attachments.length === 0) return null;
  return (
    <div className="attachments">
      {attachments.map((a) =>
        isImage(a) ? (
          <a key={a.key} href={`/api/files/${a.key}`} target="_blank" rel="noreferrer">
            <img src={`/api/files/${a.key}`} alt={a.name} loading="lazy" />
          </a>
        ) : (
          <a key={a.key} className="file" href={`/api/files/${a.key}`} target="_blank" rel="noreferrer">
            📎 {a.name} <span className="muted">{formatSize(a.size)}</span>
          </a>
        ),
      )}
    </div>
  );
}

/** `inline code` spans (AI replies often quote paths like `/api/billing`). */
function withCode(text: string, key: number): ReactNode {
  return text.split(/(`[^`\n]+`)/g).map((part, i) =>
    part.length > 2 && part.startsWith("`") && part.endsWith("`") ? <code key={`${key}-${i}`}>{part.slice(1, -1)}</code> : <Fragment key={`${key}-${i}`}>{part}</Fragment>,
  );
}

/** Renders [1]-style citations as small superscript links to the cited source. */
function withCitations(body: string, sources: Source[] | undefined): ReactNode {
  return body.split(/(\[\d{1,2}\])/g).map((part, i) => {
    const n = /^\[(\d{1,2})\]$/.exec(part)?.[1];
    const source = n ? sources?.[Number(n) - 1] : undefined;
    if (!source) return <Fragment key={i}>{withCode(part, i)}</Fragment>;
    return source.url ? (
      <a key={i} className="cite" href={source.url} target="_blank" rel="noreferrer" title={source.title}>{n}</a>
    ) : (
      <sup key={i} className="cite" title={source.title}>{n}</sup>
    );
  });
}

/** A note's @mentions, highlighted. */
function withMentions(body: string, names: string[]): ReactNode {
  return mentionParts(body, names).map((p, i) => (p.mention ? <mark key={i} className="mention">{p.text}</mark> : <Fragment key={i}>{p.text}</Fragment>));
}

function Sources({ sources }: { sources: Source[] | undefined }) {
  if (!sources?.length) return null;
  return (
    <ol className="sources small">
      {sources.map((s, i) => (
        <li key={i}>{s.url ? <a href={s.url} target="_blank" rel="noreferrer">{s.title}</a> : s.title}</li>
      ))}
    </ol>
  );
}

/** An AI answer, streaming or saved, for a list that draws its own (the widget). */
export interface AiAnswerView {
  body: string;
  sources: Source[];
  followUps: string[];
  /** Still being written. */
  streaming: boolean;
  /** The newest thing in the thread (follow-ups only make sense there). */
  latest: boolean;
  /** Tool steps of this reply seen live (visitor-safe labels); empty for history. */
  steps: AiStep[];
  /** AI-21: the page action this reply proposed (the widget draws its card). */
  action?: MessageAction;
  /** When the message was written (the card runs an `auto` action by itself only for a fresh reply). */
  createdAt?: number;
  /** W-09: the saved answer's cards (while it streams, they come on its steps). */
  widgets?: MessageWidget[];
  /** The saved message's id (card actions name it); none while streaming. */
  messageId?: string;
}

/**
 * Chat transcript. `mine` decides which messages sit on the right: agents see their
 * team's (and the AI's) messages as theirs; visitors see their own.
 */
export function MessageList({
  messages,
  pending,
  mine,
  authorLabel,
  otherReadSeq,
  typing,
  aiStream,
  aiThinking,
  aiTurn,
  pendingAuthor,
  onRetry,
  onDismiss,
  mentionNames = [],
  renderAi,
  aiActions,
  aiSteps,
  follow = "end",
  ownText,
}: {
  messages: Message[];
  pending: PendingMessage[];
  mine: (m: Message) => boolean;
  authorLabel: (m: Message) => string;
  otherReadSeq: number;
  typing: { name: string | null } | null;
  aiStream?: { text: string; sources?: Source[] } | null;
  aiThinking?: boolean;
  /** The clientMsgId the reply being written will be saved under (`ai_status.turn`). */
  aiTurn?: string | null;
  /**
   * The widget: a message being sent draws like the saved one ("You · 7:42 PM" above, dimmed),
   * not with "Sending…" under it, so nothing moves when it's saved.
   */
  pendingAuthor?: string;
  onRetry?: (p: PendingMessage) => void;
  onDismiss?: (p: PendingMessage) => void;
  /** Teammates' names, to highlight @mentions in notes. */
  mentionNames?: string[];
  /** Draws AI answers (and the one streaming) instead of the plain bubble. */
  renderAi?: (answer: AiAnswerView) => ReactNode;
  /** Dashboard only (AI-11): the tool calls made while answering the visitor message with this seq. */
  aiActions?: (visitorSeq: number) => ReactNode;
  /** The widget: live tool steps per AI reply (`ai:<seq>`), drawn by `renderAi`. */
  aiSteps?: Record<string, AiStep[]>;
  /**
   * `end` (default): keep the newest at the bottom in view. `start`: the island's answer view, which
   * shows only the latest exchange; when it's taller than the island it stays at its start (the
   * question, then the answer and its card), and the visitor scrolls down.
   */
  follow?: "end" | "start";
  /**
   * The island's answer view: the text shown for one of my saved messages (its title), e.g. a card
   * press with what it was about; null (or no function, the default) shows the stored body.
   */
  ownText?: (m: Message) => string | null;
}) {
  const list = useRef<HTMLDivElement>(null);
  // Scroll the list's own box, never scrollIntoView: in the widget that also scrolls the host page
  // (the whole site jumps on a phone).
  const scroller = () => {
    let box: HTMLElement | null = list.current?.parentElement ?? null;
    while (box && !/(auto|scroll)/.test(getComputedStyle(box).overflowY)) box = box.parentElement;
    return box;
  };
  useEffect(() => {
    const box = scroller();
    if (box && follow === "end") box.scrollTop = box.scrollHeight;
  }, [messages.length, pending.length, typing, aiStream?.text, aiThinking, follow]);
  // A custom AI renderer reveals text on its own clock: keep following it while the reader is at the bottom.
  const customAi = Boolean(renderAi);
  useEffect(() => {
    const el = list.current;
    if (!customAi || follow !== "end" || !el || typeof ResizeObserver === "undefined") return;
    const box = scroller();
    if (!box) return;
    const observer = new ResizeObserver(() => {
      if (box.scrollHeight - box.scrollTop - box.clientHeight < 160) box.scrollTop = box.scrollHeight;
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [customAi, follow]);
  // `start`: a new exchange (the visitor asked again) begins at its top.
  const firstKey = pending[0]?.clientMsgId ?? messages[0]?.id;
  useEffect(() => {
    const box = scroller();
    if (box && follow === "start") box.scrollTop = 0;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [firstKey, follow]);

  // "Seen" goes under the last of my messages the other side has read.
  const lastSeenSeq = [...messages].reverse().find((m) => mine(m) && m.authorType !== "system" && !m.internal && m.seq <= otherReadSeq)?.seq;
  const aiSide = mine({ authorType: "ai" } as Message) ? "own" : "other";

  // One keyed list: an AI reply keeps its key (`ai:<seq>`, the answer's clientMsgId) from its
  // first streamed word to the saved message, so a custom renderer isn't remounted in between.
  // The server names the turn (follow-ups after a page action are `ai:<seq>.<n>`); before it does,
  // the first answer to the latest visitor message.
  const lastVisitorSeq = [...messages].reverse().find((m) => m.authorType === "visitor")?.seq;
  const saved = (key: string) => messages.some((m) => m.clientMsgId === key);
  const streamKey = aiTurn && !saved(aiTurn) ? aiTurn : lastVisitorSeq !== undefined && !saved(`ai:${lastVisitorSeq}`) ? `ai:${lastVisitorSeq}` : "ai:stream";
  const last = messages.at(-1);
  // An AI reply's clientMsgId is `ai:<seq of the visitor message it answers>`.
  const actionsFor = (key: string) => {
    const seq = /^ai:(\d+)$/.exec(key)?.[1];
    return seq && aiActions ? aiActions(Number(seq)) : null;
  };
  const rows: ReactNode[] = messages.map((m, i) => {
    if (m.authorType === "system") {
      return (
        <div key={m.id} className={`system-msg ${m.internal ? "internal" : ""}`}>
          {m.internal && <span className="tag">Note · only your team sees this</span>}
          <div>{m.body}</div>
          {m.meta.issue && <a href={m.meta.issue.url} target="_blank" rel="noreferrer">Open {m.meta.issue.key} in {m.meta.issue.provider === "linear" ? "Linear" : "GitHub"}</a>}
        </div>
      );
    }
    const own = mine(m);
    const prev = messages[i - 1];
    const showAuthor = m.internal || !prev || prev.internal || prev.authorType !== m.authorType || prev.authorId !== m.authorId;
    if (m.authorType === "ai" && renderAi) {
      return (
        <div key={m.clientMsgId} className={`msg ${own ? "own" : "other"} ai`}>
          {renderAi({ body: m.body, sources: m.meta.sources ?? [], followUps: m.meta.followUps ?? [], streaming: false, latest: m === last && pending.length === 0 && !aiStream?.text, steps: aiSteps?.[m.clientMsgId] ?? [], ...(m.meta.action ? { action: m.meta.action } : {}), ...(m.meta.widgets ? { widgets: m.meta.widgets } : {}), messageId: m.id, createdAt: m.createdAt })}
          <Attachments attachments={m.attachments} />
        </div>
      );
    }
    return (
      <div key={m.clientMsgId} className={`msg ${own ? "own" : "other"} ${m.authorType === "ai" ? "ai" : ""} ${m.internal ? "note" : ""}`}>
        {showAuthor && <div className="author muted small">{m.internal && <span className="tag note-tag">Note</span>}{authorLabel(m)} · {formatTime(m.createdAt)}</div>}
        {m.authorType === "ai" && actionsFor(m.clientMsgId)}
        {m.authorType === "ai" && m.meta.widgets?.map((w) => (
          <div key={w.id} className="ai-widget" title={`Card: widgets/${w.name}.widget`}>
            <WidgetCard widget={w} interactive={false} desk />
          </div>
        ))}
        {m.body && !(m.meta.widgets?.length && m.body === WIDGET_ONLY_BODY) && <div className="bubble">{m.authorType === "ai" ? withCitations(m.body, m.meta.sources) : m.internal ? withMentions(m.body, mentionNames) : ((own && ownText?.(m)) || m.body)}</div>}
        {m.meta.widgetAction && m.meta.widgetAction.values && Object.keys(m.meta.widgetAction.values).length > 0 && (
          <div className="widget-values small muted" title={`Card ${m.meta.widgetAction.widget} · action ${m.meta.widgetAction.type}`}>
            {Object.entries(m.meta.widgetAction.values).map(([k, v]) => `${k}: ${typeof v === "boolean" ? (v ? "yes" : "no") : v}`).join(" · ")}
          </div>
        )}
        <Attachments attachments={m.attachments} />
        {m.authorType === "ai" && <Sources sources={m.meta.sources} />}
        {m.authorType === "ai" && m.meta.action && (
          <div className="ai-page-action small muted" title={`Page action ${m.meta.action.name} · run ${m.meta.action.runId}`}>
            Page action: {actionSummary(m.meta.action)} · {actionStatusText(m.meta.action.status)}
            {m.meta.action.status !== "pending" && visibleResult(m.meta.action.result) ? ` · ${visibleResult(m.meta.action.result)}` : ""}
          </div>
        )}
        {m.seq === lastSeenSeq && <div className="seen muted small">Seen</div>}
      </div>
    );
  });
  const lastMessage = messages.at(-1);
  pending.forEach((p, i) => {
    // Same header rule as a saved message, so it doesn't move when the server confirms it.
    const header = pendingAuthor && i === 0 && (!lastMessage || lastMessage.internal || lastMessage.authorType === "system" || lastMessage.authorType === "ai" || !mine(lastMessage));
    rows.push(
      <div key={p.clientMsgId} className={`msg own pending ${p.internal ? "note" : ""}`}>
        {header && <div className="author muted small">{pendingAuthor} · {formatTime(Date.now())}</div>}
        {p.body && <div className="bubble">{p.body}</div>}
        <Attachments attachments={p.attachments} />
        {p.failed ? (
          <div className="error small">
            {p.failed} {onRetry && <button className="link" onClick={() => onRetry(p)}>Retry</button>}{" "}
            {onDismiss && <button className="link" onClick={() => onDismiss(p)}>Discard</button>}
          </div>
        ) : pendingAuthor ? null : (
          <div className="muted small">Sending…</div>
        )}
      </div>,
    );
  });
  if (aiStream?.text) {
    rows.push(
      renderAi ? (
        <div key={streamKey} className={`msg ${aiSide} ai streaming`}>
          {renderAi({ body: aiStream.text, sources: aiStream.sources ?? [], followUps: [], streaming: true, latest: true, steps: aiSteps?.[streamKey] ?? [] })}
        </div>
      ) : (
        <div key={streamKey} className={`msg ${aiSide} ai streaming`}>
          <div className="author muted small">AI assistant · writing…</div>
          {actionsFor(streamKey)}
          <div className="bubble">{withCitations(aiStream.text, aiStream.sources)}</div>
        </div>
      ),
    );
  } else if (aiThinking && renderAi && aiSteps?.[streamKey]?.length) {
    // Tools are running before the first word: the reply's row (same key) shows its steps.
    rows.push(
      <div key={streamKey} className={`msg ${aiSide} ai streaming`}>
        {renderAi({ body: "", sources: [], followUps: [], streaming: true, latest: true, steps: aiSteps[streamKey] })}
      </div>,
    );
  } else if (aiThinking) {
    // Same key as the reply it becomes: the dots, the steps and the words share one row.
    rows.push(
      <div key={streamKey} className={`msg ${aiSide} ai streaming`}>
        {lastVisitorSeq !== undefined && actionsFor(`ai:${lastVisitorSeq}`)}
        <div className="bubble typing" aria-label="The AI assistant is writing a reply">
          <span /><span /><span />
        </div>
      </div>,
    );
  }

  return (
    <div className="messages" ref={list}>
      {rows}
      {typing && (
        <div className="msg other">
          <div className="bubble typing" aria-label={`${typing.name ?? "Someone"} is typing`}>
            <span /><span /><span />
          </div>
        </div>
      )}
    </div>
  );
}
