import { useEffect, useImperativeHandle, useMemo, useRef, useState, type ComponentType, type KeyboardEvent, type ReactNode, type Ref } from "react";
import type { Attachment } from "../../shared/protocol.ts";
import { canCaptureScreen, captureScreen } from "../lib/screenshot.ts";
import { formatSize } from "../lib/thread.ts";

export interface SavedReply {
  id: string;
  title: string;
  body: string;
}

/** I-13: lets the inbox's shortcuts and command palette drive the composer. */
export interface ComposerControl {
  /** Focuses the input, switching to Reply or Note first (`notes` only). */
  focus(mode?: "reply" | "note"): void;
  /** Inserts text (a saved reply): replaces an empty draft, otherwise goes on a new line. */
  insert(text: string): void;
}

type Suggestion = { kind: "mention"; id: string; label: string; start: number } | { kind: "reply"; id: string; label: string; body: string };

/**
 * Message input with attachments. Enter sends, Shift+Enter adds a line. In the dashboard it
 * also writes internal notes with @mentions (I-05) and inserts saved replies with "/" (I-06).
 * Ctrl/⌘+Enter sends too, even with suggestions open; in the dashboard Esc leaves the input (I-13).
 */
export function Composer({
  placeholder,
  disabled,
  upload,
  onSend,
  onTyping,
  notes,
  mentionables = [],
  savedReplies = [],
  fillReply = (body) => body,
  screenshot = false,
  control,
  suggestScroller: SuggestScroller,
  pill = false,
}: {
  placeholder: string;
  disabled?: boolean;
  upload: (file: File) => Promise<Attachment>;
  onSend: (body: string, attachments: Attachment[], options: { internal: boolean }) => void | Promise<void>;
  onTyping?: (value: string) => void;
  /** Offer a Reply / Note switch (agents only). */
  notes?: boolean;
  mentionables?: { id: string; name: string }[];
  savedReplies?: SavedReply[];
  fillReply?: (body: string) => string;
  /** S-15: offer "Send a screenshot" (the widget), where the browser supports it. */
  screenshot?: boolean;
  control?: Ref<ComposerControl>;
  /**
   * The dashboard scrolls the suggestions in a shadcn ScrollArea; passed in (not imported) so
   * the widget, which shares this component, keeps its own markup and bundle.
   */
  suggestScroller?: ComponentType<{ className: string; children: ReactNode }>;
  /** The widget's "Ask anything…" bar (W-04 bar launcher, D-32): the box first, then icon buttons. */
  pill?: boolean;
}) {
  const [body, setBody] = useState("");
  const [note, setNote] = useState(false);
  const [caret, setCaret] = useState(0);
  const [active, setActive] = useState(0);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const suggestList = useRef<HTMLUListElement>(null);
  const pendingCaret = useRef<number | null>(null);
  // S-15: a captured screenshot waiting for the visitor to send or discard it.
  const canShoot = useMemo(() => screenshot && canCaptureScreen(), [screenshot]);
  const [shot, setShot] = useState<{ file: File; url: string } | null>(null);
  const [shooting, setShooting] = useState(false);
  useEffect(() => () => {
    if (shot) URL.revokeObjectURL(shot.url);
  }, [shot]);

  const before = body.slice(0, caret);
  const suggestions = useMemo<Suggestion[]>(() => {
    if (dismissed === before) return [];
    const reply = /^\/([^\n]*)$/.exec(body);
    if (reply && savedReplies.length) {
      const q = reply[1]!.trim().toLowerCase();
      return savedReplies
        .filter((r) => r.title.toLowerCase().includes(q) || (q.length > 2 && r.body.toLowerCase().includes(q)))
        .slice(0, 8)
        .map((r) => ({ kind: "reply", id: r.id, label: r.title, body: r.body }));
    }
    const mention = note ? /(?:^|\s)@([\p{L}\p{N}_]*(?: [\p{L}\p{N}_]*)?)$/u.exec(before) : null;
    if (mention) {
      const q = mention[1]!.toLowerCase();
      return mentionables
        .filter((m) => m.name.toLowerCase().startsWith(q))
        .slice(0, 8)
        .map((m) => ({ kind: "mention", id: m.id, label: m.name, start: before.length - q.length - 1 }));
    }
    return [];
  }, [body, before, note, mentionables, savedReplies, dismissed]);
  const open = suggestions.length > 0;

  useEffect(() => setActive(0), [suggestions.length]);
  useEffect(() => {
    suggestList.current?.children[active]?.scrollIntoView({ block: "nearest" });
  }, [active]);
  useEffect(() => {
    if (pendingCaret.current === null || !input.current) return;
    input.current.setSelectionRange(pendingCaret.current, pendingCaret.current);
    setCaret(pendingCaret.current);
    pendingCaret.current = null;
  }, [body]);

  const change = (value: string) => {
    setBody(value);
    // Notes stay between agents: don't show the visitor "typing…" for them.
    if (!note) onTyping?.(value);
  };

  const pick = (s: Suggestion) => {
    if (s.kind === "reply") {
      const filled = fillReply(s.body);
      pendingCaret.current = filled.length;
      change(filled);
    } else {
      const inserted = `${body.slice(0, s.start)}@${s.label} `;
      pendingCaret.current = inserted.length;
      change(inserted + body.slice(caret));
    }
    input.current?.focus();
  };

  const switchMode = (toNote: boolean) => {
    if (toNote === note) return;
    if (toNote) onTyping?.("");
    setNote(toNote);
    input.current?.focus();
  };

  useImperativeHandle(control, () => ({
    focus(mode) {
      if (mode && notes) switchMode(mode === "note");
      input.current?.focus();
    },
    insert(text) {
      const next = body.trim() ? `${body.replace(/\s+$/, "")}\n${text}` : text;
      pendingCaret.current = next.length;
      change(next);
      input.current?.focus();
    },
  }));

  const submit = async () => {
    if (disabled || uploading > 0 || (!body.trim() && attachments.length === 0)) return;
    const [text, files] = [body, attachments];
    setBody("");
    setAttachments([]);
    await onSend(text, files, { internal: note });
  };

  const addFiles = async (files: FileList | null) => {
    setError(null);
    for (const file of Array.from(files ?? [])) {
      setUploading((n) => n + 1);
      try {
        const attachment = await upload(file);
        setAttachments((a) => [...a, attachment]);
      } catch (e) {
        setError((e as Error).message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
    if (fileInput.current) fileInput.current.value = "";
  };

  const takeScreenshot = async () => {
    setError(null);
    setShooting(true);
    try {
      const file = await captureScreen();
      if (file) setShot({ file, url: URL.createObjectURL(file) });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setShooting(false);
    }
  };

  /** Sends the screenshot now, with whatever the visitor already typed or attached. */
  const sendShot = async () => {
    if (!shot) return;
    setUploading((n) => n + 1);
    try {
      const attachment = await upload(shot.file);
      setShot(null);
      const [text, files] = [body, attachments];
      setBody("");
      setAttachments([]);
      await onSend(text, [...files, attachment], { internal: note });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setUploading((n) => n - 1);
    }
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.nativeEvent.isComposing || e.keyCode === 229) return; // an IME is composing: its keys aren't ours
    if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      void submit();
      return;
    }
    if (open) {
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        setActive((i) => (i + (e.key === "ArrowDown" ? 1 : suggestions.length - 1)) % suggestions.length);
        return;
      }
      if ((e.key === "Enter" && !e.shiftKey) || e.key === "Tab") {
        e.preventDefault();
        pick(suggestions[active] ?? suggestions[0]!);
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        setDismissed(before);
        return;
      }
    }
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      void submit();
      return;
    }
    // Agents: Esc leaves the input so single-key shortcuts work again (the draft stays).
    if (e.key === "Escape" && notes) {
      e.preventDefault();
      input.current?.blur();
    }
  };

  return (
    <div className={`composer ${note ? "note" : ""} ${pill ? "pill" : ""}`}>
      {notes && (
        <div className="composer-modes" role="tablist">
          <button role="tab" aria-selected={!note} className={`mode ${note ? "" : "active"}`} onClick={() => switchMode(false)}>Reply</button>
          <button role="tab" aria-selected={note} className={`mode ${note ? "active" : ""}`} onClick={() => switchMode(true)}>Note</button>
          {note && <span className="muted small">Only your team sees notes. Type @ to mention someone.</span>}
        </div>
      )}
      {(attachments.length > 0 || uploading > 0 || error) && (
        <div className="composer-files">
          {attachments.map((a) => (
            <span key={a.key} className="chip">
              📎 {a.name} <span className="muted">{formatSize(a.size)}</span>
              <button className="link" aria-label={`Remove ${a.name}`} onClick={() => setAttachments((x) => x.filter((y) => y.key !== a.key))}>×</button>
            </span>
          ))}
          {uploading > 0 && <span className="muted small">Uploading…</span>}
          {error && <span className="error small">{error}</span>}
        </div>
      )}
      {shot && (
        <div className="composer-shot" role="group" aria-label="Screenshot preview">
          <img src={shot.url} alt="Your screenshot" />
          <div className="composer-shot-actions">
            <span className="muted small">Check it shows nothing private. It's sent only if you press Send.</span>
            <button className="ghost small" disabled={uploading > 0} onClick={() => setShot(null)}>Discard</button>
            <button className="small" disabled={disabled || uploading > 0} onClick={() => void sendShot()}>{uploading > 0 ? "Sending…" : "Send screenshot"}</button>
          </div>
        </div>
      )}
      {open && (() => {
        const list = (
          <ul ref={suggestList} className={SuggestScroller ? "suggest-list" : "suggest"} role="listbox" aria-label={suggestions[0]!.kind === "reply" ? "Saved replies" : "Mention a teammate"}>
            {suggestions.map((s, i) => (
              <li key={s.id} role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); pick(s); }}>
                <span className="strong">{s.kind === "mention" ? `@${s.label}` : s.label}</span>
                {s.kind === "reply" && <span className="muted small"> {s.body.slice(0, 80)}</span>}
              </li>
            ))}
          </ul>
        );
        return SuggestScroller ? <SuggestScroller className="suggest">{list}</SuggestScroller> : list;
      })()}
      {pill ? (
        <div className="composer-row">
          <textarea
            ref={input}
            rows={1}
            value={body}
            placeholder={placeholder}
            disabled={disabled}
            aria-label="Message"
            onChange={(e) => change(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={(e) => {
              if (e.clipboardData.files.length > 0) {
                e.preventDefault();
                void addFiles(e.clipboardData.files);
              }
            }}
          />
          <div className="composer-actions">
            <button type="button" title="Attach files" aria-label="Attach files" disabled={disabled} onClick={() => fileInput.current?.click()}>
              <svg width="16" height="16" fill="none" viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M7.67 2.507a.85.85 0 0 1 0 1.202L3.524 7.855a2.464 2.464 0 0 0 3.485 3.484l5.925-5.926a.836.836 0 0 0-1.181-1.182L5.87 10.113A.85.85 0 0 1 4.669 8.91l5.881-5.88a2.536 2.536 0 0 1 3.585 3.586L8.201 12.55a4.164 4.164 0 0 1-5.889-5.888l.006-.005 4.149-4.15a.85.85 0 0 1 1.202 0Z" /></svg>
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
            {canShoot && (
              <button type="button" title="Send a screenshot" aria-label="Send a screenshot" disabled={disabled || shooting || shot !== null} onClick={() => void takeScreenshot()}>
                <svg width="16" height="16" fill="none" viewBox="0 0 16 16" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" aria-hidden="true"><path d="M2 5.5A1.5 1.5 0 0 1 3.5 4h1.6l1-1.5h3.8l1 1.5h1.6A1.5 1.5 0 0 1 14 5.5v6a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 2 11.5z" /><circle cx="8" cy="8.5" r="2.25" /></svg>
              </button>
            )}
          </div>
          <button className="composer-send" aria-label="Send" disabled={disabled || uploading > 0 || (!body.trim() && attachments.length === 0)} onClick={() => void submit()}>
            <svg width="16" height="16" aria-hidden="true"><path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d="M7.4 1.899a.85.85 0 0 1 1.201 0l4.5 4.5A.85.85 0 1 1 11.9 7.6L8.85 4.552V13.5a.85.85 0 0 1-1.7 0V4.552L4.101 7.601A.85.85 0 1 1 2.9 6.399z" /></svg>
          </button>
        </div>
      ) : (
      <div className="composer-row">
        <button className="ghost icon" title="Attach files" aria-label="Attach files" disabled={disabled} onClick={() => fileInput.current?.click()}>📎</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
        {canShoot && (
          <button className="ghost icon" title="Send a screenshot" aria-label="Send a screenshot" disabled={disabled || shooting || shot !== null} onClick={() => void takeScreenshot()}>
            📷
          </button>
        )}
        <textarea
          ref={input}
          rows={1}
          value={body}
          placeholder={note ? "Note for your team… (@ to mention)" : placeholder}
          disabled={disabled}
          aria-label={note ? "Note" : "Message"}
          onChange={(e) => {
            setCaret(e.target.selectionStart);
            change(e.target.value);
          }}
          onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              void addFiles(e.clipboardData.files);
            }
          }}
        />
        <button disabled={disabled || uploading > 0 || (!body.trim() && attachments.length === 0)} onClick={() => void submit()}>{note ? "Add note" : "Send"}</button>
      </div>
      )}
    </div>
  );
}
