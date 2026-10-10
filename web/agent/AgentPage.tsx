import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api, ApiError } from "../api.ts";
import { navigate } from "../lib/router.ts";
import { useAction } from "../useAction.ts";
import { PageTabs } from "../components/PageTabs.tsx";
import { AiPanel } from "./AiPanel.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Label } from "@/components/ui/label.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog.tsx";
import { PlusIcon, TrashIcon } from "../components/icons.tsx";
import { previewSummary, previewWidget, starterWidget, type WidgetNode } from "../../shared/widgets.ts";
import { WidgetCard } from "../widget/chatkit/WidgetCard.tsx";

// Support agent as code (AI-18): the dashboard edits the same files as `jun pull` / `jun push`.

type Files = Record<string, string>;

interface Issue {
  path: string;
  message: string;
}

interface Version {
  version: number;
  message: string;
  source: "dashboard" | "cli";
  createdBy: string | null;
  createdAt: number;
}

interface AgentState {
  version: number | null;
  files: Files;
  issues: Issue[];
  summary: { skills: string[]; tools: string[]; evals: number; maxReplies: number; handoffTopics: string[]; widgets: string[] };
  versions: Version[];
}

type Kind = "skill" | "tool" | "eval" | "widget";

// What each kind of file is, where it lives, and the starter it's created with (same shapes as `jun init`).
const KINDS: Record<Kind, { group: string; one: string; what: string; placeholder: string; path: (name: string) => string; starter: (name: string) => string }> = {
  skill: {
    group: "Procedures",
    one: "procedure",
    what: "Step-by-step instructions the AI follows in one situation, like changing a plan or cancelling an account.",
    placeholder: "change-plan",
    path: (name) => `skills/${name}/SKILL.md`,
    starter: (name) => `---\nname: ${name}\ndescription: When this procedure applies, e.g. "The customer asks to change their plan."\n---\n1. First step.\n2. Second step.\n3. When to hand off to a person.\n`,
  },
  tool: {
    group: "Tools",
    one: "tool",
    what: "An HTTP endpoint the AI can call to look something up or take an action, like fetching an order.",
    placeholder: "lookup_order",
    path: (name) => `tools/${name}.yaml`,
    starter: () => `description: What this returns and when the AI should use it.\nstatus: Looking that up   # what the customer sees while it runs, e.g. "Checking your order"\nmethod: GET\nurl: https://api.example.com/things/{id}\nheaders:\n  Authorization: Bearer {secrets.API_KEY}   # Worker secret JUN_SECRET_API_KEY\ninput:\n  id:\n    type: string\n    description: What the AI should pass\n`,
  },
  eval: {
    group: "Evals",
    one: "eval file",
    what: "Test cases: a customer message and what a good reply does. Run them with `jun eval` before a change goes live.",
    placeholder: "billing",
    path: (name) => `evals/${name}.yaml`,
    starter: () => `- name: example\n  message: A customer message\n  expect:\n    outcome: answer        # answer | handoff | escalate\n    criteria: What a good reply does\n`,
  },
  widget: {
    group: "Widgets",
    one: "widget",
    what: "A card a tool's result is shown as, like a plan summary or an order's status. Design one in ChatKit Studio (widgets.chatkit.studio), download the .widget file and paste it here; then add `widget: <name>` to the tool. Optional `\"summary\"`: a one-line template from the same data (\"{{ plan }} · {{ status }}\"), shown when the chat folds the card into a pill.",
    placeholder: "subscription",
    path: (name) => `widgets/${name}.widget`,
    starter: (name) => starterWidget(name.replace(/[_-]+/g, " ").replace(/^./, (c) => c.toUpperCase())),
  },
};

/** The file name a typed name becomes: lower-case, dashes (procedures, evals) or underscores (tools). */
function slug(kind: Kind, raw: string): string {
  const underscores = kind === "tool" || kind === "widget";
  const name = raw.trim().toLowerCase().replace(/[^a-z0-9]+/g, underscores ? "_" : "-").replace(/^[-_]+|[-_]+$/g, "");
  return underscores ? name.replace(/^[^a-z]+/, "") : name;
}

