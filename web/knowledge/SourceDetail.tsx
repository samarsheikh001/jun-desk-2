import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { formatSize } from "../lib/thread.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";

// K-04: what a knowledge source contains, and the knobs to fix it: edit a snippet, cap or
// skip pages of a website, remove a page (kept out of future syncs), see its indexed text.
// K-02: an uploaded file shows its original (download) and the text indexed from it.

interface Detail {
  source: {
    id: string;
    kind: "website" | "snippet" | "file";
    url: string | null;
    title: string;
    body: string | null;
    maxPages: number;
    exclude: string[];
    file: { name: string; format: string; size: number } | null;
  };
  documents: { id: string; url: string; title: string | null; chunkCount: number; chunksWithoutVectors: number; updatedAt: number }[];
}

function pathOf(url: string, base: string | null): string {
  try {
    const u = new URL(url);
    return base && u.origin === new URL(base).origin ? `${u.pathname}${u.search}` : url;
  } catch {
    return url;
  }
}

function Chunks({ base, documentId }: { base: string; documentId: string }) {
  const [chunks, setChunks] = useState<{ heading: string; text: string }[] | null>(null);
  useEffect(() => {
    api<{ chunks: { heading: string; text: string }[] }>(`${base}/documents/${documentId}`).then((r) => setChunks(r.chunks), () => setChunks([]));
  }, [base, documentId]);
  if (!chunks) return <div className="muted small">Loading…</div>;
  return (
    <ol className="kb-chunks">
      {chunks.map((c, i) => (
        <li key={i} className="small">
          {c.heading && <div className="strong">{c.heading}</div>}
          <div className="muted">{c.text}</div>
        </li>
      ))}
    </ol>
  );
}

export function SourceDetail({ base, sourceId, canEdit, onChanged }: { base: string; sourceId: string; canEdit: boolean; onChanged: () => void }) {
  const url = `${base}/${sourceId}`;
  const [detail, setDetail] = useState<Detail | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState("");
  const [saved, setSaved] = useState(false);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setDetail(await api<Detail>(url)), [url]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);
  if (!detail) return <div className="kb-detail muted small">Loading…</div>;
  const { source, documents } = detail;

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    run(async () => {
      await api(url, {
        method: "PATCH",
        body:
          source.kind === "snippet"
            ? { title: data.get("title"), body: data.get("body") }
            : source.kind === "file"
              ? { title: data.get("title") }
              : { title: data.get("title"), maxPages: Number(data.get("maxPages")), exclude: String(data.get("exclude") ?? "") },
      });
      await load();
      onChanged();
      setSaved(true);
      setTimeout(() => setSaved(false), 2000);
    });
  };

  const shown = documents.filter((d) => !filter || `${d.title ?? ""} ${d.url}`.toLowerCase().includes(filter.toLowerCase()));

  return (
    <div className="kb-detail">
      <form onSubmit={save} className="kb-edit">
        <label className="field">
          <span className="small">Title</span>
          <Input name="title" defaultValue={source.title} disabled={!canEdit} maxLength={200} />
        </label>
        {source.kind === "snippet" ? (
          <label className="field">
            <span className="small">Text</span>
            <Textarea name="body" rows={8} defaultValue={source.body ?? ""} disabled={!canEdit} />
          </label>
        ) : source.kind === "file" ? (
          source.file && (
            <div className="row small">
              <span className="muted">
                {source.file.name} · {formatSize(source.file.size)}
              </span>
              <a href={`/api${url}/file`} download={source.file.name}>Download original</a>
            </div>
          )
        ) : (
          <>
            <label className="field">
              <span className="small">Max pages</span>
              <Input name="maxPages" type="number" min={1} max={2000} defaultValue={source.maxPages} disabled={!canEdit} style={{ width: 120 }} />
            </label>
            <label className="field">
              <span className="small">Skip these pages <span className="muted">(one per line: a full URL, or a path like /blog/ or /changelog*)</span></span>
              <Textarea name="exclude" rows={3} defaultValue={source.exclude.join("\n")} disabled={!canEdit} placeholder="/blog/" />
            </label>
          </>
        )}
        {canEdit && (
          <div className="row">
            <Button size="sm" disabled={busy}>{source.kind === "website" ? "Save" : "Save and re-index"}</Button>
            {source.kind === "website" && <span className="muted small">Page limits and skips apply on the next sync.</span>}
            {saved && <span className="muted small">Saved ✓</span>}
          </div>
        )}
        {error && <p className="error small">{error}</p>}
      </form>

      {source.kind === "file" &&
        documents.map((d) => (
          <div key={d.id} className="kb-file-doc">
            <div className="row">
              <Button variant="link" size="sm" onClick={() => setOpen(open === d.id ? null : d.id)} title="Show what the AI can quote from this file">
                {open === d.id ? "▾" : "▸"} Indexed text
              </Button>
              <span className="spacer" />
              <span className="muted small">
                {d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"}
                {d.chunksWithoutVectors > 0 ? ` (${d.chunksWithoutVectors} keyword search only)` : ""}
              </span>
            </div>
            {open === d.id && <Chunks base={url} documentId={d.id} />}
          </div>
        ))}

      {source.kind === "website" && (
        <>
          <div className="row">
            <span className="strong small">{documents.length} indexed page{documents.length === 1 ? "" : "s"}</span>
            <span className="spacer" />
            {documents.length > 8 && <Input className="kb-filter" value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter pages" />}
          </div>
          <ScrollArea className="kb-docs-area">
          <ul className="kb-docs">
            {shown.map((d) => (
              <li key={d.id}>
                <div className="row">
                  <Button variant="link" size="sm" onClick={() => setOpen(open === d.id ? null : d.id)} title="Show what the AI can quote from this page">
                    {open === d.id ? "▾" : "▸"} {d.title || pathOf(d.url, source.url)}
                  </Button>
                  <span className="spacer" />
                  <span className="muted small">{d.chunkCount} chunk{d.chunkCount === 1 ? "" : "s"}{d.chunksWithoutVectors > 0 ? ` (${d.chunksWithoutVectors} keyword only)` : ""}</span>
                  <a className="small" href={d.url} target="_blank" rel="noreferrer">Open</a>
                  {canEdit && (
                    <Button variant="outline" size="sm" disabled={busy} title="Remove it now and skip it in future syncs" onClick={() => run(async () => { await api(`${url}/documents/${d.id}`, { method: "DELETE" }); await load(); onChanged(); })}>
                      Remove
                    </Button>
                  )}
                </div>
                <div className="muted small">{pathOf(d.url, source.url)}</div>
                {open === d.id && <Chunks base={url} documentId={d.id} />}
              </li>
            ))}
          </ul>
          </ScrollArea>
        </>
      )}
    </div>
  );
}
