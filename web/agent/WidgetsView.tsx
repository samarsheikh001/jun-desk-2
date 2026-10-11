import { useEffect, useRef, useState } from "react";
import { readYaml } from "../lib/agentFiles.ts";
import { useThemePref } from "../lib/theme.ts";
import { previewSummary, previewWidget, starterWidget, type WidgetNode } from "../../shared/widgets.ts";
import { WidgetCard } from "../widget/chatkit/WidgetCard.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { ChevronLeftIcon, CodeIcon, ExternalLinkIcon, InfoIcon, MoonIcon, PlusIcon, SearchIcon, SparkleIcon, SunIcon, TrashIcon, UploadIcon } from "../components/icons.tsx";
import { formatTemplate } from "../../shared/widget-ai.ts";
import { CodeArea } from "./CodeArea.tsx";
import { WidgetChat } from "./WidgetChat.tsx";
import { AddDialog, CodeEditor, Problems, TOOL, WIDGET, changeOf, go, humanize, slug, useCodeView } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// /agent/widgets[/<name>]: widgets/<name>.widget (W-09). Widgets are designed in ChatKit Studio, so
// this page shows them rather than building them (after Chatbase's Widgets page): /agent/widgets is a
// gallery of live previews; a widget's page is its details (or, in Code, its file) beside a large
// preview canvas with a light / dark switch, which follows what you type.

type Theme = "light" | "dark";

interface WidgetItem {
  name: string;
  path: string;
}

