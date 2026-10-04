import { useCallback, useEffect, useMemo, useState } from "react";
import type { Attachment, ConversationSummary, Message } from "../../shared/protocol.ts";
import { Composer } from "../components/Composer.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { formatTime, uploadFile, useThread, useTypingSignal } from "../lib/thread.ts";

// The chat UI inside the widget iframe. The visitor's token is created only when they
// first send something, so just opening the chat stores nothing in their browser.

const storageKey = (key: string) => `jun:visitor:${key}`;
let memoryToken: string | null = null; // fallback when storage is blocked

function readToken(key: string): string | null {
  try {
    return localStorage.getItem(storageKey(key)) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

function writeToken(key: string, token: string): void {
  memoryToken = token;
  try {
    localStorage.setItem(storageKey(key), token);
  } catch {
    // storage blocked: the session still works until the page reloads
  }
}

class WidgetApi {
  readonly key: string;
  token: string | null;
  constructor(key: string) {
    this.key = key;
    this.token = readToken(key);
  }

  async call<T>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T> {
    const response = await fetch(`/api/widget/${this.key}${path}`, {
      method: init.method ?? (init.body === undefined ? "GET" : "POST"),
      headers: { ...(init.body !== undefined ? { "Content-Type": "application/json" } : {}), ...(this.token ? { "X-Visitor-Token": this.token } : {}) },
      body: init.body === undefined ? null : JSON.stringify(init.body),
    });
    const json = (await response.json().catch(() => ({}))) as { error?: { message: string } };
    if (!response.ok) throw new Error(json.error?.message ?? `Request failed (${response.status})`);
    return json as T;
  }

  async ensureVisitor(): Promise<string> {
    if (this.token) return this.token;
    const { token } = await this.call<{ token: string }>("/visitor", { body: {} });
    writeToken(this.key, token);
    this.token = token;
    return token;
  }

  async upload(file: File): Promise<Attachment> {
    const token = await this.ensureVisitor();
    return uploadFile(`/api/widget/${this.key}/files`, file, { "X-Visitor-Token": token });
  }
}

const postToHost = (message: unknown) => window.parent !== window && window.parent.postMessage(message, "*");
const unread = (c: ConversationSummary) => c.lastMessageAuthor === "agent" && c.lastSeq > c.visitorReadSeq;

export function WidgetApp({ widgetKey }: { widgetKey: string }) {
  const api = useMemo(() => new WidgetApi(widgetKey), [widgetKey]);
  const [config, setConfig] = useState<{ workspaceName: string; greeting: string } | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [view, setView] = useState<{ kind: "home" } | { kind: "thread"; id: string | null }>({ kind: "home" });
  const [open, setOpen] = useState(window.parent === window);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api.call<{ workspaceName: string; greeting: string }>("/config").then(setConfig, (e: Error) => setError(e.message));
    if (api.token) {
      api.call<{ conversations: ConversationSummary[] }>("/conversations").then(
        (r) => {
          setConversations(r.conversations);
          // Go straight back into an ongoing conversation.
          const active = r.conversations.find((c) => c.status !== "resolved");
          if (active) setView({ kind: "thread", id: active.id });
        },
        () => {},
      );
    }
  }, [api]);

  // The loader tells us when the chat is shown or hidden (read receipts only count while shown).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      if (e.data?.type === "jun:open") setOpen(true);
      if (e.data?.type === "jun:close") setOpen(false);
    };
    window.addEventListener("message", onMessage);
    // Only now can we hear the loader's reply, so ask for the current state.
    postToHost({ type: "jun:ready" });
    return () => window.removeEventListener("message", onMessage);
  }, []);

  useEffect(() => {
    postToHost({ type: "jun:unread", count: conversations.filter(unread).length });
  }, [conversations]);

  const upsert = useCallback((c: ConversationSummary) => {
    setConversations((list) => [c, ...list.filter((x) => x.id !== c.id)].sort((a, b) => b.lastMessageAt - a.lastMessageAt));
  }, []);

  if (error) return <div className="w-shell"><p className="error pad">{error}</p></div>;
  if (!config) return <div className="w-shell" />;

  return (
    <div className="w-shell">
      <header className="w-head">
        {view.kind === "thread" && <button className="ghost icon" aria-label="Back" onClick={() => setView({ kind: "home" })}>‹</button>}
        <div>
          <strong>{config.workspaceName}</strong>
          <div className="small w-sub">We usually reply in a few minutes</div>
        </div>
        <span className="spacer" />
        {window.parent !== window && <button className="ghost icon" aria-label="Close chat" onClick={() => postToHost({ type: "jun:close" })}>×</button>}
      </header>
      {view.kind === "home" ? (
        <div className="w-home">
          <div className="w-greeting">
            <h2>{config.greeting}</h2>
            <button onClick={() => setView({ kind: "thread", id: null })}>Send us a message</button>
          </div>
          {conversations.length > 0 && (
            <div className="w-history">
              <h3 className="small muted">Your conversations</h3>
              <ul className="list">
                {conversations.map((c) => (
                  <li key={c.id}>
                    <button className="w-conv" onClick={() => setView({ kind: "thread", id: c.id })}>
                      <span className={unread(c) ? "strong" : ""}>{c.lastMessagePreview || "Conversation"}</span>
                      <span className="muted small">{c.status === "resolved" ? "Resolved · " : ""}{formatTime(c.lastMessageAt)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      ) : (
        <WidgetThread
          key={view.id ?? "new"}
          api={api}
          conversationId={view.id}
          open={open}
          onStarted={(c) => {
            upsert(c);
            setView({ kind: "thread", id: c.id });
          }}
          onConversation={upsert}
        />
      )}
    </div>
  );
}

function WidgetThread({
  api,
  conversationId,
  open,
  onStarted,
  onConversation,
}: {
  api: WidgetApi;
  conversationId: string | null;
  open: boolean;
  onStarted: (c: ConversationSummary) => void;
  onConversation: (c: ConversationSummary) => void;
}) {
  const [initial, setInitial] = useState<Message[] | null>(conversationId ? null : []);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!conversationId) return;
    api.call<{ conversation: ConversationSummary; messages: Message[] }>(`/conversations/${conversationId}`).then(
      (r) => {
        setInitial(r.messages);
        onConversation(r.conversation);
      },
      (e: Error) => setError(e.message),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, conversationId]);

  const thread = useThread({
    socketUrl: conversationId && initial ? `/api/widget/${api.key}/conversations/${conversationId}/ws` : null,
    ...(api.token ? { protocols: [api.token] } : {}),
    initialMessages: useMemo(() => initial ?? [], [initial]),
    other: "agent",
    onConversation,
  });
  const onTyping = useTypingSignal(thread.setTyping);

  const latest = thread.messages.at(-1)?.seq ?? 0;
  useEffect(() => {
    if (open && document.visibilityState === "visible" && latest > 0) thread.markRead(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, open, thread.state]);

  const send = async (body: string, attachments: Attachment[]) => {
    setError(null);
    if (conversationId) {
      thread.setTyping(false);
      thread.send(body, attachments);
      return;
    }
    // First message: create the visitor (if needed) and the conversation in one go.
    try {
      await api.ensureVisitor();
      const r = await api.call<{ conversation: ConversationSummary; message: Message }>("/conversations", {
        body: { clientMsgId: crypto.randomUUID(), body, attachments },
      });
      onStarted(r.conversation);
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (initial === null && !error) return <div className="w-body muted pad">Loading…</div>;
  return (
    <>
      <div className="w-body">
        {thread.messages.length === 0 && thread.pending.length === 0 && (
          <p className="muted small pad">Ask anything. A teammate will reply here.</p>
        )}
        <MessageList
          messages={thread.messages}
          pending={thread.pending}
          mine={(m) => m.authorType === "visitor"}
          authorLabel={(m) => (m.authorType === "visitor" ? "You" : m.authorName ?? "Support")}
          otherReadSeq={thread.otherReadSeq}
          typing={thread.typing}
          onRetry={(p) => thread.send(p.body, p.attachments, p.clientMsgId)}
          onDismiss={(p) => thread.dismissPending(p.clientMsgId)}
        />
        {error && <p className="error small pad">{error}</p>}
      </div>
      <Composer placeholder="Write a message…" upload={(file) => api.upload(file)} onTyping={conversationId ? onTyping : undefined} onSend={send} />
    </>
  );
}
