import { useCallback, useEffect, useMemo, useState } from "react";
import type { ConversationIssue, ConversationStatus, ConversationSummary, CsatRating, Message } from "../../shared/protocol.ts";
import { api } from "../api.ts";
import { fillSavedReply } from "../../shared/inbox.ts";
import { Composer, type SavedReply } from "../components/Composer.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { navigate } from "../lib/router.ts";
import { DebugPanel } from "./DebugPanel.tsx";
import { configuredProviders, IssueDialog, type FiledIssue } from "./IssueDialog.tsx";
import type { TrackerStatus } from "../settings/IssueTrackersPanel.tsx";
import { formatTime, uploadFile, useThread, useTypingSignal } from "../lib/thread.ts";
import type { Hub } from "../Shell.tsx";

type StatusFilter = ConversationStatus | "all";
type AssigneeFilter = "all" | "me" | "unassigned" | "mentions";
type RatingFilter = CsatRating | "";
interface Member { id: string; name: string }
interface Tag { id: string; name: string; conversations: number }
interface MentionToast { conversationId: string; by: string; preview: string }

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

/** W-12: the customer's latest rating as a small badge. */
function CsatBadge({ rating }: { rating: CsatRating | null }) {
  if (!rating) return null;
  return <em className={`tag csat-tag ${rating}`} title={rating === "good" ? "The customer rated this Good" : "The customer rated this Bad"}>{rating === "good" ? "👍" : "👎"}</em>;
}

