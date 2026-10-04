import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationStatus, ConversationSummary, Message } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { Composer } from "../components/Composer.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { navigate } from "../lib/router.ts";
import { formatTime, uploadFile, useThread, useTypingSignal } from "../lib/thread.ts";
import type { Hub } from "../Shell.tsx";

type StatusFilter = ConversationStatus | "all";
type AssigneeFilter = "all" | "me" | "unassigned";
interface Member { id: string; name: string }

const STATUS_TABS: { value: StatusFilter; label: string }[] = [
  { value: "open", label: "Open" },
  { value: "pending", label: "Pending" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

/** Stable short number for anonymous visitors, e.g. "Visitor #4821". */
function visitorNumber(id: string): string {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) hash = Math.imul(hash ^ id.charCodeAt(i), 16777619);
  return String((hash >>> 0) % 10000).padStart(4, "0");
}

export const contactLabel = (c: ConversationSummary["contact"]) => c.name ?? c.email ?? `Visitor #${visitorNumber(c.id)}`;
const isUnread = (c: ConversationSummary) => c.lastMessageAuthor === "visitor" && c.lastSeq > c.agentReadSeq;

export function InboxPage({ workspaceId, me, hub, conversationId }: { workspaceId: string; me: { id: string; name: string }; hub: Hub; conversationId: string | null }) {
  const [status, setStatus] = useState<StatusFilter>("open");
  const [assignee, setAssignee] = useState<AssigneeFilter>("all");
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);

  const matches = useCallback(
    (c: ConversationSummary) =>
      (status === "all" || c.status === status) &&
      (assignee === "all" || (assignee === "me" ? c.assigneeId === me.id : c.assigneeId === null)),
    [status, assignee, me.id],
  );

  useEffect(() => {
    let cancelled = false;
    setList(null);
    const query = new URLSearchParams({ status, ...(assignee !== "all" ? { assignee } : {}) });
    api<{ conversations: ConversationSummary[] }>(`/workspaces/${workspaceId}/conversations?${query}`).then((r) => !cancelled && setList(r.conversations));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, status, assignee]);

  useEffect(() => {
    api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`).then((r) => setMembers(r.members));
  }, [workspaceId]);

  // Live updates: upsert conversations that match the current filters, drop ones that don't.
  useEffect(
    () =>
      hub.subscribe((event) => {
        if (event.type !== "conversation") return;
        const updated = event.conversation;
        setList((current) => {
          if (!current) return current;
          const rest = current.filter((c) => c.id !== updated.id);
          return (matches(updated) ? [updated, ...rest] : rest).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
        });
      }),
    [hub, matches],
  );

  const unreadCount = useMemo(() => list?.filter(isUnread).length ?? 0, [list]);
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Jun Desk` : "Jun Desk";
  }, [unreadCount]);

  return (
    <div className="inbox">
      <aside className="conv-list">
        <div className="tabs">
          {STATUS_TABS.map((t) => (
            <button key={t.value} className={`tab ${status === t.value ? "active" : ""}`} onClick={() => setStatus(t.value)}>{t.label}</button>
          ))}
        </div>
        <select className="filter" value={assignee} onChange={(e) => setAssignee(e.target.value as AssigneeFilter)} aria-label="Assignee filter">
          <option value="all">Everyone's</option>
          <option value="me">Assigned to me</option>
          <option value="unassigned">Unassigned</option>
        </select>
        {list === null ? (
          <p className="muted small pad">Loading…</p>
        ) : list.length === 0 ? (
          <p className="muted small pad">No conversations here. Install the widget from Settings to start receiving chats.</p>
        ) : (
          <ul>
            {list.map((c) => (
              <li key={c.id}>
                <a
                  href={`/inbox/${c.id}`}
                  className={`conv ${c.id === conversationId ? "selected" : ""} ${isUnread(c) ? "unread" : ""}`}
                  onClick={(e) => { e.preventDefault(); navigate(`/inbox/${c.id}`); }}
                >
                  <span className="row">
                    <strong>{contactLabel(c.contact)}</strong>
                    <span className="spacer" />
                    <span className="muted small">{formatTime(c.lastMessageAt)}</span>
                  </span>
                  <span className="preview small">
                    {c.lastMessageAuthor === "agent" && <span className="muted">You: </span>}
                    {c.lastMessagePreview}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </aside>
      {conversationId ? (
        <Thread key={conversationId} conversationId={conversationId} workspaceId={workspaceId} me={me} members={members} />
      ) : (
        <div className="thread empty muted">Select a conversation</div>
      )}
    </div>
  );
}

function Thread({ conversationId, workspaceId, me, members }: { conversationId: string; workspaceId: string; me: { id: string; name: string }; members: Member[] }) {
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [initial, setInitial] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<{ conversation: ConversationSummary; messages: Message[] }>(`/conversations/${conversationId}`).then(
      (r) => {
        setConversation(r.conversation);
        setInitial(r.messages);
      },
      (e: Error) => setError(e.message),
    );
  }, [conversationId]);

  const thread = useThread({
    socketUrl: initial ? `/api/conversations/${conversationId}/ws` : null,
    initialMessages: useMemo(() => initial ?? [], [initial]),
    other: "visitor",
    onConversation: setConversation,
  });
  const onTyping = useTypingSignal(thread.setTyping);

  // Mark as read while the thread is open and visible.
  const latest = thread.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    const mark = () => document.visibilityState === "visible" && latest > (conversation?.agentReadSeq ?? 0) && thread.markRead(latest);
    mark();
    document.addEventListener("visibilitychange", mark);
    return () => document.removeEventListener("visibilitychange", mark);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, thread.state]);

  const update = async (patch: { status?: ConversationStatus; assigneeId?: string | null }) => {
    try {
      setConversation((await api<{ conversation: ConversationSummary }>(`/conversations/${conversationId}`, { method: "PATCH", body: patch })).conversation);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) return <div className="thread empty error">{error}</div>;
  if (!conversation || !initial) return <div className="thread empty muted">Loading…</div>;
  const memberName = (id: string | null) => members.find((m) => m.id === id)?.name ?? "Teammate";

  return (
    <section className="thread">
      <header className="thread-head">
        <div>
          <strong>{contactLabel(conversation.contact)}</strong>
          <div className="muted small">
            {thread.state === "open" ? "Live" : thread.state === "connecting" ? "Connecting…" : "Reconnecting…"} · started {formatTime(conversation.createdAt)}
          </div>
        </div>
        <span className="spacer" />
        <select value={conversation.assigneeId ?? ""} onChange={(e) => void update({ assigneeId: e.target.value || null })} aria-label="Assignee">
          <option value="">Unassigned</option>
          {members.map((m) => (
            <option key={m.id} value={m.id}>{m.id === me.id ? `${m.name} (me)` : m.name}</option>
          ))}
        </select>
        <select value={conversation.status} onChange={(e) => void update({ status: e.target.value as ConversationStatus })} aria-label="Status">
          <option value="open">Open</option>
          <option value="pending">Pending</option>
          <option value="snoozed">Snoozed</option>
          <option value="resolved">Resolved</option>
        </select>
        {conversation.status !== "resolved" && <button className="small" onClick={() => void update({ status: "resolved" })}>Resolve</button>}
      </header>
      <MessageList
        messages={thread.messages}
        pending={thread.pending}
        mine={(m) => m.authorType !== "visitor"}
        authorLabel={(m) => (m.authorType === "visitor" ? contactLabel(conversation.contact) : m.authorId === me.id ? "You" : m.authorName ?? memberName(m.authorId))}
        otherReadSeq={Math.max(thread.otherReadSeq, conversation.visitorReadSeq)}
        typing={thread.typing}
        onRetry={(p) => thread.send(p.body, p.attachments, p.clientMsgId)}
        onDismiss={(p) => thread.dismissPending(p.clientMsgId)}
      />
      <Composer
        placeholder="Reply… (Enter to send, Shift+Enter for a new line)"
        upload={(file) => uploadFile(`/api/workspaces/${workspaceId}/files`, file)}
        onTyping={onTyping}
        onSend={(body, attachments) => {
          thread.setTyping(false);
          thread.send(body, attachments);
        }}
      />
    </section>
  );
}
