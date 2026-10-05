import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { MAX_CSAT_COMMENT, type Attachment, type ConversationSummary, type CsatRating, type Message } from "../../shared/protocol.ts";
import { offersRating } from "../../shared/inbox.ts";
import { Composer } from "../components/Composer.tsx";
import { MessageList } from "../components/MessageList.tsx";
import { formatTime, uploadFile, useThread, useTypingSignal } from "../lib/thread.ts";

// The chat UI inside the widget iframe. The visitor's token is created only when they
// first send something, so just opening the chat stores nothing in their browser.
// With consent-aware mode (V-06, `persist=0`) the token lives in memory only until the
// host page calls JunDesk.consent(true).

const storageKey = (key: string) => `jun:visitor:${key}`;
let memoryToken: string | null = null; // fallback when storage is blocked or not consented
let persist = new URLSearchParams(window.location.search).get("persist") !== "0";

function readToken(key: string): string | null {
  if (!persist) return memoryToken;
  try {
    return localStorage.getItem(storageKey(key)) ?? memoryToken;
  } catch {
    return memoryToken;
  }
}

function writeToken(key: string, token: string | null): void {
  memoryToken = token;
  if (!persist) return;
  try {
    if (token) localStorage.setItem(storageKey(key), token);
    else localStorage.removeItem(storageKey(key));
  } catch {
    // storage blocked: the session still works until the page reloads
  }
}

/** V-06: consent given (or withdrawn) on the host page. */
function setPersist(key: string, next: boolean): void {
  if (next === persist) return;
  persist = next;
  if (next) writeToken(key, memoryToken);
  else {
    try {
      localStorage.removeItem(storageKey(key));
    } catch {
      // nothing stored
    }
  }
}

/** An opening message shown before the conversation exists: a proactive nudge or an agent's invite (V-07). */
interface Opener {
  text: string;
  inviteId?: string;
  from?: string;
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

  /** V-03/V-04: who the host page says its signed-in user is (a JWT); may switch this browser's token. */
  async identify(userToken: string): Promise<void> {
    const { token } = await this.call<{ token: string }>("/identify", { body: { userToken } });
    writeToken(this.key, token);
    this.token = token;
  }

