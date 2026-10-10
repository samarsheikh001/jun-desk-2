import { useState } from "react";
import { navigate } from "../lib/router.ts";
import { PageTabs } from "../components/PageTabs.tsx";
import { AiPanel } from "./AiPanel.tsx";
import { SettingsCard } from "../settings/layout.tsx";
import { Badge } from "@/components/ui/badge.tsx";
import { Button } from "@/components/ui/button.tsx";
import { ScrollArea } from "@/components/ui/scroll-area.tsx";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet.tsx";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs.tsx";
import { ActionsView } from "./ActionsView.tsx";
import { WidgetsView } from "./WidgetsView.tsx";
import { InstructionsView } from "./InstructionsView.tsx";
import { ProceduresView } from "./ProceduresView.tsx";
import { TestsView } from "./TestsView.tsx";
import { SaveBar, routeFor, setCodeView, useCodeView } from "./parts.tsx";
import { useAgentConfig, type AgentConfig } from "./useAgentConfig.ts";

// The Agent page (AI-18). Plain views, one URL each, for the people who run support:
//   /agent              Instructions: how the AI talks, when it hands over (AGENTS.md)
//   /agent/procedures   step-by-step procedures (skills/*/SKILL.md)
//   /agent/actions      requests to your systems (tools/*.yaml)
//   /agent/widgets      how an action's result is shown (widgets/*.widget)
//   /agent/tests        test cases and "Run tests" (evals/*.yaml)
//   /agent/settings     provider, model, monthly cap; keeping it in git
// Each page has a Form / Code switch (remembered, not in the URL): Code shows the same item's file as
// text, exactly as `jun pull` / `jun push` see it. Every view edits one shared draft; one save makes
// it a new version.

type Tab = "instructions" | "procedures" | "actions" | "widgets" | "tests" | "settings";
const TABS: Tab[] = ["instructions", "procedures", "actions", "widgets", "tests", "settings"];

/** The Agent's parts, as the sidebar lists them under Agent. */
export const AGENT_SECTIONS: { id: Tab; label: string; path: string }[] = [
  { id: "instructions", label: "Instructions", path: "/agent" },
  { id: "procedures", label: "Procedures", path: "/agent/procedures" },
  { id: "actions", label: "Actions", path: "/agent/actions" },
  { id: "widgets", label: "Widgets", path: "/agent/widgets" },
  { id: "tests", label: "Tests", path: "/agent/tests" },
  { id: "settings", label: "Settings", path: "/agent/settings" },
];

/**
 * Old /agent/code[/<file>] links (the Code page before the Form / Code switch): that file's page,
 * switched to Code. The shell rewrites them before rendering, like the moved Settings links.
 */
export function movedFromAgentCode(path: string): string | null {
  if (!/^\/agent\/code(\/|$)/.test(path)) return null;
  setCodeView(true, true);
  const file = decodeURIComponent(path.slice("/agent/code/".length));
  return file ? routeFor(file) : "/agent";
}

/** Which part of the Agent page a path shows. */
export function agentSection(path: string): Tab {
  const segment = path.split("/")[2] ?? "";
  return (TABS as string[]).includes(segment) ? (segment as Tab) : "instructions";
}

const ago = (ms: number) => {
  const minutes = Math.round((Date.now() - ms) / 60_000);
  return minutes < 1 ? "just now" : minutes < 60 ? `${minutes} min ago` : minutes < 1440 ? `${Math.round(minutes / 60)} h ago` : new Date(ms).toLocaleDateString();
};

