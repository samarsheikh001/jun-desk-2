import { useEffect, useRef } from "react";
import type { Attachment, Message } from "../../shared/protocol.ts";
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

/**
 * Chat transcript. `mine` decides which messages sit on the right: agents see their
 * team's messages as theirs; visitors see their own.
 */
export function MessageList({
  messages,
  pending,
  mine,
  authorLabel,
  otherReadSeq,
  typing,
  onRetry,
  onDismiss,
}: {
  messages: Message[];
  pending: PendingMessage[];
  mine: (m: Message) => boolean;
  authorLabel: (m: Message) => string;
  otherReadSeq: number;
  typing: { name: string | null } | null;
  onRetry?: (p: PendingMessage) => void;
  onDismiss?: (p: PendingMessage) => void;
}) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    end.current?.scrollIntoView({ block: "end" });
  }, [messages.length, pending.length, typing]);

  // "Seen" goes under the last of my messages the other side has read.
  const lastSeenSeq = [...messages].reverse().find((m) => mine(m) && m.seq <= otherReadSeq)?.seq;

  return (
    <div className="messages">
      {messages.map((m, i) => {
        const own = mine(m);
        const prev = messages[i - 1];
        const showAuthor = !prev || prev.authorType !== m.authorType || prev.authorId !== m.authorId;
        return (
          <div key={m.id} className={`msg ${own ? "own" : "other"}`}>
            {showAuthor && <div className="author muted small">{authorLabel(m)} · {formatTime(m.createdAt)}</div>}
            {m.body && <div className="bubble">{m.body}</div>}
            <Attachments attachments={m.attachments} />
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