const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : new Date(ms).toLocaleDateString();
};

function groupOf(path: string): string {
  if (path.startsWith("skills/")) return "Procedures";
  if (path.startsWith("tools/")) return "Tools";
  if (path.startsWith("evals/")) return "Evals";
  if (path.startsWith("widgets/")) return "Widgets";
  return "Agent";
}

const kindOf = (path: string): Kind => (path.startsWith("tools/") ? "tool" : path.startsWith("evals/") ? "eval" : path.startsWith("widgets/") ? "widget" : "skill");

const label = (path: string) => (path.startsWith("skills/") ? path.split("/")[1]! : /^(tools|evals|widgets)\//.test(path) ? path.split("/")[1]! : path);

/** W-09: the selected widget file drawn with its sample data, as the customer would see it. */
function WidgetPreview({ path, text }: { path: string; text: string }) {
  const name = /^widgets\/(.+)\.widget$/.exec(path)?.[1] ?? "widget";
  let root: WidgetNode | null = null;
  let problem: string | null = null;
  try {
    root = previewWidget(name, text);
  } catch (error) {
    problem = (error as Error).message;
  }
  const summary = root ? previewSummary(name, text) : "";
  return (
    <div className="agent-widget-preview">
      <div className="muted small strong">Preview</div>
      {root ? <WidgetCard widget={{ id: "preview", name, root }} interactive={false} desk /> : <p className="muted small">{problem}</p>}
      {summary ? <p className="muted small">Summary: {summary}</p> : null}
    </div>
  );
}

// Files (/agent): the config. Settings (/agent/settings): provider, model, ChatGPT sign-in and the monthly cap.
export function AgentPage({ workspaceId, canEdit, tab }: { workspaceId: string; canEdit: boolean; tab: "files" | "settings" }) {
  return (
    <PageTabs
      title="Agent"
      value={tab}
      className="agent-tabs"
      tabs={[
        { value: "files", label: "Files", path: "/agent", content: <FilesTab workspaceId={workspaceId} canEdit={canEdit} /> },
        {
          value: "settings",
          label: "Settings",
          path: "/agent/settings",
          content: <div className="page-settings settings-sections"><AiPanel workspaceId={workspaceId} canEdit={canEdit} /></div>,
        },
      ]}
    />
  );
}

function FilesTab({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/agent`;
  const [state, setState] = useState<AgentState | null>(null);
  const [draft, setDraft] = useState<Files>({});
  const [selected, setSelected] = useState("AGENTS.md");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [message, setMessage] = useState("");
  const [adding, setAdding] = useState<Kind | null>(null);
  const [lastRemoved, setLastRemoved] = useState<string | null>(null);
  const [newName, setNewName] = useState("");
  const [conflict, setConflict] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const { busy, error, run } = useAction();

  const load = useCallback(async () => {
    const next = await api<AgentState>(base);
    setState(next);
    setDraft(next.files);
    setIssues(next.issues);
    setConflict(null);
    setLastRemoved(null);
    setSelected((s) => (s in next.files ? s : "AGENTS.md"));
  }, [base]);
  useEffect(() => {
    load().catch(() => {});
  }, [load]);

  const dirty = useMemo(() => state !== null && JSON.stringify(draft) !== JSON.stringify(state.files), [draft, state]);

  // Validate as you type (debounced), so errors show before saving.
  useEffect(() => {
    if (!state) return;
    if (!dirty) {
      // Back to the saved files: their (already checked) issues apply again.
      setIssues(state.issues);
      return;
    }
    const timer = setTimeout(() => {
      api<{ issues: Issue[] }>(`${base}/validate`, { body: { files: draft } })
        .then((r) => setIssues(r.issues))
        .catch(() => {});
    }, 400);
    return () => clearTimeout(timer);
  }, [draft, dirty, base, state]);

  if (!state) return <div className="content muted">Loading…</div>;

  const removed = Object.keys(state.files).filter((p) => !(p in draft));
  const paths = [...Object.keys(draft), ...removed].sort((a, b) => (a === "AGENTS.md" ? -1 : b === "AGENTS.md" ? 1 : a.localeCompare(b)));
  const groups = ["Agent", "Procedures", "Tools", "Widgets", "Evals"].map((g) => ({ name: g, paths: paths.filter((p) => groupOf(p) === g) }));
  const issuesFor = (path: string) => issues.filter((i) => i.path === path);
  const status = (p: string): "new" | "edited" | "removed" | null =>
    !(p in draft) ? "removed" : !(p in state.files) ? "new" : draft[p] !== state.files[p] ? "edited" : null;
  const pending = { added: paths.filter((p) => status(p) === "new").length, edited: paths.filter((p) => status(p) === "edited").length, removed: removed.length };

  const save = (force = false) =>
    run(async () => {
      try {
        const result = await api<{ version: number }>(base, { method: "PUT", body: { files: draft, base: state.version, force, message } });
        setMessage("");
        setSaved(result.version);
        setTimeout(() => setSaved(null), 3000);
        await load();
      } catch (e) {
        if (e instanceof ApiError && e.code === "invalid_config") {
          setIssues((e.detail.issues as Issue[]) ?? []);
          throw new Error("Not saved: fix the errors marked below.");
        }
        if (e instanceof ApiError && e.code === "conflict") {
          setConflict(e.message);
          return;
        }
        throw e;
      }
    });

  const newPath = adding ? KINDS[adding].path(slug(adding, newName) || "…") : "";
  const newExists = adding !== null && slug(adding, newName) !== "" && newPath in draft;
  const addFile = () => {
    if (!adding) return;
    const name = slug(adding, newName);
    if (!name || newExists) return;
    const path = KINDS[adding].path(name);
    setDraft({ ...draft, [path]: KINDS[adding].starter(name) });
    setSelected(path);
    setAdding(null);
    setNewName("");
  };

  // Removing only drops the file from the draft: nothing changes for visitors until "Save and go live", and Undo brings it back.
  const removeFile = (path: string) => {
    const next = { ...draft };
    delete next[path];
    setDraft(next);
    setLastRemoved(path in state.files ? path : null);
    if (selected === path) setSelected("AGENTS.md");
  };
  const undoRemove = (path: string) => {
    const original = state.files[path];
    if (original === undefined) return;
    setDraft({ ...draft, [path]: original });
    setSelected(path);
    if (lastRemoved === path) setLastRemoved(null);
  };

  const restore = (version: number) =>
    run(async () => {
      const old = await api<AgentState>(`${base}?version=${version}`);
      setDraft(old.files);
      setSelected("AGENTS.md");
      setMessage(`Restore version ${version}`);
    });

  // Tab inserts spaces (YAML and Markdown lists need them).
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key !== "Tab") return;
    e.preventDefault();
    const t = e.currentTarget;
    const { selectionStart: start, selectionEnd: end, value } = t;
    const next = `${value.slice(0, start)}  ${value.slice(end)}`;
    setDraft({ ...draft, [selected]: next });
    requestAnimationFrame(() => t.setSelectionRange(start + 2, start + 2));
  };

  const live = state.versions[0];
  const otherIssues = issues.filter((i) => !(i.path in draft));

  return (
    <div className="agent-page">
      <ScrollArea render={<aside />} className="agent-files" contentClassName="agent-pane">
        {groups.map((g) => {
          const kind = (Object.keys(KINDS) as Kind[]).find((k) => KINDS[k].group === g.name);
          return (
            <div key={g.name} className="agent-group">
              <div className="agent-group-head">
                <span className="muted small strong">{g.name}</span>
                {canEdit && kind && (
                  <Button variant="ghost" size="sm" className="agent-add-btn" title={`New ${KINDS[kind].one}`} onClick={() => { setAdding(kind); setNewName(""); }}>
                    <PlusIcon /> Add
                  </Button>
                )}
              </div>
              {g.paths.map((p) => {
                const st = status(p);
                if (st === "removed") {
                  return (
                    <div key={p} className="agent-file-removed" title="Removed when you save. Undo to keep it.">
                      <span className="agent-file-name">{label(p)}</span>
                      {canEdit && <Button variant="outline" size="sm" type="button" onClick={() => undoRemove(p)}>Undo</Button>}
                    </div>
                  );
                }
                return (
                  <Button key={p} variant="ghost" size="sm" className={`agent-file ${p === selected ? "active" : ""}`} onClick={() => setSelected(p)}>
                    <span className="agent-file-name">{label(p)}</span>
                    {issuesFor(p).length > 0 && <span className="issue-count" title="Has errors">●</span>}
                    {st && <span className="tag">{st}</span>}
                  </Button>
                );
              })}
              {g.paths.length === 0 && kind && (
                <div className="muted small agent-empty">No {g.name.toLowerCase()} yet. {KINDS[kind].what}</div>
              )}
            </div>
          );
        })}
        <div className="agent-git small">
          <div className="strong">Keep it in git</div>
          <div className="muted">Create a token in <a href="/settings/developer#api-tokens" onClick={(e) => { e.preventDefault(); navigate("/settings/developer#api-tokens"); }}>Settings → Developer → API tokens</a>, then in your Jun Desk checkout:</div>
          <pre>{`npm run jun -- login ${window.location.origin}\nnpm run jun -- pull support-agent\nnpm run jun -- eval support-agent\nnpm run jun -- push support-agent`}</pre>
        </div>
      </ScrollArea>

      <section className="agent-editor">
        <div className="agent-head">
          <code className="strong">{selected}</code>
          {canEdit && selected !== "AGENTS.md" && (
            <Button variant="outline" size="sm" title={`Remove this ${KINDS[kindOf(selected)].one} (not live until you save)`} onClick={() => removeFile(selected)}>
              <TrashIcon /> Remove
            </Button>
          )}
          <span className="spacer" />
          <span className="muted small">
            {live ? `Live: version ${live.version} · ${live.source === "cli" ? "pushed" : "saved"} by ${live.createdBy ?? "someone"} ${ago(live.createdAt)}` : "Live: built-in default (not saved yet)"}
          </span>
        </div>
        {lastRemoved && (
          <p className="agent-notice small">
            <span>Removed <code>{label(lastRemoved)}</code>. It stays live until you save.</span>
            <span className="spacer" />
            <Button variant="outline" size="sm" type="button" onClick={() => undoRemove(lastRemoved)}>Undo</Button>
          </p>
        )}
        <Textarea
          className="agent-text"
          spellCheck={selected.endsWith(".md")}
          value={draft[selected] ?? ""}
          onChange={(e) => setDraft({ ...draft, [selected]: e.target.value })}
          onKeyDown={onKeyDown}
          readOnly={!canEdit}
        />
        {selected.startsWith("widgets/") && draft[selected] !== undefined && <WidgetPreview path={selected} text={draft[selected]} />}
        {issuesFor(selected).length > 0 && (
          <ul className="agent-issues">
            {issuesFor(selected).map((i, n) => <li key={n} className="error small">{i.message}</li>)}
          </ul>
        )}
        {otherIssues.length > 0 && (
          <ul className="agent-issues">
            {otherIssues.map((i, n) => <li key={n} className="error small"><code>{i.path || "config"}</code> {i.message}</li>)}
          </ul>
        )}
        {canEdit && (
          <div className="agent-save">
            <Input value={message} onChange={(e) => setMessage(e.target.value)} placeholder="What changed? (shown in history)" maxLength={500} />
            <Button disabled={busy || !dirty || issues.length > 0} onClick={() => save()}>Save and go live</Button>
            {dirty && <Button variant="outline" disabled={busy} onClick={() => { setDraft(state.files); setIssues(state.issues); setLastRemoved(null); }}>Discard changes</Button>}
            {saved !== null && <span className="muted small">Version {saved} is live ✓</span>}
            {dirty && issues.length > 0 && <span className="error small">Fix the {issues.length === 1 ? "error" : `${issues.length} errors`} above to save.</span>}
            {dirty && issues.length === 0 && (
              <span className="muted small agent-pending">
                Not live yet:
                {pending.added > 0 && <span className="tag">{pending.added} new</span>}
                {pending.edited > 0 && <span className="tag">{pending.edited} edited</span>}
                {pending.removed > 0 && <span className="tag">{pending.removed} removed</span>}
              </span>
            )}
          </div>
        )}
        {conflict && (
          <div className="agent-conflict small">
            <span className="error">{conflict}</span>
            <Button variant="outline" size="sm" onClick={() => load().catch(() => {})}>Load latest (drops your edits)</Button>
            <Button variant="outline" size="sm" onClick={() => save(true)}>Overwrite with mine</Button>
          </div>
        )}
        {error && <p className="error small">{error}</p>}
      </section>

      <ScrollArea render={<aside />} className="agent-history" contentClassName="agent-pane">
        <div className="muted small strong">In this config</div>
        <ul className="agent-summary small">
          <li>{state.summary.skills.length} procedure{state.summary.skills.length === 1 ? "" : "s"}</li>
          <li>{state.summary.tools.length} tool{state.summary.tools.length === 1 ? "" : "s"}</li>
          {state.summary.widgets.length > 0 && <li>{state.summary.widgets.length} widget{state.summary.widgets.length === 1 ? "" : "s"}</li>}
          <li>{state.summary.evals} eval case{state.summary.evals === 1 ? "" : "s"}</li>
          <li>Hands off after {state.summary.maxReplies} AI replies</li>
        </ul>
        <div className="muted small strong">History</div>
        {state.versions.length === 0 && <div className="muted small">No saved versions yet.</div>}
        <ul className="agent-versions">
          {state.versions.map((v) => (
            <li key={v.version} className="small">
              <div className="row">
                <span className="strong">v{v.version}</span>
                <span className="tag">{v.source === "cli" ? "git" : "dashboard"}</span>
                <span className="spacer" />
                {canEdit && v.version !== state.version && <Button variant="outline" size="sm" disabled={busy} onClick={() => restore(v.version)}>Restore</Button>}
              </div>
              <div>{v.message || <span className="muted">No message</span>}</div>
              <div className="muted">{v.createdBy ?? "someone"} · {ago(v.createdAt)}</div>
            </li>
          ))}
        </ul>
      </ScrollArea>

      <Dialog open={adding !== null} onOpenChange={(o) => !o && setAdding(null)}>
        <DialogContent>
          {adding && (
            <form className="agent-dialog-form" onSubmit={(e) => { e.preventDefault(); addFile(); }}>
              <DialogHeader>
                <DialogTitle>New {KINDS[adding].one}</DialogTitle>
                <DialogDescription>{KINDS[adding].what}</DialogDescription>
              </DialogHeader>
              <div className="field">
                <Label htmlFor="agent-new-name">Name</Label>
                <Input id="agent-new-name" autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={`e.g. ${KINDS[adding].placeholder}`} maxLength={60} />
                {newExists ? (
                  <p className="error small hint">A {KINDS[adding].one} called <code>{slug(adding, newName)}</code> already exists.</p>
                ) : (
                  <p className="muted small hint">Creates <code>{newPath}</code> with a starter you can edit. Nothing goes live until you save.</p>
                )}
              </div>
              <DialogFooter>
                <Button type="button" variant="outline" onClick={() => setAdding(null)}>Cancel</Button>
                <Button type="submit" disabled={!slug(adding, newName) || newExists}>Add {KINDS[adding].one}</Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