  /** The host app's user signed out: forget this browser's chat identity. */
  forget(): void {
    writeToken(this.key, null);
    this.token = null;
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

/**
 * Asks the loader on the host page for its debug snapshot (recent errors, failed requests,
 * page trail; already masked). Resolves to undefined if there's no loader or it's slow.
 */
function hostContext(): Promise<unknown> {
  if (window.parent === window) return Promise.resolve(undefined);
  const id = crypto.randomUUID();
  return new Promise((resolve) => {
    const done = (value: unknown) => {
      window.removeEventListener("message", onMessage);
      clearTimeout(timer);
      resolve(value);
    };
    const onMessage = (e: MessageEvent) => {
      if (e.source === window.parent && e.data?.type === "jun:context" && e.data.id === id) done(e.data.context);
    };
    const timer = setTimeout(() => done(undefined), 500);
    window.addEventListener("message", onMessage);
    postToHost({ type: "jun:context-request", id });
  });
}
const unread = (c: ConversationSummary) => c.lastMessageAuthor === "agent" && c.lastSeq > c.visitorReadSeq;

interface WidgetConfig {
  workspaceName: string;
  greeting: string;
  ai: boolean;
  color: string;
  replyTime: string;
  logoUrl: string | null;
  hours: { open: boolean; back: string | null } | null;
  /** W-12: ask for a rating when a conversation is resolved. */
  csat: boolean;
}

/** W-04: the desk's brand colour on the frame (with readable text on top of it). */
function applyBrand(color: string): void {
  if (!/^#[0-9a-f]{6}$/i.test(color)) return;
  const n = parseInt(color.slice(1), 16);
  const lum = (0.299 * (n >> 16) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)) / 255;
  document.documentElement.style.setProperty("--accent", color);
  document.documentElement.style.setProperty("--accent-text", lum > 0.65 ? "#1c1c1a" : "#ffffff");
}

export function WidgetApp({ widgetKey }: { widgetKey: string }) {
  const api = useMemo(() => new WidgetApi(widgetKey), [widgetKey]);
  const [config, setConfig] = useState<WidgetConfig | null>(null);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [view, setView] = useState<{ kind: "home" } | { kind: "thread"; id: string | null; opener?: Opener }>({ kind: "home" });
  const [open, setOpen] = useState(window.parent === window);
  const [error, setError] = useState<string | null>(null);
  /** The loader's live session (V-01), sent with a new conversation so the visitor list can show it. */
  const [sessionId, setSessionId] = useState<string | null>(null);
  /** Bumped when this browser's identity changes, to reload its conversations. */
  const [identityVersion, setIdentityVersion] = useState(0);

  useEffect(() => {
    api.call<WidgetConfig>("/config").then(
      (c) => {
        applyBrand(c.color);
        setConfig(c);
      },
      (e: Error) => setError(e.message),
    );
  }, [api]);

  useEffect(() => {
    if (!api.token) {
      setConversations([]);
      return;
    }
    api.call<{ conversations: ConversationSummary[] }>("/conversations").then(
      (r) => {
        setConversations(r.conversations);
        // Go straight back into an ongoing conversation.
        const active = r.conversations.find((c) => c.status !== "resolved");
        setView((v) => (active && !(v.kind === "thread" && v.opener) ? { kind: "thread", id: active.id } : v));
      },
      () => {},
    );
  }, [api, identityVersion]);

  // The loader tells us when the chat is shown or hidden (read receipts only count while shown).
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== window.parent) return;
      const data = e.data as Record<string, unknown> | null;
      if (data?.type === "jun:open") setOpen(true);
      if (data?.type === "jun:close") setOpen(false);
      if (data?.type === "jun:session" || data?.type === "jun:consent") {
        if (typeof data.persist === "boolean") setPersist(api.key, data.persist);
        if (typeof data.sessionId === "string") setSessionId(data.sessionId);
      }
      // Who the host page's signed-in user is (or that they signed out).
      if ((data?.type === "jun:session" && typeof data.userToken === "string") || data?.type === "jun:identify") {
        const userToken = typeof data.userToken === "string" ? data.userToken : null;
        if (userToken) {
          api.identify(userToken).then(
            () => setIdentityVersion((n) => n + 1),
            (err: Error) => console.warn(`[Jun Desk] identify failed: ${err.message}`),
          );
        } else {
          api.forget();
          setView({ kind: "home" });
          setIdentityVersion((n) => n + 1);
        }
      }
      // The visitor clicked "Chat with us" on a nudge or an agent's invite: a new chat with that opener.
      const opener = data?.type === "jun:proactive" ? (data.opener as Opener | undefined) : undefined;
      if (opener && typeof opener.text === "string") {
        if (typeof data!.sessionId === "string") setSessionId(data!.sessionId);
        setView({
          kind: "thread",
          id: null,
          opener: {
            text: opener.text.slice(0, 1000),
            ...(typeof opener.inviteId === "string" ? { inviteId: opener.inviteId } : {}),
            ...(typeof opener.from === "string" ? { from: opener.from.slice(0, 120) } : {}),
          },
        });
        postToHost({ type: "jun:proactive-shown" });
      }
    };
    window.addEventListener("message", onMessage);
    // Only now can we hear the loader's reply, so ask for the current state.
    postToHost({ type: "jun:ready" });
    return () => window.removeEventListener("message", onMessage);
  }, [api]);

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
        {config.logoUrl && <img className="w-logo" src={config.logoUrl} alt="" />}
        <div>
          <strong>{config.workspaceName}</strong>
          <div className="small w-sub">
            {config.hours && !config.hours.open
              ? `We're away${config.hours.back ? ` · back ${config.hours.back}` : ""}${config.ai ? ". The assistant can still help." : ""}`
              : config.replyTime}
          </div>
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
          summary={conversations.find((c) => c.id === view.id) ?? null}
          csat={config.csat}
          away={Boolean(config.hours && !config.hours.open)}
          opener={view.opener}
          sessionId={sessionId}
          aiEnabled={config.ai}
          open={open}
          onStarted={(c) => {
            upsert(c);
            // Keep the proactive opener at the top of the conversation it started.
            setView((v) => ({ kind: "thread", id: c.id, ...(v.kind === "thread" && v.opener ? { opener: v.opener } : {}) }));
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
  summary,
  csat,
  away,
  opener,
  sessionId,
  aiEnabled,
  open,
  onStarted,
  onConversation,
}: {
  api: WidgetApi;
  conversationId: string | null;
  summary: ConversationSummary | null;
  csat: boolean;
  away: boolean;
  opener?: Opener | undefined;
  sessionId: string | null;
  aiEnabled: boolean;
  open: boolean;
  onStarted: (c: ConversationSummary) => void;
  onConversation: (c: ConversationSummary) => void;
}) {
  const [initial, setInitial] = useState<Message[] | null>(conversationId ? null : []);
  const [error, setError] = useState<string | null>(null);
  /** First message is on its way (no conversation yet): show it, and the AI's dots, right away. */
  const [starting, setStarting] = useState<string | null>(null);
  const handling = summary?.handling ?? null;
  const contact = summary?.contact ?? null;

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

  const lastMessage = thread.messages.at(-1);
  // An agent's invite starts a conversation with that agent, not the AI.
  const awaitingAi = Boolean(
    (handling === "ai" || (!conversationId && starting && aiEnabled && !opener?.inviteId)) && !thread.aiStream && (thread.pending.length > 0 || lastMessage?.authorType === "visitor" || starting),
  );

  const latest = lastMessage?.seq ?? 0;
  useEffect(() => {
    if (open && document.visibilityState === "visible" && latest > 0) thread.markRead(latest);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [latest, open, thread.state]);

  const send = async (body: string, attachments: Attachment[]) => {
    setError(null);
    const context = await hostContext();
    if (conversationId) {
      thread.setTyping(false);
      thread.send(body, attachments, undefined, context);
      return;
    }
    // First message: create the visitor (if needed) and the conversation in one go.
    setStarting(body);
    try {
      await api.ensureVisitor();
      const r = await api.call<{ conversation: ConversationSummary; message: Message }>("/conversations", {
        body: { clientMsgId: crypto.randomUUID(), body, attachments, context, ...(opener?.inviteId ? { inviteId: opener.inviteId } : {}), ...(sessionId ? { sessionId } : {}) },
      });
      onStarted(r.conversation);
    } catch (e) {
      setStarting(null);
      setError((e as Error).message);
    }
  };

  if (initial === null && !error) return <div className="w-body muted pad">Loading…</div>;
  return (
    <>
      <div className="w-body">
        {/* Once the conversation exists, an invite is its first real message: don't show it twice. */}
        {opener && !(opener.inviteId && thread.messages.length > 0) ? (
          opener.inviteId ? (
            <div className="msg other w-opener">
              <div className="meta small muted">{opener.from}</div>
              <div className="bubble">{opener.text}</div>
            </div>
          ) : (
            <div className="msg other ai w-opener">
              <div className="bubble">{opener.text} Tell me what you were trying to do and I'll take a look.</div>
            </div>
          )
        ) : (
          thread.messages.length === 0 && thread.pending.length === 0 && <p className="muted small pad">Ask anything. A teammate will reply here.</p>
        )}
        <MessageList
          messages={thread.messages}
          pending={starting && !conversationId ? [{ clientMsgId: "starting", body: starting, attachments: [] }] : thread.pending}
          mine={(m) => m.authorType === "visitor"}
          authorLabel={(m) => (m.authorType === "visitor" ? "You" : m.authorType === "ai" ? "AI assistant" : m.authorName ?? "Support")}
          otherReadSeq={thread.otherReadSeq}
          typing={thread.typing}
          aiStream={thread.aiStream}
          // Show the AI "typing" the instant the visitor sends, not when the server gets going.
          aiThinking={thread.aiThinking || awaitingAi}
          onRetry={(p) => thread.send(p.body, p.attachments, p.clientMsgId)}
          onDismiss={(p) => thread.dismissPending(p.clientMsgId)}
        />
        {error && <p className="error small pad">{error}</p>}
      </div>
      {/* W-07: a person is always one click away while the AI is answering. */}
      {conversationId && handling === "ai" && (
        <div className="w-human">
          <button className="link small" onClick={() => thread.requestHuman()}>Talk to a person</button>
        </div>
      )}
      {/* W-12: rate a resolved conversation someone (the team or the AI) actually answered. */}
      {conversationId && summary && offersRating(csat, summary.status, thread.messages) && (
        <CsatAsk api={api} conversationId={conversationId} rated={summary.csat.ratedThisRound} onConversation={onConversation} />
      )}
      {conversationId && (
        <EmailAsk api={api} conversationId={conversationId} contact={contact} away={away} waiting={handling === "human" ? lastVisitorWaiting(thread.messages) : null} />
      )}
      <Composer placeholder="Write a message…" upload={(file) => api.upload(file)} onTyping={conversationId ? onTyping : undefined} onSend={send} />
    </>
  );
}

/** The visitor's last message has no team reply after it yet (system notices don't count). */
function lastVisitorWaiting(messages: Message[]): Message | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!;
    if (m.authorType === "visitor") return m;
    if (m.authorType === "agent" || m.authorType === "ai") return null;
  }
  return null;
}