export function InboxPage({ workspaceId, me, hub, conversationId }: { workspaceId: string; me: { id: string; name: string }; hub: Hub; conversationId: string | null }) {
  const [status, setStatus] = useState<StatusFilter>("open");
  const [assignee, setAssignee] = useState<AssigneeFilter>("all");
  const [tagFilter, setTagFilter] = useState("");
  const [ratingFilter, setRatingFilter] = useState<RatingFilter>("");
  const [list, setList] = useState<ConversationSummary[] | null>(null);
  const [members, setMembers] = useState<Member[]>([]);
  const [tags, setTags] = useState<Tag[]>([]);
  const [unreadMentions, setUnreadMentions] = useState(0);
  const [toast, setToast] = useState<MentionToast | null>(null);
  const [trackers, setTrackers] = useState<TrackerStatus | null>(null);

  const matches = useCallback(
    (c: ConversationSummary) =>
      (status === "all" || c.status === status) &&
      (tagFilter === "" || c.tags.some((t) => t.toLowerCase() === tagFilter.toLowerCase())) &&
      (ratingFilter === "" || c.csat.rating === ratingFilter) &&
      (assignee === "all" || assignee === "mentions" || (assignee === "me" ? c.assigneeId === me.id : c.assigneeId === null)),
    [status, assignee, tagFilter, ratingFilter, me.id],
  );

  useEffect(() => {
    let cancelled = false;
    setList(null);
    const query = new URLSearchParams({ status, ...(assignee !== "all" ? { assignee } : {}), ...(tagFilter ? { tag: tagFilter } : {}), ...(ratingFilter ? { rating: ratingFilter } : {}) });
    api<{ conversations: ConversationSummary[] }>(`/workspaces/${workspaceId}/conversations?${query}`).then((r) => !cancelled && setList(r.conversations));
    return () => {
      cancelled = true;
    };
  }, [workspaceId, status, assignee, tagFilter, ratingFilter]);

  const loadTags = useCallback(() => api<{ tags: Tag[] }>(`/workspaces/${workspaceId}/tags`).then((r) => setTags(r.tags)), [workspaceId]);
  const loadMentions = useCallback(() => api<{ unread: number }>(`/workspaces/${workspaceId}/mentions`).then((r) => setUnreadMentions(r.unread)), [workspaceId]);
  useEffect(() => {
    api<{ members: Member[] }>(`/workspaces/${workspaceId}/members`).then((r) => setMembers(r.members));
    api<TrackerStatus>(`/workspaces/${workspaceId}/trackers`).then(setTrackers, () => setTrackers(null));
    void loadTags();
    void loadMentions();
  }, [workspaceId, loadTags, loadMentions]);

  // Live updates: upsert conversations that match the current filters, drop ones that don't.
  // "Mentions me" can't be checked from a summary, so that view only updates what it shows.
  useEffect(
    () =>
      hub.subscribe((event) => {
        if (event.type === "mention") {
          if (!event.userIds.includes(me.id)) return;
          void loadMentions();
          if (event.conversationId !== conversationId) setToast({ conversationId: event.conversationId, by: event.by, preview: event.preview });
          return;
        }
        if (event.type !== "conversation") return;
        const updated = event.conversation;
        setList((current) => {
          if (!current) return current;
          const rest = current.filter((c) => c.id !== updated.id);
          const keep = matches(updated) && (assignee !== "mentions" || rest.length < current.length);
          return (keep ? [updated, ...rest] : rest).sort((a, b) => b.lastMessageAt - a.lastMessageAt);
        });
      }),
    [hub, matches, assignee, me.id, conversationId, loadMentions],
  );

  const unreadCount = useMemo(() => list?.filter(isUnread).length ?? 0, [list]);
  useEffect(() => {
    document.title = unreadCount > 0 ? `(${unreadCount}) Jun Desk` : "Jun Desk";
  }, [unreadCount]);

  return (
    <div className="inbox">
      {toast && (
        <div className="toast" role="status">
          <span><strong>{toast.by}</strong> mentioned you: {toast.preview}</span>
          <button className="small" onClick={() => { navigate(`/inbox/${toast.conversationId}`); setToast(null); }}>Open</button>
          <button className="ghost small" aria-label="Dismiss" onClick={() => setToast(null)}>×</button>
        </div>
      )}
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
          <option value="mentions">Mentions me{unreadMentions > 0 ? ` (${unreadMentions} new)` : ""}</option>
        </select>
        {tags.length > 0 && (
          <select className="filter" value={tagFilter} onChange={(e) => setTagFilter(e.target.value)} aria-label="Tag filter">
            <option value="">Any tag</option>
            {tags.map((t) => (
              <option key={t.id} value={t.name}>{t.name}</option>
            ))}
          </select>
        )}
        <select
          className="filter"
          value={ratingFilter}
          onChange={(e) => {
            const next = e.target.value as RatingFilter;
            setRatingFilter(next);
            // Rated conversations are resolved ones: don't leave the filter on an empty Open tab.
            if (next && status === "open") setStatus("all");
          }}
          aria-label="Rating filter"
        >
          <option value="">Any rating</option>
          <option value="good">Rated 👍 Good</option>
          <option value="bad">Rated 👎 Bad</option>
        </select>
        {list === null ? (
          <p className="muted small pad">Loading…</p>
        ) : list.length === 0 ? (
          <p className="muted small pad">{ratingFilter ? "No conversations with this rating." : "No conversations here. Install the widget from Settings to start receiving chats."}</p>
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
                    {c.contact.verified && <span className="verified" title="Identity verified by your site">✓</span>}
                    {c.handling === "ai" && <em className="tag ai-tag" title="The AI assistant is answering">AI</em>}
                    {c.debugIssueCount > 0 && <em className="tag issue-tag" title="Errors or failed requests in the visitor's browser">⚠ {c.debugIssueCount}</em>}
                    <CsatBadge rating={c.csat.rating} />
                    <span className="spacer" />
                    <span className="muted small">{formatTime(c.lastMessageAt)}</span>
                  </span>
                  {c.tags.length > 0 && (
                    <span className="conv-tags">{c.tags.map((t) => <span key={t} className="chip tag-chip">{t}</span>)}</span>
                  )}
                  <span className="preview small">
                    {c.lastMessageAuthor === "agent" && <span className="muted">You: </span>}
                    {c.lastMessageAuthor === "ai" && <span className="muted">AI: </span>}
                    {c.lastMessagePreview}
                  </span>
                </a>
              </li>
            ))}
          </ul>
        )}
      </aside>
      {conversationId ? (
        <Thread
          key={conversationId}
          conversationId={conversationId}
          workspaceId={workspaceId}
          me={me}
          members={members}
          tags={tags}
          trackers={trackers}
          onTagsChanged={() => void loadTags()}
          onOpened={() => void loadMentions()}
        />
      ) : (
        <div className="thread empty muted">Select a conversation</div>
      )}
    </div>
  );
}

