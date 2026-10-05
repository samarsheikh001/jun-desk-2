import { useEffect, useRef, useState } from "react";
import { api } from "../api.ts";
import { useAction } from "../useAction.ts";

export interface LinearTeam {
  id: string;
  key: string;
  name: string;
}

/** Non-secret status from GET /workspaces/:id/trackers. Credentials are Worker secrets; this only says whether they're set. */
export interface TrackerStatus {
  github: { repo: string | null; tokenSet: boolean; configured: boolean; apiUrl?: string };
  linear: { team: LinearTeam | null; keySet: boolean; configured: boolean; apiUrl?: string };
}

interface TestResult {
  ok: boolean;
  reason: string;
  message: string;
  teams?: LinearTeam[];
}

/** S-08: where "Create issue" files issues (GitHub, Linear, or both). */
export function IssueTrackersPanel({ workspaceId, canEdit }: { workspaceId: string; canEdit: boolean }) {
  const [status, setStatus] = useState<TrackerStatus | null>(null);
  const ref = useRef<HTMLElement>(null);
  useEffect(() => {
    api<TrackerStatus>(`/workspaces/${workspaceId}/trackers`).then(setStatus, () => {});
  }, [workspaceId]);
  // Linked from the inbox's "Create issue" hint.
  useEffect(() => {
    if (status && window.location.hash === "#issue-trackers") ref.current?.scrollIntoView({ block: "start" });
  }, [status]);
  if (!status) return null;

  return (
    <section className="panel trackers-panel" id="issue-trackers" ref={ref}>
      <h2>Issue trackers</h2>
      <p className="muted small">
        Agents can turn a conversation into a GitHub or Linear issue: the AI drafts the title, steps to reproduce, failing requests and browser details, the agent edits
        it and files it, and the conversation keeps the link. The AI never files issues on its own. Issue text is masked again (emails, tokens, card numbers) before it's
        sent, and credentials stay Worker secrets: they aren't stored in the database or shown here.
      </p>
      <GitHubSection workspaceId={workspaceId} status={status} canEdit={canEdit} onChange={setStatus} />
      <LinearSection workspaceId={workspaceId} status={status} canEdit={canEdit} onChange={setStatus} />
      {!canEdit && <p className="muted small">An owner or admin can change these.</p>}
    </section>
  );
}

function SecretState({ name, set }: { name: string; set: boolean }) {
  return set ? <span className="ok-text">✓ <code>{name}</code> is set</span> : <span className="error"><code>{name}</code> isn't set</span>;
}

function SecretStep({ name }: { name: string }) {
  return (
    <li>
      Add it to this Worker as the secret <code>{name}</code>: run <code>npx wrangler secret put {name}</code> in your Jun Desk checkout (it asks for the value), or in the
      Cloudflare dashboard go to your Worker → Settings → Variables and Secrets → Add → Secret. For local development, put it in <code>.dev.vars</code>.
    </li>
  );
}

type SectionProps = { workspaceId: string; status: TrackerStatus; canEdit: boolean; onChange: (s: TrackerStatus) => void };

