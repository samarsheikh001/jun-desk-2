import { useEffect, useRef, useState } from "react";
import { readYaml } from "../lib/agentFiles.ts";
import { useThemePref } from "../lib/theme.ts";
import { previewSummary, previewWidget, starterWidget, type WidgetNode } from "../../shared/widgets.ts";
import { WidgetCard } from "../widget/chatkit/WidgetCard.tsx";
import { Button } from "@/components/ui/button.tsx";
import { Input } from "@/components/ui/input.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { ChevronLeftIcon, ExternalLinkIcon, MoonIcon, PlusIcon, SearchIcon, SunIcon, TrashIcon, UploadIcon } from "../components/icons.tsx";
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

function WidgetEditor({ cfg, canEdit, path, name }: { cfg: AgentConfig; canEdit: boolean; path: string; name: string }) {
  const text = cfg.draft[path] ?? "";
  const upload = useRef<HTMLInputElement>(null);
  const code = useCodeView();
  const [theme, setTheme] = useState<Theme>(pageTheme);
  const { root, problem } = render(name, text);
  const summary = root ? previewSummary(name, text) : "";
  const tools = usedBy(cfg, name);
  const change = changeOf(cfg, path);

  return (
    <div className={`agent-wed${code ? " agent-wed-code" : ""}`}>
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

        {code ? (
          <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
        ) : (
          <>
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
              <h3>Design</h3>
              <p>Widgets are designed in ChatKit Studio. Download the file there and upload it here; the preview shows it with example data.</p>
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
          </>
        )}
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
          {root ? <WidgetCard widget={{ id: "preview", name, root }} interactive={false} theme={theme} /> : <p className="error small">{problem}</p>}
        </div>
        <p className="agent-canvas-caption">With example data, as a customer sees it</p>
      </section>
    </div>
  );
}