function Thread({
  conversationId,
  workspaceId,
  me,
  members,
  tags,
  trackers,
  onTagsChanged,
  onOpened,
}: {
  conversationId: string;
  workspaceId: string;
  me: { id: string; name: string };
  members: Member[];
  tags: Tag[];
  trackers: TrackerStatus | null;
  onTagsChanged: () => void;
  onOpened: () => void;
}) {
  const [conversation, setConversation] = useState<ConversationSummary | null>(null);
  const [filed, setFiled] = useState<ConversationIssue[]>([]);
  const [issueOpen, setIssueOpen] = useState(false);
  const [created, setCreated] = useState<FiledIssue | null>(null);
  const [initial, setInitial] = useState<Message[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [savedReplies, setSavedReplies] = useState<SavedReply[]>([]);

  useEffect(() => {
    api<{ conversation: ConversationSummary; messages: Message[]; issues: ConversationIssue[] }>(`/conversations/${conversationId}`).then(
      (r) => {
        setConversation(r.conversation);
        setInitial(r.messages);
        setFiled(r.issues);
        onOpened(); // opening it reads my @mentions here
      },
      (e: Error) => setError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  useEffect(() => {
    api<{ savedReplies: SavedReply[] }>(`/workspaces/${workspaceId}/saved-replies`).then((r) => setSavedReplies(r.savedReplies), () => {});
  }, [workspaceId]);

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

  const update = async (patch: { status?: ConversationStatus; assigneeId?: string | null; handling?: "ai" | "human" }) => {
    try {
      setConversation((await api<{ conversation: ConversationSummary }>(`/conversations/${conversationId}`, { method: "PATCH", body: patch })).conversation);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const setTags = async (next: string[]) => {
    try {
      setConversation((await api<{ conversation: ConversationSummary }>(`/conversations/${conversationId}/tags`, { method: "PUT", body: { tags: next } })).conversation);
      onTagsChanged();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  // S-08: issues filed from here; ones a teammate files arrive live as "Issue created" notes.
  const issues = useMemo(() => {
    const all = [...filed];
    for (const m of thread.messages) if (m.meta.issue && !all.some((i) => i.id === m.meta.issue!.id)) all.push(m.meta.issue);
    return all;
  }, [filed, thread.messages]);

  if (error) return <div className="thread empty error">{error}</div>;
  if (!conversation || !initial) return <div className="thread empty muted">Loading…</div>;
  const memberName = (id: string | null) => members.find((m) => m.id === id)?.name ?? "Teammate";

  // Refresh the side panel when the visitor writes (new context) or the AI answers (new actions).
  const visitorMessages = thread.messages.filter((m) => m.authorType === "visitor" || m.authorType === "ai").length;
  return (
    <div className="thread-wrap">
    <section className="thread">
      <header className="thread-head">
        <div>
          <strong>{contactLabel(conversation.contact)}</strong>
          {conversation.contact.verified && <span className="verified" title="Identity verified by your site">✓</span>}
          <CsatBadge rating={conversation.csat.rating} />
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
        <span className="issue-button">
          <button
            className="ghost small"
            disabled={configuredProviders(trackers).length === 0}
            title={configuredProviders(trackers).length ? "Draft an issue from this conversation" : "Connect GitHub or Linear in Settings first"}
            onClick={() => setIssueOpen(true)}
          >
            Create issue
          </button>
          {trackers && configuredProviders(trackers).length === 0 && (
            <a className="small" href="/settings#issue-trackers" onClick={(e) => { e.preventDefault(); navigate("/settings#issue-trackers"); }}>Set up</a>
          )}
        </span>
      </header>
      <TagEditor tags={conversation.tags} known={tags} onChange={(next) => void setTags(next)} />
      {issues.length > 0 && (
        <div className="issue-bar small">
          <span className="muted">Issues</span>
          {issues.map((i) => (
            <a key={i.id} className="chip issue-chip" href={i.url} target="_blank" rel="noreferrer" title={i.title}>
              {i.key} <span className="clip issue-chip-title">{i.title}</span>
            </a>
          ))}
        </div>
      )}
      {issueOpen && trackers && configuredProviders(trackers).length > 0 && (
        <IssueDialog
          conversationId={conversationId}
          trackers={trackers}
          onClose={() => setIssueOpen(false)}
          onCreated={(result) => {
            const { issue } = result;
            setFiled((current) => (current.some((i) => i.id === issue.id) ? current : [...current, issue]));
            setCreated(result);
            setIssueOpen(false);
          }}
        />
      )}
      {created && (
        <div className="toast" role="status">
          <span>
            Created <a href={created.issue.url} target="_blank" rel="noreferrer">{created.issue.key}</a>
            {created.notice && <span className="error"> · {created.notice}</span>}
          </span>
          <button className="ghost small" aria-label="Dismiss" onClick={() => setCreated(null)}>×</button>
        </div>
      )}
      {conversation.handling === "ai" ? (
        <div className="ai-banner small">
          <span>🤖 The AI assistant is answering this conversation. Replying yourself takes it over.</span>
          <span className="spacer" />
          <button className="ghost small" onClick={() => void update({ handling: "human" })}>Take over</button>
        </div>
      ) : (
        thread.messages.some((m) => m.authorType === "ai") && (
          <div className="ai-banner small muted">
            <span>A teammate is handling this conversation.</span>
            <span className="spacer" />
            <button className="ghost small" onClick={() => void update({ handling: "ai" })}>Hand back to AI</button>
          </div>
        )
      )}
      <MessageList
        messages={thread.messages}
        pending={thread.pending}
        mine={(m) => m.authorType !== "visitor"}
        authorLabel={(m) =>
          m.authorType === "visitor" ? contactLabel(conversation.contact) : m.authorType === "ai" ? "AI assistant" : m.authorId === me.id ? "You" : m.authorName ?? memberName(m.authorId)
        }
        otherReadSeq={Math.max(thread.otherReadSeq, conversation.visitorReadSeq)}
        typing={thread.typing}
        aiStream={thread.aiStream}
        aiThinking={thread.aiThinking}
        onRetry={(p) => thread.send(p.body, p.attachments, p.clientMsgId, undefined, p.internal)}
        onDismiss={(p) => thread.dismissPending(p.clientMsgId)}
        mentionNames={members.map((m) => m.name)}
      />
      <Composer
        placeholder={savedReplies.length ? "Reply… (/ for saved replies, Shift+Enter for a new line)" : "Reply… (Enter to send, Shift+Enter for a new line)"}
        upload={(file) => uploadFile(`/api/workspaces/${workspaceId}/files`, file)}
        onTyping={onTyping}
        notes
        mentionables={members.filter((m) => m.id !== me.id)}
        savedReplies={savedReplies}
        fillReply={(body) => fillSavedReply(body, { customerName: conversation.contact.name, agentName: me.name })}
        onSend={(body, attachments, { internal }) => {
          if (!internal) thread.setTyping(false);
          thread.send(body, attachments, undefined, undefined, internal);
        }}
      />
    </section>
    <DebugPanel conversationId={conversationId} workspaceId={workspaceId} contact={conversation.contact} refreshKey={visitorMessages + conversation.debugIssueCount * 1000} />
    </div>
  );
}

/** I-07: the conversation's tags, with an input that suggests existing ones. */
function TagEditor({ tags, known, onChange }: { tags: string[]; known: Tag[]; onChange: (tags: string[]) => void }) {
  const [adding, setAdding] = useState(false);
  const [value, setValue] = useState("");
  const add = () => {
    const name = value.trim();
    setValue("");
    setAdding(false);
    if (name && !tags.some((t) => t.toLowerCase() === name.toLowerCase())) onChange([...tags, name]);
  };
  return (
    <div className="tag-bar small">
      {tags.map((t) => (
        <span key={t} className="chip tag-chip">
          {t}
          <button className="link" aria-label={`Remove tag ${t}`} onClick={() => onChange(tags.filter((x) => x !== t))}>×</button>
        </span>
      ))}
      {adding ? (
        <form onSubmit={(e) => { e.preventDefault(); add(); }}>
          <input
            autoFocus
            list="known-tags"
            value={value}
            maxLength={40}
            placeholder="Tag name"
            aria-label="New tag"
            onChange={(e) => setValue(e.target.value)}
            onBlur={add}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                setValue("");
                setAdding(false);
              }
            }}
          />
          <datalist id="known-tags">
            {known.filter((k) => !tags.includes(k.name)).map((k) => <option key={k.id} value={k.name} />)}
          </datalist>
        </form>
      ) : (
        <button className="link" onClick={() => setAdding(true)}>+ Tag</button>
      )}
    </div>
  );
}
