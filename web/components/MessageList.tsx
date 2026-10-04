import { Fragment, useEffect, useRef, type ReactNode } from "react";
import type { Attachment, Message, Source } from "../../shared/protocol.ts";
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

/** Renders [1]-style citations as small superscript links to the cited source. */
function withCitations(body: string, sources: Source[] | undefined): ReactNode {
  if (!sources?.length) return body;
  return body.split(/(\[\d{1,2}\])/g).map((part, i) => {
    const n = /^\[(\d{1,2})\]$/.exec(part)?.[1];
    const source = n ? sources[Number(n) - 1] : undefined;
    if (!source) return <Fragment key={i}>{part}</Fragment>;
    return source.url ? (
      <a key={i} className="cite" href={source.url} target="_blank" rel="noreferrer" title={source.title}>{n}</a>
    ) : (
      <sup key={i} className="cite" title={source.title}>{n}</sup>
    );
  });
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
  onRetry,
  onDismiss,
}: {
  messages: Message[];
  pending: PendingMessage[];
  mine: (m: Message) => boolean;
  authorLabel: (m: Message) => string;
  otherReadSeq: number;
  typing: { name: string | null } | null;
  aiStream?: { text: string } | null;
  aiThinking?: boolean;
  onRetry?: (p: PendingMessage) => void;
  onDismiss?: (p: PendingMessage) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending.length, typing, aiStream?.text, aiThinking]);

  // "Seen" goes under the last of my messages the other side has read.
  const lastSeenSeq = [...messages].reverse().find((m) => mine(m) && m.authorType !== "system" && m.seq <= otherReadSeq)?.seq;
  const aiSide = mine({ authorType: "ai" } as Message) ? "own" : "other";

  return (
    <div className="messages">
      {messages.map((m, i) => {
        if (m.authorType === "system") {
          return (
            <div key={m.id} className={`system-msg ${m.internal ? "internal" : ""}`}>
              {m.internal && <span className="tag">Note · only your team sees this</span>}
              <div>{m.body}</div>
            </div>
          );
        }
        const own = mine(m);
        const prev = messages[i - 1];
        const showAuthor = !prev || prev.authorType !== m.authorType || prev.authorId !== m.authorId;
        return (
          <div key={m.id} className={`msg ${own ? "own" : "other"} ${m.authorType === "ai" ? "ai" : ""}`}>
            {showAuthor && <div className="author muted small">{authorLabel(m)} · {formatTime(m.createdAt)}</div>}
            {m.body && <div className="bubble">{m.authorType === "ai" ? withCitations(m.body, m.meta.sources) : m.body}</div>}
            <Attachments attachments={m.attachments} />
            {m.authorType === "ai" && <Sources sources={m.meta.sources} />}
            {m.seq === lastSeenSeq && <div className="seen muted small">Seen</div>}
          </div>
        );
      })}
      {pending.map((p) => (
        <div key={p.clientMsgId} className="msg own pending">
          {p.body && <div className="bubble">{p.body}</div>}
          <Attachments attachments={p.attachments} />
          {p.failed ? (
            <div className="error small">
              {p.failed} {onRetry && <button className="link" onClick={() => onRetry(p)}>Retry</button>}{" "}
              {onDismiss && <button className="link" onClick={() => onDismiss(p)}>Discard</button>}
            </div>
          ) : (
            <div className="muted small">Sending…</div>
          )}
        </div>
      ))}
      {aiStream?.text ? (
        <div className={`msg ${aiSide} ai streaming`}>
          <div className="author muted small">AI assistant · writing…</div>
          <div className="bubble">{aiStream.text}</div>
        </div>
      ) : aiThinking ? (
        <div className={`msg ${aiSide} ai`}>
          <div className="bubble typing" aria-label="The AI assistant is writing a reply">
            <span /><span /><span />
          </div>
        </div>
      ) : null}
      {typing && (
        <div className="msg other">
          <div className="bubble typing" aria-label={`${typing.name ?? "Someone"} is typing`}>
            <span /><span /><span />
          </div>
        </div>
      )}
      <div ref={end} />
    </div>
  );
}