function widgetsOf(cfg: AgentConfig): WidgetItem[] {
  return Object.keys(cfg.draft)
    .map((path) => ({ path, name: WIDGET.exec(path)?.[1] }))
    .filter((x): x is WidgetItem => Boolean(x.name))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The actions (tools/*.yaml) that show this widget. */
function usedBy(cfg: AgentConfig, name: string): string[] {
  return Object.keys(cfg.draft)
    .filter((p) => TOOL.test(p))
    .filter((p) => (readYaml(cfg.draft[p]!) as { widget?: unknown } | null)?.widget === name)
    .map((p) => TOOL.exec(p)![1]!);
}

function render(name: string, text: string): { root: WidgetNode | null; problem: string | null } {
  try {
    return { root: previewWidget(name, text), problem: null };
  } catch (error) {
    return { root: null, problem: (error as Error).message };
  }
}

/** A free name for an uploaded file: its own, else with _2, _3… */
function freeName(cfg: AgentConfig, raw: string): string {
  const base = slug(raw.replace(/\.(widget|json)$/i, ""), "_") || "widget";
  let name = base;
  for (let n = 2; `widgets/${name}.widget` in cfg.draft; n++) name = `${base}_${n}`;
  return name;
}

export function WidgetsView({ cfg, canEdit, selected }: { cfg: AgentConfig; canEdit: boolean; selected: string | null }) {
  const items = widgetsOf(cfg);
  const current = items.find((i) => i.name === selected);
  // A widget that's gone (discarded, removed, another version): back to the gallery.
  const gone = selected !== null && !current && cfg.state !== null;
  useEffect(() => {
    if (gone) go("/agent/widgets");
  }, [gone]);
  if (current) return <WidgetEditor key={current.path} cfg={cfg} canEdit={canEdit} path={current.path} name={current.name} />;
  return <WidgetGallery cfg={cfg} canEdit={canEdit} items={items} />;
}

function WidgetGallery({ cfg, canEdit, items }: { cfg: AgentConfig; canEdit: boolean; items: WidgetItem[] }) {
  const [adding, setAdding] = useState(false);
  const [query, setQuery] = useState("");
  const upload = useRef<HTMLInputElement>(null);
  useThemePref(); // the tiles follow the dashboard's light / dark
  const q = query.trim().toLowerCase();
  const shown = q ? items.filter((i) => humanize(i.name).toLowerCase().includes(q) || i.name.includes(q)) : items;

  return (
    <div className="agent-gallery">
      <div className="agent-gallery-bar">
        <div className="agent-gallery-search">
          <SearchIcon />
          <Input type="search" placeholder="Search widgets…" aria-label="Search widgets" value={query} onChange={(e) => setQuery(e.target.value)} />
        </div>
        <span className="spacer" />
        {canEdit && (
          <>
            <Button variant="outline" size="icon" title="Upload a file from ChatKit Studio" aria-label="Upload a .widget file" onClick={() => upload.current?.click()}>
              <UploadIcon />
            </Button>
            <Button onClick={() => setAdding(true)}>
              <PlusIcon /> New widget
            </Button>
            <input
              ref={upload}
              type="file"
              accept=".widget,application/json"
              hidden
              onChange={async (e) => {
                const file = e.target.files?.[0];
                e.target.value = "";
                if (!file) return;
                const name = freeName(cfg, file.name);
                cfg.setFile(`widgets/${name}.widget`, await file.text());
                go(`/agent/widgets/${name}`);
              }}
            />
          </>
        )}
      </div>

      {items.length === 0 ? (
        <div className="agent-gallery-empty">
          <h2>Show results as widgets</h2>
          <p>A widget shows an action's result to the customer as a neat card, like an order's status or their plan, instead of text.</p>
          {canEdit && (
            <Button onClick={() => setAdding(true)}>
              <PlusIcon /> New widget
            </Button>
          )}
        </div>
      ) : shown.length === 0 ? (
        <p className="muted small agent-gallery-none">No widget matches "{query}".</p>
      ) : (
        <ul className="agent-gallery-grid">
          {shown.map((item) => (
            <WidgetTile key={item.path} cfg={cfg} item={item} />
          ))}
        </ul>
      )}

      <AddDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="New widget"
        description="Starts from a simple widget. Design your own in ChatKit Studio and upload the file it downloads."
        placeholder="e.g. Order status"
        exists={(raw) => {
          const name = slug(raw, "_");
          if (!name) return "Start with a letter.";
          return `widgets/${name}.widget` in cfg.draft ? "There's already a widget with this name." : null;
        }}
        onAdd={(raw) => {
          const name = slug(raw, "_");
          cfg.setFile(`widgets/${name}.widget`, starterWidget(humanize(name)));
          setAdding(false);
          go(`/agent/widgets/${name}`);
        }}
      />
    </div>
  );
}

/** One widget in the gallery: its live preview (not clickable itself) and a link over the whole tile. */
function WidgetTile({ cfg, item }: { cfg: AgentConfig; item: WidgetItem }) {
  const { root, problem } = render(item.name, cfg.draft[item.path] ?? "");
  const tools = usedBy(cfg, item.name);
  const change = changeOf(cfg, item.path);
  const problems = cfg.issuesFor(item.path).length;
  const href = `/agent/widgets/${item.name}`;
  return (
    <li className="agent-tile">
      <div className="agent-stage agent-tile-stage" aria-hidden="true" inert>
        <div className="agent-stage-card">
          {root ? <WidgetCard widget={{ id: `tile-${item.name}`, name: item.name, root }} interactive={false} theme={pageTheme()} /> : <p className="error small">{problem}</p>}
        </div>
      </div>
      <div className="agent-tile-text">
        <a className="agent-tile-link" href={href} onClick={(e) => { e.preventDefault(); go(href); }}>
          {humanize(item.name)}
        </a>
        {problems > 0 && <Badge variant="destructive">{problems === 1 ? "1 problem" : `${problems} problems`}</Badge>}
        {change && <Badge variant="secondary">{change}</Badge>}
        <span className="agent-tile-sub">{tools.length ? `Shown by ${tools.map(humanize).join(", ")}` : "Not used by an action yet"}</span>
      </div>
    </li>
  );
}

const pageTheme = (): Theme => (document.documentElement.dataset.theme === "dark" ? "dark" : "light");

type Pane = "ai" | "code" | "details";
// The left column's tab, for this visit (the same tab as you move between widgets).
let lastPane: Pane | null = null;

/** The .widget file as an object, or null when it isn't a JSON object. */
function readFile(text: string): Record<string, unknown> | null {
  try {
    const file = JSON.parse(text) as unknown;
    return typeof file === "object" && file !== null && !Array.isArray(file) ? (file as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** The file with one key set (or removed with undefined); other keys keep their order. */
function withKey(text: string, key: string, value: unknown): string {
  const file = readFile(text) ?? {};
  if (value === undefined) delete file[key];
  else file[key] = value;
  return `${JSON.stringify(file, null, 2)}\n`;
}

function WidgetEditor({ cfg, canEdit, path, name }: { cfg: AgentConfig; canEdit: boolean; path: string; name: string }) {
  const text = cfg.draft[path] ?? "";
  const code = useCodeView();
  const [pane, setPaneState] = useState<Pane>(() => lastPane ?? (code ? "code" : canEdit ? "ai" : "details"));
  const setPane = (next: Pane) => {
    lastPane = next;
    setPaneState(next);
  };
  const [theme, setTheme] = useState<Theme>(pageTheme);
  const { root, problem } = render(name, text);
  const change = changeOf(cfg, path);
  const panes: { id: Pane; label: string }[] = [
    ...(canEdit ? [{ id: "ai" as const, label: "AI" }] : []),
    { id: "code", label: "Code" },
    { id: "details", label: "Details" },
  ];
  const shown = panes.some((p) => p.id === pane) ? pane : "details";

  return (
    <div className="agent-wed agent-wed-studio">
      <section className="agent-wed-side">
        <div className="agent-wed-head">
          <Button variant="ghost" size="icon-sm" aria-label="All widgets" title="All widgets" onClick={() => go("/agent/widgets")}>
            <ChevronLeftIcon />
          </Button>
          <h2>{humanize(name)}</h2>
          {change && <Badge variant="secondary">{change}</Badge>}
          <span className="spacer" />
          {canEdit && (
            <Button variant="ghost" size="icon-sm" aria-label="Remove widget" title="Removed when you save" onClick={() => { cfg.setFile(path, undefined); go("/agent/widgets"); }}>
              <TrashIcon />
            </Button>
          )}
        </div>
        <div className="agent-wed-tabs" role="tablist" aria-label="Edit with">
          {panes.map((p) => (
            <button key={p.id} type="button" role="tab" aria-selected={shown === p.id} className="agent-wed-tab" onClick={() => setPane(p.id)}>
              {p.id === "ai" ? <SparkleIcon /> : p.id === "code" ? <CodeIcon /> : <InfoIcon />}
              {p.label}
            </button>
          ))}
        </div>
        <div className="agent-wed-pane" role="tabpanel">
          {shown === "ai" ? (
            <WidgetChat cfg={cfg} path={path} name={name} />
          ) : shown === "code" ? (
            <WidgetCode cfg={cfg} path={path} canEdit={canEdit} />
          ) : (
            <WidgetDetails cfg={cfg} path={path} name={name} canEdit={canEdit} />
          )}
        </div>
      </section>

      <section className="agent-stage agent-wed-canvas" data-preview={theme} aria-label="Preview">
        <div className="agent-canvas-tools" role="group" aria-label="Preview theme">
          <Button variant="ghost" size="icon-sm" aria-label="Light" aria-pressed={theme === "light"} onClick={() => setTheme("light")}>
            <SunIcon />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Dark" aria-pressed={theme === "dark"} onClick={() => setTheme("dark")}>
            <MoonIcon />
          </Button>
        </div>
        <div className="agent-stage-card">
          {root ? <WidgetCard widget={{ id: "preview", name, root }} interactive={false} theme={theme} /> : <p className="agent-canvas-error">{problem}</p>}
        </div>
        <p className="agent-canvas-caption">With example data, as a customer sees it</p>
      </section>
    </div>
  );
}

/** Code: the template (indented) over the example data and the summary line, like ChatKit Studio. */
function WidgetCode({ cfg, path, canEdit }: { cfg: AgentConfig; path: string; canEdit: boolean }) {
  const text = cfg.draft[path] ?? "";
  const file = readFile(text);
  const template = typeof file?.template === "string" ? file.template : "";
  const sampleJson = file?.sample === undefined ? "{\n}" : JSON.stringify(file.sample, null, 2);
  const summary = typeof file?.summary === "string" ? file.summary : "";
  const [bottom, setBottom] = useState<"sample" | "summary" | "file">("sample");

  // What the fields show: kept while you type, replaced when the file changes elsewhere (the AI, Undo, Discard).
  const [tpl, setTpl] = useState(() => formatTemplate(template));
  const wroteTpl = useRef(template);
  const [sample, setSample] = useState(sampleJson);
  const wroteSample = useRef(sampleJson);
  const [sampleError, setSampleError] = useState<string | null>(null);
  useEffect(() => {
    if (template !== wroteTpl.current) {
      wroteTpl.current = template;
      setTpl(formatTemplate(template));
    }
  }, [template]);
  useEffect(() => {
    if (sampleJson !== wroteSample.current) {
      wroteSample.current = sampleJson;
      setSample(sampleJson);
      setSampleError(null);
    }
  }, [sampleJson]);

  if (!file) {
    return (
      <div className="agent-wed-raw">
        <p className="agent-notice small">This file isn't valid JSON, so it's shown whole. Fix it here and the editor comes back.</p>
        <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
      </div>
    );
  }
  return (
    <div className="wcode">
      <div className="wcode-top">
        <div className="wcode-label">Template</div>
        <CodeArea
          label="Template"
          value={tpl}
          readOnly={!canEdit}
          onChange={(next) => {
            setTpl(next);
            wroteTpl.current = next;
            cfg.setFile(path, withKey(text, "template", next));
          }}
        />
      </div>
      <div className="wcode-bottom">
        <div className="wcode-tabs" role="tablist" aria-label="Data">
          <button type="button" role="tab" aria-selected={bottom === "sample"} onClick={() => setBottom("sample")}>Example data</button>
          <button type="button" role="tab" aria-selected={bottom === "summary"} onClick={() => setBottom("summary")}>Summary</button>
          <button type="button" role="tab" aria-selected={bottom === "file"} onClick={() => setBottom("file")}>Whole file</button>
        </div>
        {bottom === "sample" ? (
          <>
            <CodeArea
              label="Example data"
              value={sample}
              readOnly={!canEdit}
              onChange={(next) => {
                setSample(next);
                try {
                  const value = JSON.parse(next) as unknown;
                  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Example data is a JSON object: { … }.");
                  setSampleError(null);
                  wroteSample.current = JSON.stringify(value, null, 2);
                  cfg.setFile(path, withKey(text, "sample", value));
                } catch (error) {
                  setSampleError(error instanceof SyntaxError ? "Not valid JSON yet." : (error as Error).message);
                }
              }}
            />
            <p className={sampleError ? "wcode-hint error" : "wcode-hint"}>{sampleError ?? "Data shaped like your action's response; the preview uses it."}</p>
          </>
        ) : bottom === "summary" ? (
          <div className="wcode-summary">
            <Input
              aria-label="Summary line"
              className="mono"
              value={summary}
              readOnly={!canEdit}
              maxLength={200}
              placeholder="e.g. {{ plan }} plan · {{ status }}"
              onChange={(e) => cfg.setFile(path, withKey(text, "summary", e.target.value || undefined))}
            />
            <p className="wcode-hint">One plain-text line from the same data. The chat shows it when it folds the card away.</p>
          </div>
        ) : (
          <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
        )}
      </div>
      <Problems issues={cfg.issuesFor(path)} raw />
    </div>
  );
}

/** Details: which actions show it, its folded line, ChatKit Studio and uploading a file. */
function WidgetDetails({ cfg, path, name, canEdit }: { cfg: AgentConfig; path: string; name: string; canEdit: boolean }) {
  const text = cfg.draft[path] ?? "";
  const upload = useRef<HTMLInputElement>(null);
  const summary = previewSummary(name, text);
  const tools = usedBy(cfg, name);
  return (
    <div className="agent-wed-details">
      <div className="agent-wed-group">
        <h3>Shown by</h3>
        {tools.length ? (
          <ul className="agent-wed-links">
            {tools.map((tool) => (
              <li key={tool}>
                <a href={`/agent/actions/${tool}`} onClick={(e) => { e.preventDefault(); go(`/agent/actions/${tool}`); }}>{humanize(tool)}</a>
              </li>
            ))}
          </ul>
        ) : (
          <p>Not used yet. Pick it under "Show the result as a widget" on an action.</p>
        )}
      </div>
      {summary && (
        <div className="agent-wed-group">
          <h3>Folded</h3>
          <p>When the chat folds the card away, it reads "{summary}".</p>
        </div>
      )}
      <div className="agent-wed-group">
        <h3>ChatKit Studio</h3>
        <p>You can also design a widget in ChatKit Studio, download the file and upload it here.</p>
        <div className="agent-wed-actions">
          <Button variant="outline" size="sm" nativeButton={false} render={<a href="https://widgets.chatkit.studio" target="_blank" rel="noopener noreferrer" />}>
            <ExternalLinkIcon /> Open ChatKit Studio
          </Button>
          {canEdit && (
            <Button variant="outline" size="sm" onClick={() => upload.current?.click()}>
              <UploadIcon /> Replace with a file
            </Button>
          )}
        </div>
        <input
          ref={upload}
          type="file"
          accept=".widget,application/json"
          hidden
          onChange={async (e) => {
            const file = e.target.files?.[0];
            e.target.value = "";
            if (file) cfg.setFile(path, await file.text());
          }}
        />
      </div>
      <Problems issues={cfg.issuesFor(path)} />
    </div>
  );
}
