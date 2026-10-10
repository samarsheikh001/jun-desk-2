import { useRef, useState } from "react";
import { readYaml } from "../lib/agentFiles.ts";
import { previewSummary, previewWidget, starterWidget, type WidgetNode } from "../../shared/widgets.ts";
import { WidgetCard } from "../widget/chatkit/WidgetCard.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ExternalLinkIcon, UploadIcon } from "../components/icons.tsx";
import { AddDialog, CodeEditor, ItemHead, ItemList, Problems, TOOL, WIDGET, go, humanize, slug, useCodeView } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// /agent/widgets[/<name>]: widgets/<name>.widget (W-09). Widgets are designed in ChatKit Studio, so this
// view shows each one as the customer sees it, which actions use it, and takes a downloaded file;
// in Code, the file sits over the live preview, which follows what you type.

export function WidgetsView({ cfg, canEdit, selected }: { cfg: AgentConfig; canEdit: boolean; selected: string | null }) {
  const [adding, setAdding] = useState(false);
  const items = Object.keys(cfg.draft)
    .map((path) => ({ path, name: WIDGET.exec(path)?.[1] }))
    .filter((x): x is { path: string; name: string } => Boolean(x.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ path, name }) => ({ id: name, path, label: humanize(name) }));
  const current = items.find((i) => i.id === selected) ?? items[0] ?? null;

  return (
    <div className="agent-split" data-picked={selected !== null && current?.id === selected ? "" : undefined}>
      <ItemList
        cfg={cfg}
        items={items}
        selected={current?.id ?? null}
        onSelect={(id) => go(`/agent/widgets/${id}`)}
        onAdd={() => setAdding(true)}
        addLabel="New widget"
        canEdit={canEdit}
        empty="No widgets yet. A widget shows an action's result to the customer, like an order's status or their plan."
      />
      {current ? (
        <WidgetForm key={current.path} cfg={cfg} canEdit={canEdit} path={current.path} name={current.id} />
      ) : (
        <div className="agent-form agent-blank muted">Add a widget to show an action's result as a neat summary instead of text.</div>
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

function WidgetForm({ cfg, canEdit, path, name }: { cfg: AgentConfig; canEdit: boolean; path: string; name: string }) {
  const text = cfg.draft[path] ?? "";
  const upload = useRef<HTMLInputElement>(null);
  const code = useCodeView();
  let root: WidgetNode | null = null;
  let problem: string | null = null;
  try {
    root = previewWidget(name, text);
  } catch (error) {
    problem = (error as Error).message;
  }
  const summary = root ? previewSummary(name, text) : "";
  const usedBy = Object.keys(cfg.draft)
    .filter((p) => TOOL.test(p))
    .filter((p) => {
      const data = readYaml(cfg.draft[p]!) as { widget?: unknown } | null;
      return data?.widget === name;
    })
    .map((p) => TOOL.exec(p)![1]!);

  return (
    <section className={code ? "agent-form agent-code" : "agent-form"}>
      <ItemHead back={{ path: "/agent/widgets", label: "All widgets" }} title={humanize(name)} canEdit={canEdit} onRemove={() => { cfg.setFile(path, undefined); go("/agent/widgets"); }} />
      {code && <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />}
      <div className="agent-widget-preview">
        {root ? <WidgetCard widget={{ id: "preview", name, root }} interactive={false} desk /> : <p className="error small">{problem}</p>}
      </div>
      <p className="muted small">With example data, as a customer sees it.{summary ? ` Folded, it reads: "${summary}".` : ""}</p>
      <p className="small">
        {usedBy.length ? (
          <>Shown by{" "}
            {usedBy.map((tool, i) => (
              <span key={tool}>{i > 0 && ", "}<a href={`/agent/actions/${tool}`} onClick={(e) => { e.preventDefault(); go(`/agent/actions/${tool}`); }}>{humanize(tool)}</a></span>
            ))}.
          </>
        ) : (
          <span className="muted">Not used yet. Pick it under "Show the result as a widget" on an action.</span>
        )}
      </p>
      {canEdit && (
        <div className="row agent-widget-actions">
          <Button variant="outline" size="sm" onClick={() => upload.current?.click()}>
            <UploadIcon /> Replace with a .widget file
          </Button>
          <Button variant="ghost" size="sm" nativeButton={false} render={<a href="https://widgets.chatkit.studio" target="_blank" rel="noopener noreferrer" />}>
            <ExternalLinkIcon /> Design in ChatKit Studio
          </Button>
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
      )}
      {!code && <Problems issues={cfg.issuesFor(path)} />}
    </section>
  );
}
