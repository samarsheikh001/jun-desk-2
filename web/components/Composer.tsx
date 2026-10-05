import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import type { Attachment } from "../../shared/protocol.ts";
import { formatSize } from "../lib/thread.ts";

export interface SavedReply {
  id: string;
  title: string;
  body: string;
}

type Suggestion = { kind: "mention"; id: string; label: string; start: number } | { kind: "reply"; id: string; label: string; body: string };

/**
 * Message input with attachments. Enter sends, Shift+Enter adds a line. In the dashboard it
 * also writes internal notes with @mentions (I-05) and inserts saved replies with "/" (I-06).
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
  const pendingCaret = useRef<number | null>(null);

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

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className={`composer ${note ? "note" : ""}`}>
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
      {open && (
        <ul className="suggest" role="listbox" aria-label={suggestions[0]!.kind === "reply" ? "Saved replies" : "Mention a teammate"}>
          {suggestions.map((s, i) => (
            <li key={s.id} role="option" aria-selected={i === active} className={i === active ? "active" : ""} onMouseDown={(e) => { e.preventDefault(); pick(s); }}>
              <span className="strong">{s.kind === "mention" ? `@${s.label}` : s.label}</span>
              {s.kind === "reply" && <span className="muted small"> {s.body.slice(0, 80)}</span>}
            </li>
          ))}
        </ul>
      )}
      <div className="composer-row">
        <button className="ghost icon" title="Attach files" aria-label="Attach files" disabled={disabled} onClick={() => fileInput.current?.click()}>📎</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
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
    </div>
  );
}