function GitHubSection({ workspaceId, status, canEdit, onChange }: SectionProps) {
  const base = `/workspaces/${workspaceId}/github`;
  const { github } = status;
  const [repo, setRepo] = useState(github.repo ?? "");
  const [test, setTest] = useState<TestResult | null>(null);
  const { busy, error, run } = useAction();
  const save = () =>
    run(async () => {
      setTest(null);
      const next = await api<TrackerStatus>(base, { method: "PUT", body: { repo: repo.trim() || null } });
      onChange(next);
      setRepo(next.github.repo ?? "");
    });

  return (
    <div className="tracker" id="github">
      <div className="row">
        <h3>GitHub</h3>
        <span className="spacer" />
        <span className={`tag ${github.configured ? "" : "tag-warn"}`}>{github.configured ? "Connected" : "Not set up"}</span>
      </div>
      <dl className="env small">
        <dt>Token</dt>
        <dd><SecretState name="GITHUB_TOKEN" set={github.tokenSet} /></dd>
        <dt>Repository</dt>
        <dd>{github.repo ? <code>{github.repo}</code> : <span className="muted">not set</span>}</dd>
        {github.apiUrl && (<><dt>API</dt><dd><code>{github.apiUrl}</code></dd></>)}
      </dl>
      {canEdit && (
        <>
          <div className="field">
            <span className="small strong">Repository</span>
            <div className="row tracker-row">
              <input value={repo} onChange={(e) => setRepo(e.target.value)} placeholder="owner/name, e.g. acme/web-app" aria-label="GitHub repository" spellCheck={false} />
              <button className="small" disabled={busy || repo.trim() === (github.repo ?? "")} onClick={save}>Save</button>
              <button className="ghost small" disabled={busy || !github.repo} onClick={() => run(async () => setTest(await api<TestResult>(`${base}/test`, { body: {} })))}>Test connection</button>
            </div>
          </div>
          {test && <p className={`small ${test.ok ? "ok-text" : "error"}`} role="status">{test.ok ? "✓ " : ""}{test.message}</p>}
          {error && <p className="error small">{error}</p>}
          <details className="small tracker-help" open={!github.configured}>
            <summary>How to connect GitHub</summary>
            <ol>
              <li>
                On GitHub, create a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noreferrer">fine-grained personal access token</a>: Repository access → <em>Only select repositories</em> → this repository; Permissions → <em>Issues: Read and write</em>.
              </li>
              <SecretStep name="GITHUB_TOKEN" />
              <li>Save the repository above, then Test connection.</li>
            </ol>
          </details>
        </>
      )}
    </div>
  );
}

function LinearSection({ workspaceId, status, canEdit, onChange }: SectionProps) {
  const base = `/workspaces/${workspaceId}/linear`;
  const { linear } = status;
  const [teams, setTeams] = useState<LinearTeam[]>([]);
  const [test, setTest] = useState<TestResult | null>(null);
  const { busy, error, run } = useAction();
  const testConnection = () =>
    run(async () => {
      const result = await api<TestResult>(`${base}/test`, { body: {} });
      setTest(result);
      setTeams(result.teams ?? []);
    });
  const choose = (id: string) =>
    run(async () => {
      const team = id ? teams.find((t) => t.id === id) ?? null : null;
      onChange(await api<TrackerStatus>(base, { method: "PUT", body: { team } }));
    });
  // The saved team stays selectable before the list is loaded.
  const options = linear.team && !teams.some((t) => t.id === linear.team!.id) ? [linear.team, ...teams] : teams;

  return (
    <div className="tracker" id="linear">
      <div className="row">
        <h3>Linear</h3>
        <span className="spacer" />
        <span className={`tag ${linear.configured ? "" : "tag-warn"}`}>{linear.configured ? "Connected" : "Not set up"}</span>
      </div>
      <dl className="env small">
        <dt>API key</dt>
        <dd><SecretState name="LINEAR_API_KEY" set={linear.keySet} /></dd>
        <dt>Team</dt>
        <dd>{linear.team ? <>{linear.team.name} <code>{linear.team.key}</code></> : <span className="muted">not set</span>}</dd>
        {linear.apiUrl && (<><dt>API</dt><dd><code>{linear.apiUrl}</code></dd></>)}
      </dl>
      {canEdit && (
        <>
          <div className="field">
            <span className="small strong">Team</span>
            <div className="row tracker-row">
              <select value={linear.team?.id ?? ""} disabled={busy || options.length === 0} onChange={(e) => choose(e.target.value)} aria-label="Linear team">
                <option value="">{options.length ? "No team (Linear off)" : "Test connection to load teams"}</option>
                {options.map((t) => (
                  <option key={t.id} value={t.id}>{t.name} ({t.key})</option>
                ))}
              </select>
              <button className="ghost small" disabled={busy || !linear.keySet} onClick={testConnection}>Test connection</button>
            </div>
          </div>
          {test && <p className={`small ${test.ok ? "ok-text" : "error"}`} role="status">{test.ok ? "✓ " : ""}{test.message}</p>}
          {error && <p className="error small">{error}</p>}
          <details className="small tracker-help" open={!linear.configured}>
            <summary>How to connect Linear</summary>
            <ol>
              <li>In Linear, go to Settings → Security &amp; access → Personal API keys and create a key (one that can create issues in the team you want).</li>
              <SecretStep name="LINEAR_API_KEY" />
              <li>Test connection, then pick the team new issues go to.</li>
            </ol>
          </details>
        </>
      )}
    </div>
  );
}
