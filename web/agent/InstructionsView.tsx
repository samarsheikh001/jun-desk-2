import { useState } from "react";
import { navigate } from "../lib/router.ts";
import { editFrontmatter, readFrontmatter, setBody } from "../lib/agentFiles.ts";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { SettingRow, SettingsCard } from "../settings/layout.tsx";
import { CodeEditor, EVAL, FilePicker, Problems, SKILL, TextList, TOOL, Unreadable, WIDGET, go, useCodeView } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// /agent: AGENTS.md as two plain settings: how the AI talks (the body) and when it hands over
// (the frontmatter's maxReplies and handoffTopics). In Code: AGENTS.md as text, and any file of no
// other kind (a README.md) beside it.

const PATH = "AGENTS.md";
const DEFAULT_MAX_REPLIES = 8;

export function InstructionsView({ cfg, canEdit }: { cfg: AgentConfig; canEdit: boolean }) {
  const code = useCodeView();
  if (code) return <InstructionsCode cfg={cfg} canEdit={canEdit} />;
  return <InstructionsForm cfg={cfg} canEdit={canEdit} />;
}

function InstructionsCode({ cfg, canEdit }: { cfg: AgentConfig; canEdit: boolean }) {
  const others = Object.keys(cfg.draft).filter((p) => p !== PATH && ![SKILL, TOOL, WIDGET, EVAL].some((re) => re.test(p))).sort();
  const [picked, setPicked] = useState(PATH);
  const path = picked in cfg.draft ? picked : PATH;
  return (
    <section className="agent-form agent-code">
      {others.length > 0 && <FilePicker files={[PATH, ...others]} value={path} onChange={setPicked} />}
      <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
    </section>
  );
}

function InstructionsForm({ cfg, canEdit }: { cfg: AgentConfig; canEdit: boolean }) {
  const text = cfg.draft[PATH] ?? "";
  const { data, body } = readFrontmatter(text);
  const set = (next: string) => cfg.setFile(PATH, next);
  const maxReplies = typeof data?.maxReplies === "number" ? data.maxReplies : undefined;
  const topics = Array.isArray(data?.handoffTopics) ? (data.handoffTopics as unknown[]).map(String) : [];

  return (
    <div className="agent-form settings-sections">
      <SettingsCard
        title="How the AI talks"
        description="Its tone, and anything it should always or never do. Write it like you'd brief a new teammate. Steps for one situation (like refunds) go in Procedures."
      >
        <Textarea
          className="agent-prose"
          aria-label="How the AI talks"
          value={body}
          onChange={(e) => set(setBody(text, e.target.value))}
          readOnly={!canEdit}
          rows={14}
        />
        <Problems issues={cfg.issuesFor(PATH)} />
      </SettingsCard>
      <SettingsCard title="When to hand over to your team" description="The AI also hands over whenever a customer asks for a person, or when it can't help.">
        {data === null ? (
          <Unreadable />
        ) : (
          <>
            <SettingRow label="Hand over after this many AI replies" description={`In one conversation. From 1 to 50; ${DEFAULT_MAX_REPLIES} if left empty.`} htmlFor="agent-max-replies">
              <Input
                id="agent-max-replies"
                type="number"
                min={1}
                max={50}
                placeholder={String(DEFAULT_MAX_REPLIES)}
                value={maxReplies ?? ""}
                disabled={!canEdit}
                onChange={(e) => set(editFrontmatter(text, { op: "set", path: ["maxReplies"], value: e.target.value === "" ? "" : Number(e.target.value) }))}
              />
            </SettingRow>
            <SettingRow wide label="Always hand these topics to a person" description="The AI doesn't try to answer these, even if your docs cover them.">
              <TextList
                values={topics}
                onChange={(next) => set(editFrontmatter(text, { op: "set", path: ["handoffTopics"], value: next }))}
                placeholder="e.g. legal or security questions" label="Topic"
                addLabel="Add a topic"
                disabled={!canEdit}
                max={30}
              />
            </SettingRow>
          </>
        )}
      </SettingsCard>
      <p className="muted small agent-form-foot">
        Answers come from your <a href="/knowledge" onClick={(e) => { e.preventDefault(); navigate("/knowledge"); }}>Knowledge</a>. The model and the monthly limit are in{" "}
        <a href="/agent/settings" onClick={(e) => { e.preventDefault(); go("/agent/settings"); }}>Settings</a>.
      </p>
    </div>
  );
}
