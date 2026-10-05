import { useRef, useState, type DragEvent } from "react";
import { KB_FILE_EXTENSIONS, MAX_KB_FILE_BYTES } from "../../shared/protocol.ts";
import { formatSize } from "../lib/thread.ts";

// K-02: drag-and-drop or pick files; each uploads on its own with progress and its own error.

interface Item {
  key: string;
  name: string;
  size: number;
  progress: number;
  state: "uploading" | "done" | "error";
  error?: string;
}

const PARALLEL = 3;

/** XHR (not fetch) so the bar can show upload progress. Same headers as attachments. */
function send(url: string, file: File, onProgress: (fraction: number) => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("POST", url);
    xhr.setRequestHeader("Content-Type", "application/octet-stream");
    xhr.setRequestHeader("X-File-Name", encodeURIComponent(file.name));
    xhr.setRequestHeader("X-Jun-Upload", "1");
    xhr.upload.onprogress = (e) => e.lengthComputable && onProgress(e.loaded / e.total);
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `Upload failed (${xhr.status}).`;
      try {
        message = (JSON.parse(xhr.responseText) as { error?: { message?: string } }).error?.message ?? message;
      } catch {
        // keep the generic message
      }
      reject(new Error(message));
    };
    xhr.onerror = () => reject(new Error("Network error. Check your connection and try again."));
    xhr.send(file);
  });
}

export function FileUpload({ base, onUploaded }: { base: string; onUploaded: () => void }) {
  const [items, setItems] = useState<Item[]>([]);
  const [over, setOver] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const update = (key: string, patch: Partial<Item>) => setItems((list) => list.map((i) => (i.key === key ? { ...i, ...patch } : i)));

  const add = async (files: File[]) => {
    const queued: { item: Item; file: File }[] = files.map((file) => {
      const key = `${Date.now()}-${Math.random()}`;
      const ext = file.name.includes(".") ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase() : "";
      const error = !KB_FILE_EXTENSIONS.includes(ext)
        ? "Not a supported type. Use PDF, DOCX, Markdown or plain text."
        : file.size > MAX_KB_FILE_BYTES
          ? `Too large: the limit is ${MAX_KB_FILE_BYTES / 1024 / 1024} MB per file.`
          : file.size === 0
            ? "The file is empty."
            : undefined;
      return { file, item: { key, name: file.name, size: file.size, progress: 0, state: error ? "error" : "uploading", error } };
    });
    setItems((list) => [...queued.map((q) => q.item), ...list].slice(0, 50));
    const todo = queued.filter((q) => q.item.state === "uploading");
    const worker = async () => {
      for (let next = todo.shift(); next; next = todo.shift()) {
        const { item, file } = next;
        try {
          await send(`/api${base}/files`, file, (progress) => update(item.key, { progress }));
          update(item.key, { state: "done", progress: 1 });
          onUploaded();
        } catch (e) {
          update(item.key, { state: "error", error: (e as Error).message });
        }
      }
    };
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  };

  const drop = (e: DragEvent) => {
    e.preventDefault();
    setOver(false);
    void add([...e.dataTransfer.files]);
  };

  return (
    <div className="kb-upload">
      <div
        className={`kb-drop${over ? " over" : ""}`}
        onDragOver={(e) => {
          e.preventDefault();
          setOver(true);
        }}
        onDragLeave={() => setOver(false)}
        onDrop={drop}
      >
        <span className="small">
          <strong>Upload files</strong>: drop PDF, DOCX, Markdown or text files here, or{" "}
          <button type="button" className="link" onClick={() => input.current?.click()}>choose files</button>
        </span>
        <span className="muted small">Up to {MAX_KB_FILE_BYTES / 1024 / 1024} MB each.</span>
        <input
          ref={input}
          type="file"
          multiple
          hidden
          accept={KB_FILE_EXTENSIONS.join(",")}
          aria-label="Upload files"
          onChange={(e) => {
            void add([...(e.target.files ?? [])]);
            e.target.value = "";
          }}
        />
      </div>
      {items.length > 0 && (
        <ul className="kb-uploads">
          {items.map((i) => (
            <li key={i.key} className="small">
              <span className="kb-upload-name" title={i.name}>{i.name}</span>
              <span className="muted">{formatSize(i.size)}</span>
              {i.state === "uploading" && <progress max={1} value={i.progress} aria-label={`Uploading ${i.name}`} />}
              {i.state === "done" && <span className="muted">Uploaded ✓</span>}
              {i.state !== "uploading" && (
                <button type="button" className="link muted" aria-label={`Dismiss ${i.name}`} onClick={() => setItems((list) => list.filter((x) => x.key !== i.key))}>
                  ✕
                </button>
              )}
              {i.state === "error" && <span className="error">{i.error}</span>}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