export function AgentPage({ workspaceId, canEdit, path }: { workspaceId: string; canEdit: boolean; path: string }) {
  const cfg = useAgentConfig(workspaceId);
  const [history, setHistory] = useState(false);
  const code = useCodeView();
  const [, , , ...rest] = path.split("/");
  const tab = agentSection(path);
  const item = rest.length ? decodeURIComponent(rest.join("/")) : null;

  const view = (content: React.ReactNode) =>
    cfg.state ? (
      <div className="agent-view">
        {content}
        <SaveBar cfg={cfg} canEdit={canEdit} />
      </div>
    ) : (
      <div className="content muted">Loading…</div>
    );

  return (
    <>
      <PageTabs
        title={AGENT_SECTIONS.find((a) => a.id === tab)!.label}
        tabsHidden
        value={tab}
        className="agent-tabs"
        actions={
          tab !== "settings" && <>
            <Tabs value={code ? "code" : "form"} onValueChange={(v) => setCodeView(v === "code")}>
              <TabsList className="kb-tabs agent-view-switch" aria-label="View">
                <TabsTrigger value="form">Form</TabsTrigger>
                <TabsTrigger value="code" title="The same settings as files, as in git">Code</TabsTrigger>
              </TabsList>
            </Tabs>
            <Button variant="ghost" size="sm" onClick={() => setHistory(true)}>History</Button>
          </>
        }
        tabs={[
          { value: "instructions", label: "Instructions", path: "/agent", content: view(<InstructionsView cfg={cfg} canEdit={canEdit} />) },
          { value: "procedures", label: "Procedures", path: "/agent/procedures", content: view(<ProceduresView cfg={cfg} canEdit={canEdit} selected={tab === "procedures" ? item : null} />) },
          { value: "actions", label: "Actions", path: "/agent/actions", content: view(<ActionsView cfg={cfg} canEdit={canEdit} selected={tab === "actions" ? item : null} />) },
          { value: "widgets", label: "Widgets", path: "/agent/widgets", content: view(<WidgetsView cfg={cfg} canEdit={canEdit} selected={tab === "widgets" ? item : null} />) },
          { value: "tests", label: "Tests", path: "/agent/tests", content: view(<TestsView cfg={cfg} canEdit={canEdit} />) },
          {
            value: "settings",
            label: "Settings",
            path: "/agent/settings",
            content: (
              <div className="page-settings settings-sections">
                <AiPanel workspaceId={workspaceId} canEdit={canEdit} />
                <GitCard />
              </div>
            ),
          },
        ]}
      />
      <HistorySheet cfg={cfg} canEdit={canEdit} open={history} onClose={() => setHistory(false)} />
    </>
  );
}

function HistorySheet({ cfg, canEdit, open, onClose }: { cfg: AgentConfig; canEdit: boolean; open: boolean; onClose: () => void }) {
  const state = cfg.state;
  return (
    <Sheet open={open} onOpenChange={(o) => !o && onClose()}>
      <SheetContent side="right" className="agent-history-sheet">
        <SheetHeader>
          <SheetTitle>History</SheetTitle>
          <SheetDescription>Every save is a version. Restoring one puts it in your draft; it goes live when you save.</SheetDescription>
        </SheetHeader>
        <ScrollArea className="agent-history-list">
          {state && state.versions.length === 0 && <p className="muted small">Nothing saved yet. The AI uses the built-in defaults.</p>}
          <ul className="agent-versions">
            {state?.versions.map((v) => (
              <li key={v.version} className="small">
                <div className="row">
                  <span className="strong">Version {v.version}</span>
                  {v.version === state.version && <Badge variant="secondary" className="agent-pass">Live</Badge>}
                  <span className="spacer" />
                  {canEdit && v.version !== state.version && (
                    <Button variant="outline" size="sm" disabled={cfg.busy} onClick={() => { cfg.restore(v.version); onClose(); }}>Restore</Button>
                  )}
                </div>
                <div>{v.message || <span className="muted">No note</span>}</div>
                <div className="muted">{v.source === "cli" ? "Pushed from git" : "Saved"} by {v.createdBy ?? "someone"} · {ago(v.createdAt)}</div>
              </li>
            ))}
          </ul>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/** Developers can keep the agent's files in git and push them from CI. */
function GitCard() {
  return (
    <SettingsCard
      id="agent-git"
      title="Keep it in git"
      description="Everything on these pages is a set of text files. Developers can pull them into your Jun Desk checkout, review changes there, run the tests and push them back."
    >
      <p className="small muted">
        Create a token in{" "}
        <a href="/settings/developer#api-tokens" onClick={(e) => { e.preventDefault(); navigate("/settings/developer#api-tokens"); }}>Settings → Developer → API tokens</a>, then run:
      </p>
      <pre className="agent-git-commands">{`npm run jun -- login ${window.location.origin}
npm run jun -- pull support-agent
npm run jun -- eval support-agent
npm run jun -- push support-agent`}</pre>
    </SettingsCard>
  );
}
