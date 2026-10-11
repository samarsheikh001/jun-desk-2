import { useRef, useState, useSyncExternalStore, type FormEvent } from "react";
import { api, describeError } from "../api.ts";
import type { WidgetEditTurn } from "../../shared/widget-ai.ts";
import { Button } from "@/components/ui/button.tsx";
import { ArrowUpIcon, RefreshIcon } from "../components/icons.tsx";
import { PixelLoader } from "../components/PixelLoader.tsx";
import {
  MessageScroller,
  MessageScrollerButton,
  MessageScrollerContent,
  MessageScrollerItem,
  MessageScrollerProvider,
  MessageScrollerViewport,
} from "@/components/ui/message-scroller.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// W-22: change a widget by asking. Each request sends the widget's file, the request and the chat
// so far; the answer's file goes into the draft at once (the preview beside it updates), with Undo
// on that message. The chat lives for this visit (per widget), not on the server.

interface Turn {
  id: number;
  role: "user" | "assistant" | "error";
  text: string;
  /** The file before this change (Undo puts it back) and after it. */
  before?: string;
  after?: string;
  undone?: boolean;
}

const chats = new Map<string, Turn[]>();
const listeners = new Set<() => void>();
let nextId = 1;
const setChat = (path: string, turns: Turn[]) => {
  chats.set(path, turns);
  listeners.forEach((l) => l());
};
const EMPTY: Turn[] = [];
function useChat(path: string): Turn[] {
  return useSyncExternalStore((cb) => (listeners.add(cb), () => listeners.delete(cb)), () => chats.get(path) ?? EMPTY);
}

const IDEAS = ["Make it more compact", "Add a status badge in the corner", "Use a dark theme", "Add a button that opens the invoice"];

export function WidgetChat({ cfg, path, name }: { cfg: AgentConfig; path: string; name: string }) {
  const turns = useChat(path);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);

  /** `base`: the turns to continue from (Try again drops the failed request and its error). */
  const send = async (text: string, base: Turn[] = turns) => {
    const ask = text.trim();
    if (!ask || busy) return;
    const file = cfg.draft[path] ?? "";
    const history: WidgetEditTurn[] = base.filter((t) => t.role !== "error").map((t) => ({ role: t.role as "user" | "assistant", text: t.text }));
    const withAsk = [...base, { id: nextId++, role: "user" as const, text: ask }];
    setChat(path, withAsk);
    setMessage("");
    setBusy(true);
    try {
      const result = await api<{ reply: string; file: string; changed: boolean }>(`${cfg.base}/widget-edit`, { body: { name, file, message: ask, history } });
      // Applied to the draft as it is now (the request carried the file it was made from).
      if (result.changed) cfg.setFile(path, result.file);
      setChat(path, [...withAsk, { id: nextId++, role: "assistant", text: result.reply, ...(result.changed ? { before: file, after: result.file } : {}) }]);
    } catch (error) {
      setChat(path, [...withAsk, { id: nextId++, role: "error", text: describeError(error) }]);
    } finally {
      setBusy(false);
      input.current?.focus();
    }
  };

  const undo = (turn: Turn) => {
    if (turn.before === undefined) return;
    cfg.setFile(path, turn.before);
    setChat(path, turns.map((t) => (t.id === turn.id ? { ...t, undone: true } : t)));
  };
  const redo = (turn: Turn) => {
    if (turn.after === undefined) return;
    cfg.setFile(path, turn.after);
    setChat(path, turns.map((t) => (t.id === turn.id ? { ...t, undone: false } : t)));
  };
  const lastAsk = [...turns].reverse().find((t) => t.role === "user");

  return (
    <div className="wchat">
      {/* shadcn's Message Scroller: a new request settles near the top with 64px of the turn before
          it showing, the answer comes in below; it follows only while you're at the end, and a
          reopened chat opens at its last request. */}
      <MessageScrollerProvider autoScroll defaultScrollPosition="last-anchor" scrollPreviousItemPeek={64}>
        <MessageScroller className="wchat-scroller">
          <MessageScrollerViewport aria-label="Chat about this widget">
            <MessageScrollerContent className="wchat-rows" aria-busy={busy}>
              {turns.length === 0 && !busy && (
                <MessageScrollerItem className="wchat-empty">
                  <p className="wchat-empty-title">What should change?</p>
                  <p className="wchat-empty-text">Describe it in your words. The AI edits this widget and the preview updates; nothing goes live until you save.</p>
                  <div className="wchat-ideas">
                    {IDEAS.map((idea) => (
                      <button key={idea} type="button" className="wchat-idea" onClick={() => void send(idea)}>
                        {idea}
                      </button>
                    ))}
                  </div>
                </MessageScrollerItem>
              )}
              {turns.map((turn) =>
                turn.role === "user" ? (
                  <MessageScrollerItem key={turn.id} messageId={String(turn.id)} scrollAnchor className="wchat-row-user">
                    <div className="wchat-user">{turn.text}</div>
                  </MessageScrollerItem>
                ) : turn.role === "error" ? (
                  <MessageScrollerItem key={turn.id} messageId={String(turn.id)} className="wchat-ai wchat-error">
                    <p>{turn.text}</p>
                    {lastAsk && turn === turns[turns.length - 1] && (
                      <Button variant="ghost" size="sm" onClick={() => void send(lastAsk.text, turns.slice(0, -2))}>
                        <RefreshIcon /> Try again
                      </Button>
                    )}
                  </MessageScrollerItem>
                ) : (
                  <MessageScrollerItem key={turn.id} messageId={String(turn.id)} className="wchat-ai">
                    <p>{turn.text}</p>
                    <div className="wchat-meta">
                      {turn.before === undefined ? (
                        <span>No change</span>
                      ) : turn.undone ? (
                        <>
                          <span>Undone</span>
                          <button type="button" className="link-button" onClick={() => redo(turn)}>Redo</button>
                        </>
                      ) : (
                        <>
                          <span>Changed the widget</span>
                          <button type="button" className="link-button" onClick={() => undo(turn)}>Undo</button>
                        </>
                      )}
                    </div>
                  </MessageScrollerItem>
                ),
              )}
              {busy && (
                <MessageScrollerItem messageId="pending" className="wchat-ai wchat-pending" role="status">
                  <PixelLoader label="Editing the widget" />
                </MessageScrollerItem>
              )}
            </MessageScrollerContent>
          </MessageScrollerViewport>
          <MessageScrollerButton />
        </MessageScroller>
      </MessageScrollerProvider>
      <form
        className="wchat-composer"
        onSubmit={(e: FormEvent) => {
          e.preventDefault();
          void send(message);
        }}
      >
        <textarea
          ref={input}
          rows={1}
          value={message}
          placeholder="Describe a change…"
          aria-label="Describe a change"
          maxLength={2000}
          onChange={(e) => setMessage(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send(message);
            }
          }}
        />
        <Button type="submit" size="icon-sm" aria-label="Send" disabled={busy || !message.trim()}>
          <ArrowUpIcon />
        </Button>
      </form>
    </div>
  );
}
