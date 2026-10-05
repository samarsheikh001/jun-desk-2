import { useCallback, useEffect, useMemo, useState, type KeyboardEvent } from "react";
import { api, ApiError } from "../api.ts";
import { navigate } from "../lib/router.ts";
import { useAction } from "../useAction.ts";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";

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
  summary: { skills: string[]; tools: string[]; evals: number; maxReplies: number; handoffTopics: string[] };
  versions: Version[];
}

const NEW_FILES = {
  skill: (name: string) => ({
    path: `skills/${name}/SKILL.md`,
    text: `---\nname: ${name}\ndescription: When this procedure applies, e.g. "The customer asks to change their plan."\n---\n1. First step.\n2. Second step.\n3. When to hand off to a person.\n`,
  }),
  tool: (name: string) => ({
    path: `tools/${name}.yaml`,
    text: `description: What this returns and when the AI should use it.\nmethod: GET\nurl: https://api.example.com/things/{id}\nheaders:\n  Authorization: Bearer {secrets.API_KEY}   # Worker secret JUN_SECRET_API_KEY\ninput:\n  id:\n    type: string\n    description: What the AI should pass\n`,
  }),
  eval: (name: string) => ({
    path: `evals/${name}.yaml`,
    text: `- name: example\n  message: A customer message\n  expect:\n    outcome: answer        # answer | handoff | escalate\n    criteria: What a good reply does\n`,
  }),
};

const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : new Date(ms).toLocaleDateString();
};

function groupOf(path: string): string {
  if (path.startsWith("skills/")) return "Procedures";
  if (path.startsWith("tools/")) return "Tools";
  if (path.startsWith("evals/")) return "Evals";
  return "Agent";
}

const label = (path: string) => (path.startsWith("skills/") ? path.split("/")[1]! : path.startsWith("tools/") || path.startsWith("evals/") ? path.split("/")[1]! : path);

export function AgentPage({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const base = `/workspaces/${workspaceId}/agent`;
  const [state, setState] = useState<AgentState | null>(null);
  const [draft, setDraft] = useState<Files>({});
  const [selected, setSelected] = useState("AGENTS.md");
  const [issues, setIssues] = useState<Issue[]>([]);
  const [message, setMessage] = useState("");
  const [adding, setAdding] = useState<keyof typeof NEW_FILES | null>(null);
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

  const paths = Object.keys(draft).sort((a, b) => (a === "AGENTS.md" ? -1 : b === "AGENTS.md" ? 1 : a.localeCompare(b)));
  const groups = ["Agent", "Procedures", "Tools", "Evals"].map((g) => ({ name: g, paths: paths.filter((p) => groupOf(p) === g) }));
  const issuesFor = (path: string) => issues.filter((i) => i.path === path);

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

  const addFile = () => {
    const name = newName.trim().toLowerCase().replace(/[^a-z0-9]+/g, adding === "tool" ? "_" : "-").replace(/^[-_]+|[-_]+$/g, "");
    if (!adding || !name) return;
    const file = NEW_FILES[adding](adding === "tool" ? name.replace(/^[^a-z]+/, "") || "lookup" : name);
    if (!(file.path in draft)) setDraft({ ...draft, [file.path]: file.text });
    setSelected(file.path);
    setAdding(null);
    setNewName("");
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
      <aside className="agent-files">
        {groups.map((g) => (
          <div key={g.name} className="agent-group">
            <div className="agent-group-head">
              <span className="muted small strong">{g.name}</span>
              {canEdit && g.name !== "Agent" && (
                <Button variant="outline" size="sm" title={`New ${g.name === "Procedures" ? "procedure" : g.name === "Tools" ? "tool" : "eval file"}`} onClick={() => { setAdding(g.name === "Procedures" ? "skill" : g.name === "Tools" ? "tool" : "eval"); setNewName(""); }}>
                  +
                </Button>
              )}
            </div>
            {g.paths.map((p) => (
              <Button key={p} variant="ghost" size="sm" className={`agent-file ${p === selected ? "active" : ""}`} onClick={() => setSelected(p)}>
                <span>{label(p)}</span>
                {issuesFor(p).length > 0 && <span className="issue-count">●</span>}
                {draft[p] !== state.files[p] && <span className="muted small">edited</span>}
              </Button>
            ))}
            {g.paths.length === 0 && <div className="muted small agent-empty">None yet</div>}
          </div>
        ))}
        {adding && (
          <form className="agent-add" onSubmit={(e) => { e.preventDefault(); addFile(); }}>
            <Input autoFocus value={newName} onChange={(e) => setNewName(e.target.value)} placeholder={adding === "skill" ? "e.g. change-plan" : adding === "tool" ? "e.g. lookup_order" : "e.g. billing"} />
            <div className="row">
              <Button size="sm">Add</Button>
              <Button variant="outline" size="sm" type="button" onClick={() => setAdding(null)}>Cancel</Button>
            </div>
          </form>
        )}
        <div className="agent-git small">
          <div className="strong">Keep it in git</div>
          <div className="muted">Create a token in <a href="/settings" onClick={(e) => { e.preventDefault(); navigate("/settings"); }}>Settings → API tokens</a>, then in your Jun Desk checkout:</div>
          <pre>{`npm run jun -- login ${window.location.origin}\nnpm run jun -- pull support-agent\nnpm run jun -- eval support-agent\nnpm run jun -- push support-agent`}</pre>
        </div>
      </aside>

      <section className="agent-editor">
        <div className="agent-head">
          <code className="strong">{selected}</code>
          {canEdit && selected !== "AGENTS.md" && (
            <Button variant="outline" size="sm" onClick={() => { const next = { ...draft }; delete next[selected]; setDraft(next); setSelected("AGENTS.md"); }}>Delete file</Button>
          )}
          <span className="spacer" />
          <span className="muted small">
            {live ? `Live: version ${live.version} · ${live.source === "cli" ? "pushed" : "saved"} by ${live.createdBy ?? "someone"} ${ago(live.createdAt)}` : "Live: built-in default (not saved yet)"}
          </span>
        </div>
        <Textarea
          className="agent-text"
          spellCheck={selected.endsWith(".md")}
          value={draft[selected] ?? ""}
          onChange={(e) => setDraft({ ...draft, [selected]: e.target.value })}
          onKeyDown={onKeyDown}
          readOnly={!canEdit}
        />
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
            {dirty && <Button variant="outline" disabled={busy} onClick={() => { setDraft(state.files); setIssues(state.issues); }}>Discard</Button>}
            {saved !== null && <span className="muted small">Version {saved} is live ✓</span>}
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

      <aside className="agent-history">
        <div className="muted small strong">In this config</div>
        <ul className="agent-summary small">
          <li>{state.summary.skills.length} procedure{state.summary.skills.length === 1 ? "" : "s"}</li>
          <li>{state.summary.tools.length} tool{state.summary.tools.length === 1 ? "" : "s"}</li>
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
      </aside>
    </div>
  );
}
