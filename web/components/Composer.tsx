import { useRef, useState, type KeyboardEvent } from "react";
import type { Attachment } from "../../shared/protocol.ts";
import { formatSize } from "../lib/thread.ts";

/** Message input with attachments. Enter sends, Shift+Enter adds a line. */
export function Composer({
  placeholder,
  disabled,
  upload,
  onSend,
  onTyping,
}: {
  placeholder: string;
  disabled?: boolean;
  upload: (file: File) => Promise<Attachment>;
  onSend: (body: string, attachments: Attachment[]) => void | Promise<void>;
  onTyping?: (value: string) => void;
}) {
  const [body, setBody] = useState("");
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [uploading, setUploading] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const submit = async () => {
    if (disabled || uploading > 0 || (!body.trim() && attachments.length === 0)) return;
    const [text, files] = [body, attachments];
    setBody("");
    setAttachments([]);
    await onSend(text, files);
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
    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      void submit();
    }
  };

  return (
    <div className="composer">
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
      <div className="composer-row">
        <button className="ghost icon" title="Attach files" aria-label="Attach files" disabled={disabled} onClick={() => fileInput.current?.click()}>📎</button>
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => void addFiles(e.target.files)} />
        <textarea
          rows={1}
          value={body}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e) => {
            setBody(e.target.value);
            onTyping?.(e.target.value);
          }}
          onKeyDown={onKeyDown}
          onPaste={(e) => {
            if (e.clipboardData.files.length > 0) {
              e.preventDefault();
              void addFiles(e.clipboardData.files);
            }
          }}
        />
        <button disabled={disabled || uploading > 0 || (!body.trim() && attachments.length === 0)} onClick={() => void submit()}>Send</button>
      </div>
    </div>
  );
}