/** W-08: ask for an email when the team is away or nobody's online, or nobody has replied for this long. */
const EMAIL_ASK_AFTER_MS = 60_000;

function EmailAsk({
  api,
  conversationId,
  contact,
  away,
  waiting,
}: {
  api: WidgetApi;
  conversationId: string;
  contact: ConversationSummary["contact"] | null;
  away: boolean;
  waiting: Message | null;
}) {
  const [now, setNow] = useState(Date.now());
  const [dismissed, setDismissed] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [nobodyOnline, setNobodyOnline] = useState(false);

  const eligible = Boolean(waiting && contact && !contact.verified && !contact.email);
  // Nobody has the dashboard open: no point making them wait a minute first.
  useEffect(() => {
    if (!eligible || away) return;
    let cancelled = false;
    api.call<{ online: boolean }>("/online").then((r) => !cancelled && setNobodyOnline(!r.online), () => {});
    return () => {
      cancelled = true;
    };
  }, [api, eligible, away, waiting?.id]);

  const due = waiting ? waiting.createdAt + EMAIL_ASK_AFTER_MS : 0;
  useEffect(() => {
    if (!waiting || away || Date.now() >= due) return;
    const timer = setTimeout(() => setNow(Date.now()), due - Date.now() + 50);
    return () => clearTimeout(timer);
  }, [waiting, away, due]);

  if (saved) return <div className="w-email small"><span>Thanks. If you've gone by the time we reply, we'll email you at <strong>{saved}</strong>.</span></div>;
  if (dismissed || !waiting || !contact || contact.verified || contact.email) return null;
  if (!away && !nobodyOnline && now < due) return null;

  const submit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const email = String(new FormData(e.currentTarget).get("email") ?? "");
    setBusy(true);
    setError(null);
    try {
      setSaved((await api.call<{ email: string }>(`/conversations/${conversationId}/email`, { body: { email } })).email);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="w-email" onSubmit={submit}>
      <div className="row">
        <span className="small strong">{away ? "We're away right now." : nobodyOnline ? "Nobody's online right now." : "Sorry for the wait."} Get the reply by email?</span>
        <span className="spacer" />
        <button type="button" className="ghost icon small" aria-label="No thanks" onClick={() => setDismissed(true)}>×</button>
      </div>
      <div className="row">
        <input name="email" type="email" required maxLength={320} placeholder="you@company.com" aria-label="Your email" autoComplete="email" />
        <button disabled={busy}>Save</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </form>
  );
}

