import { useState } from "react";
import { editFrontmatter, readFrontmatter, setBody } from "../lib/agentFiles.ts";
import { Input } from "@/components/ui/input.tsx";
import { Textarea } from "@/components/ui/textarea.tsx";
import { AddDialog, Advanced, CodeEditor, Field, ItemHead, ItemList, Problems, SKILL, TextList, Unreadable, go, humanize, slug, useCodeView } from "./parts.tsx";
import type { AgentConfig } from "./useAgentConfig.ts";

// /agent/procedures[/<name>]: skills/<name>/SKILL.md as a form: when it applies (description),
// the steps (body), and, folded away, how the customer's app can open a chat with it (AI-20 intent).

const starter = (name: string) =>
  `---\nname: ${name}\ndescription: \n---\n1. First, …\n2. Then, …\n3. Hand over to a person if …\n`;

export function ProceduresView({ cfg, canEdit, selected }: { cfg: AgentConfig; canEdit: boolean; selected: string | null }) {
  const [adding, setAdding] = useState(false);
  const items = Object.keys(cfg.draft)
    .map((path) => ({ path, name: SKILL.exec(path)?.[1] }))
    .filter((x): x is { path: string; name: string } => Boolean(x.name))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(({ path, name }) => ({ id: name, path, label: humanize(name), sub: (readFrontmatter(cfg.draft[path]!).data?.description as string | undefined) ?? "" }));
  const current = items.find((i) => i.id === selected) ?? items[0] ?? null;

  return (
    <div className="agent-split" data-picked={selected !== null && current?.id === selected ? "" : undefined}>
      <ItemList
        cfg={cfg}
        items={items}
        selected={current?.id ?? null}
        onSelect={(id) => go(`/agent/procedures/${id}`)}
        onAdd={() => setAdding(true)}
        addLabel="New procedure"
        canEdit={canEdit}
        empty="No procedures yet. A procedure is the steps the AI follows in one situation, like a refund or a plan change."
      />
      {current ? (
        <ProcedureForm key={current.path} cfg={cfg} canEdit={canEdit} path={current.path} name={current.id} />
      ) : (
        <div className="agent-form agent-blank muted">Add a procedure to teach the AI how your team handles a situation step by step.</div>
      )}
      <AddDialog
        open={adding}
        onClose={() => setAdding(false)}
        title="New procedure"
        description="Steps the AI follows in one situation, like changing a plan or cancelling an account."
        placeholder="e.g. Change plan"
        exists={(raw) => {
          const name = slug(raw, "-");
          if (!name) return "Use letters or numbers.";
          return `skills/${name}/SKILL.md` in cfg.draft ? "There's already a procedure with this name." : null;
        }}
        onAdd={(raw) => {
          const name = slug(raw, "-");
          cfg.setFile(`skills/${name}/SKILL.md`, starter(name));
          setAdding(false);
          go(`/agent/procedures/${name}`);
        }}
      />
    </div>
  );
}

function ProcedureForm({ cfg, canEdit, path, name }: { cfg: AgentConfig; canEdit: boolean; path: string; name: string }) {
  const text = cfg.draft[path] ?? "";
  const { data, body } = readFrontmatter(text);
  const set = (next: string) => cfg.setFile(path, next);
  const field = (key: string, value: unknown) => set(editFrontmatter(text, { op: "set", path: [key], value }));
  const code = useCodeView();
  if (code) {
    return (
      <section className="agent-form agent-code">
        <ItemHead back={{ path: "/agent/procedures", label: "All procedures" }} title={humanize(name)} canEdit={canEdit} onRemove={() => { cfg.setFile(path, undefined); go("/agent/procedures"); }} />
        <CodeEditor cfg={cfg} path={path} canEdit={canEdit} />
      </section>
    );
  }
  const str = (key: string) => (typeof data?.[key] === "string" ? (data[key] as string) : "");
  const replies = Array.isArray(data?.replies) ? (data.replies as unknown[]).map(String) : [];
  const intent = str("intent");

  return (
    <section className="agent-form">
      <ItemHead back={{ path: "/agent/procedures", label: "All procedures" }} title={humanize(name)} canEdit={canEdit} onRemove={() => { cfg.setFile(path, undefined); go("/agent/procedures"); }} />
      {data === null ? (
        <Unreadable />
      ) : (
        <Field label="When should the AI use this?" hint="The AI reads this to pick the right procedure." htmlFor="proc-when">
          <Textarea id="proc-when" rows={2} value={str("description")} readOnly={!canEdit} placeholder="e.g. The customer asks to change their plan." onChange={(e) => field("description", e.target.value)} />
        </Field>
      )}
      <Field label="Steps" hint="What the AI does, in order. Say what it may offer, and when it should hand over to a person." htmlFor="proc-steps">
        <Textarea id="proc-steps" className="agent-prose" rows={12} value={body} readOnly={!canEdit} onChange={(e) => set(setBody(text, e.target.value))} />
      </Field>
      {data !== null && (
        <Advanced title="Start it from a button in your app" defaultOpen={Boolean(intent)}>
          <p className="muted small">
            For example a Cancel button that opens the chat on this procedure. Your developer calls{" "}
            <code>JunDesk.open({`{ intent: "${intent || name}" }`})</code> with the name below.
          </p>
          <Field label="Name your app uses" htmlFor="proc-intent">
            <Input id="proc-intent" value={intent} readOnly={!canEdit} placeholder={name} maxLength={40} onChange={(e) => field("intent", e.target.value.toLowerCase())} />
          </Field>
          {intent && (
            <>
              <Field label="First message" hint="Shown before the customer types anything." htmlFor="proc-opening">
                <Input id="proc-opening" value={str("opening")} readOnly={!canEdit} maxLength={300} placeholder="e.g. Sorry to see you go. What's the main reason?" onChange={(e) => field("opening", e.target.value)} />
              </Field>
              <Field label="Quick replies" hint="Buttons under the first message.">
                <TextList values={replies} onChange={(next) => field("replies", next)} placeholder="e.g. Too expensive" label="Quick reply" addLabel="Add a reply" disabled={!canEdit} max={8} />
              </Field>
              <Field label="Leave button" hint="Always on screen, so the customer can finish without talking to the AI." htmlFor="proc-exit">
                <Input id="proc-exit" value={str("exit")} readOnly={!canEdit} maxLength={40} placeholder="e.g. Cancel anyway" onChange={(e) => field("exit", e.target.value)} />
              </Field>
            </>
          )}
        </Advanced>
      )}
      <Problems issues={cfg.issuesFor(path)} />
    </section>
  );
}
