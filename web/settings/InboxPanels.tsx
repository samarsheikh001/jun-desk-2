import { useCallback, useEffect, useState, type FormEvent } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";

interface SavedReplyRow { id: string; title: string; body: string }
interface TagRow { id: string; name: string; conversations: number }

/** I-06: the team's saved replies. Any member can add and edit them. */
export function SavedRepliesPanel({ workspaceId }: { workspaceId: string }) {
  const base = `/workspaces/${workspaceId}/saved-replies`;
  const [replies, setReplies] = useState<SavedReplyRow[]>([]);
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setReplies((await api<{ savedReplies: SavedReplyRow[] }>(base)).savedReplies), [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const save = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const body = { title: String(form.get("title")), body: String(form.get("body")) };
    run(async () => {
      if (editing === "new") await api(base, { body });
      else await api(`${base}/${editing}`, { method: "PATCH", body });
      setEditing(null);
      await load();
    });
  };

  const current = editing && editing !== "new" ? replies.find((r) => r.id === editing) : undefined;
  return (
    <section className="panel">
      <div className="row">
        <h2>Saved replies</h2>
        <span className="spacer" />
        {editing === null && <button className="ghost small" onClick={() => setEditing("new")}>New saved reply</button>}
      </div>
      <p className="muted small">
        Answers your team sends often. Type <code>/</code> in the reply box to search them. <code>{"{first_name}"}</code> becomes the customer's first name and{" "}
        <code>{"{agent_name}"}</code> yours.
      </p>
      {editing !== null && (
        <form className="stack" onSubmit={save} key={editing}>
          <input name="title" required maxLength={80} placeholder="Title, e.g. Refund policy" aria-label="Saved reply title" defaultValue={current?.title ?? ""} />
          <textarea name="body" required maxLength={5000} rows={4} placeholder="Hi {first_name}, …" aria-label="Saved reply text" defaultValue={current?.body ?? ""} />
          <div className="row">
            <button disabled={busy}>Save</button>
            <button type="button" className="ghost" onClick={() => setEditing(null)}>Cancel</button>
          </div>
        </form>
      )}
      {error && <p className="error small">{error}</p>}
      {replies.length > 0 && (
        <ul className="list">
          {replies.map((r) => (
            <li key={r.id} className="row">
              <span className="strong">{r.title}</span>
              <span className="muted small clip">{r.body}</span>
              <span className="spacer" />
              <button className="ghost small" onClick={() => setEditing(r.id)}>Edit</button>
              <button className="ghost small" disabled={busy} onClick={() => run(async () => { await api(`${base}/${r.id}`, { method: "DELETE" }); await load(); })}>Delete</button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/** I-07: rename or delete tags (owners and admins). Tags are created from a conversation. */
export function TagsPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/tags`;
  const [tags, setTags] = useState<TagRow[]>([]);
  const { busy, error, run } = useAction();
  const load = useCallback(async () => setTags((await api<{ tags: TagRow[] }>(base)).tags), [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  return (
    <section className="panel">
      <h2>Tags</h2>
      <p className="muted small">Add tags from a conversation's header ("+ Tag") and filter the inbox by them. Visitors never see tags.</p>
      {error && <p className="error small">{error}</p>}
      {tags.length === 0 ? (
        <p className="muted small">No tags yet.</p>
      ) : (
        <ul className="list">
          {tags.map((t) => (
            <li key={t.id} className="row">
              <span className="chip tag-chip">{t.name}</span>
              <span className="muted small">{t.conversations} conversation{t.conversations === 1 ? "" : "s"}</span>
              <span className="spacer" />
              {canEdit && (
                <>
                  <button
                    className="ghost small"
                    disabled={busy}
                    onClick={() => {
                      const name = window.prompt("Rename tag", t.name);
                      if (name && name !== t.name) run(async () => { await api(`${base}/${t.id}`, { method: "PATCH", body: { name } }); await load(); });
                    }}
                  >
                    Rename
                  </button>
                  <button className="ghost small" disabled={busy} onClick={() => run(async () => { await api(`${base}/${t.id}`, { method: "DELETE" }); await load(); })}>Delete</button>
                </>
              )}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
