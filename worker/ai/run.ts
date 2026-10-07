import { isStepCount, jsonSchema, streamText, tool, type ToolSet } from "ai";
import type { AiStep, Message } from "../../shared/protocol.ts";
import { INLINE_SKILLS_MAX_CHARS, parseReply, searchQuery, streamVisible, systemPrompt, toChatMessages, type ReplyOutcome } from "./agent.ts";
import { intentSkill, type AgentConfig, type ToolUser } from "./config.ts";
import type { AgentModel } from "./providers.ts";
import { searchKnowledge, type SearchHit } from "./search.ts";
import { httpTools, secretsFromEnv, type ToolAction } from "./tools.ts";

// One AI reply, from conversation history to a parsed outcome. Shared by the live
// Conversation DO and the eval runner (AI-19), so evals test exactly what visitors get.

export const MAX_TOOL_STEPS = 5;

export interface RunInput {
  env: Env;
  workspaceId: string;
  workspaceName: string;
  model: AgentModel;
  config: AgentConfig;
  history: Message[];
  technical?: string[];
  /** Called with what the visitor may see so far (control lines held back), and the knowledge it may cite. */
  onVisible?: (visible: string, hits: SearchHit[]) => void;
  onAction?: (action: ToolAction) => void;
  /** Visitor-safe progress of each HTTP tool call (its `status:` label only). Live chats only. */
  onStep?: (step: AiStep) => void;
  /** Use tools' mock responses (evals). */
  mockTools?: boolean;
  timezone?: string;
  /** Evals use 0 so a diff reflects the config change, not sampling noise. */
  temperature?: number;
  /** The customer, when the host app verified who they are (V-03). */
  user?: ToolUser | null;
  /** AI-20: the intent the host app opened the chat with (its skill and built-in rules join the prompt). */
  intent?: string | null;
}

export interface RunResult {
  raw: string;
  outcome: ReplyOutcome;
  hits: SearchHit[];
  actions: ToolAction[];
  usage: { inputTokens: number; outputTokens: number };
}

function today(timezone = "UTC"): string {
  try {
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: timezone }).format(new Date());
  } catch {
    return new Intl.DateTimeFormat("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric", timeZone: "UTC" }).format(new Date());
  }
}

export async function runAgent(input: RunInput): Promise<RunResult> {
  const { config } = input;
  const hits = await searchKnowledge(input.env, input.workspaceId, searchQuery(input.history));
  const actions: ToolAction[] = [];
  const onAction = (action: ToolAction) => {
    actions.push(action);
    input.onAction?.(action);
  };

  const tools: ToolSet = httpTools(config.tools, {
    secrets: secretsFromEnv(input.env),
    mock: Boolean(input.mockTools),
    onAction,
    ...(input.onStep ? { onStep: input.onStep } : {}),
    user: input.user ?? null,
  });
  const skillChars = config.skills.reduce((n, s) => n + s.instructions.length + s.description.length, 0);
  const skillCatalog = skillChars > INLINE_SKILLS_MAX_CHARS;
  if (skillCatalog) {
    tools.activate_skill = tool({
      description: "Load the full steps of a procedure by name before following it.",
      inputSchema: jsonSchema<{ name: string }>({
        type: "object",
        properties: { name: { type: "string", enum: config.skills.map((s) => s.name) } },
        required: ["name"],
        additionalProperties: false,
      }),
      execute: async ({ name }) => {
        const skill = config.skills.find((s) => s.name === name);
        onAction({ tool: "activate_skill", input: { name }, output: skill ? "loaded" : "unknown procedure", status: skill ? "ok" : "error", httpStatus: null, durationMs: 0 });
        return skill ? skill.instructions : `No procedure named ${name}.`;
      },
    });
  }

  const system = systemPrompt({
    workspaceName: input.workspaceName,
    persona: config.persona,
    handoffTopics: config.handoffTopics,
    skills: config.skills,
    skillCatalog,
    tools: config.tools.map((t) => ({ name: t.name, description: t.description })),
    hits,
    technical: input.technical ?? [],
    today: today(input.timezone),
    ...(input.user ? { customer: input.user } : {}),
    ...(input.intent ? { intent: { name: input.intent, skill: intentSkill(config, input.intent) } } : {}),
  });

  const result = streamText({
    model: input.model.model,
    ...input.model.prompt(system),
    messages: toChatMessages(input.history),
    ...(Object.keys(tools).length ? { tools, stopWhen: isStepCount(MAX_TOOL_STEPS) } : {}),
    maxOutputTokens: 1200,
    ...(input.temperature !== undefined ? { temperature: input.temperature } : {}),
  });

  // Text from several steps (before and after tool calls) reads as one reply.
  let raw = "";
  let shown = "";
  let stepHasText = false;
  for await (const part of result.fullStream) {
    if (part.type === "start-step") {
      stepHasText = false;
    } else if (part.type === "text-delta") {
      if (!stepHasText && raw.trim()) raw = `${raw.trimEnd()}\n\n`;
      stepHasText = true;
      raw += part.text;
      const visible = streamVisible(raw);
      if (visible && visible !== shown) {
        shown = visible;
        input.onVisible?.(visible, hits);
      }
    } else if (part.type === "error") {
      throw part.error instanceof Error ? part.error : new Error(String(part.error));
    }
  }
  const usage = await result.totalUsage;
  return {
    raw,
    outcome: parseReply(raw),
    hits,
    actions,
    usage: { inputTokens: usage.inputTokens ?? 0, outputTokens: usage.outputTokens ?? 0 },
  };
}