/** W-12: "How did we do?" under a resolved conversation. Thumbs first, then an optional comment. */
function CsatAsk({
  api,
  conversationId,
  rated,
  onConversation,
}: {
  api: WidgetApi;
  conversationId: string;
  rated: boolean;
  onConversation: (c: ConversationSummary) => void;
}) {
  // Stays mounted through the comment step, after the server already counts it as rated.
  const [rating, setRating] = useState<CsatRating | null>(null);
  const [done, setDone] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const post = async (body: { rating: CsatRating; comment?: string }) => {
    setBusy(true);
    setError(null);
    try {
      onConversation((await api.call<{ conversation: ConversationSummary }>(`/conversations/${conversationId}/rating`, { body })).conversation);
      return true;
    } catch (err) {
      setError((err as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  if (done) return <div className="w-csat small"><span>Thanks for your feedback.</span></div>;
  if (rating) {
    const submit = async (e: FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      const comment = String(new FormData(e.currentTarget).get("comment") ?? "").trim();
      if (!comment || (await post({ rating, comment }))) setDone(true);
    };
    return (
      <form className="w-csat" onSubmit={submit}>
        <span className="small strong">{rating === "good" ? "Thanks! Anything to add?" : "Thanks for telling us. Anything we could do better?"}</span>
        <textarea name="comment" rows={2} maxLength={MAX_CSAT_COMMENT} placeholder="Optional" aria-label="Your comment" autoFocus />
        <div className="row">
          <span className="spacer" />
          <button type="button" className="ghost small" onClick={() => setDone(true)}>Skip</button>
          <button className="small" disabled={busy}>Send</button>
        </div>
        {error && <p className="error small">{error}</p>}
      </form>
    );
  }
  if (rated || dismissed) return null;

  const rate = async (value: CsatRating) => {
    if (await post({ rating: value })) setRating(value);
  };
  return (
    <div className="w-csat">
      <div className="row">
        <span className="small strong">How did we do?</span>
        <span className="spacer" />
        <button type="button" className="ghost w-thumb" disabled={busy} aria-label="Good" title="Good" onClick={() => void rate("good")}>👍</button>
        <button type="button" className="ghost w-thumb" disabled={busy} aria-label="Bad" title="Bad" onClick={() => void rate("bad")}>👎</button>
        <button type="button" className="ghost icon small" aria-label="No thanks" onClick={() => setDismissed(true)}>×</button>
      </div>
      {error && <p className="error small">{error}</p>}
    </div>
  );
}
