#!/usr/bin/env node
import { createInterface } from "node:readline/promises";
import { parseArgs } from "node:util";
import {
  ChatGPTAuth,
  ChatGPTProvider,
  hasPlanUsageScope,
  LlmError,
  OpenAIProvider,
  type ChatMessage,
  type LlmProvider,
} from "@jun/llm";
import { loginWithChatGPT } from "./login.ts";
import { FileCredentialStore } from "./store.ts";

const HELP = `jun — Jun Desk developer CLI

Usage:
  jun login chatgpt [--no-browser]   Sign in with ChatGPT (dev only: uses your own plan)
  jun logout chatgpt                 Revoke and forget ChatGPT tokens
  jun whoami                         Show the signed-in ChatGPT account
  jun models                         List models available to your ChatGPT account
  jun ask "<question>"               Ask once and stream the answer
  jun chat                           Multi-turn chat in the terminal

Options for ask/chat:
  --provider chatgpt|openai   Default: chatgpt, or $JUN_LLM_PROVIDER
  --model <slug>              Default: $JUN_MODEL or the provider default
  --instructions "<text>"     System guidance for the assistant

The openai provider reads $OPENAI_API_KEY (and optional $OPENAI_BASE_URL, e.g. an AI Gateway URL).`;

function createProvider(name: string, model: string | undefined, store: FileCredentialStore): LlmProvider {
  const modelOption = model ? { model } : {};
  if (name === "chatgpt") return new ChatGPTProvider(new ChatGPTAuth(store), modelOption);
  if (name === "openai") {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error("Set OPENAI_API_KEY to use --provider openai.");
    const baseUrl = process.env.OPENAI_BASE_URL;
    return new OpenAIProvider({ apiKey, ...modelOption, ...(baseUrl ? { baseUrl } : {}) });
  }
  throw new Error(`Unknown provider "${name}". Use chatgpt or openai.`);
}

async function streamToStdout(provider: LlmProvider, messages: ChatMessage[], instructions: string | undefined): Promise<string> {
  let answer = "";
  for await (const event of provider.stream({ messages, ...(instructions ? { instructions } : {}) })) {
    if (event.type === "text-delta") process.stdout.write(event.text);
    else answer = event.text;
  }
  process.stdout.write("\n");
  return answer;
}

async function main(argv: string[]): Promise<void> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      instructions: { type: "string" },
      "no-browser": { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [command, arg] = positionals;
  const store = new FileCredentialStore();

  if (values.help || !command) {
    console.log(HELP);
    return;
  }

  switch (command) {
    case "login": {
      if (arg !== "chatgpt") throw new Error("Usage: jun login chatgpt");
      console.log("Note: ChatGPT sign-in is for local development only. Released builds use an OpenAI API key.\n");
      const result = await loginWithChatGPT(store, { openBrowser: !values["no-browser"] });
      console.log(`\nSigned in${result.email ? ` as ${result.email}` : ""}.${result.registered ? " (Registered this machine with OpenAI.)" : ""}`);
      console.log(`Credentials saved to ${store.path}`);
      return;
    }
    case "logout": {
      await new ChatGPTAuth(store).logout();
      console.log("Signed out of ChatGPT.");
      return;
    }
    case "whoami": {
      const tokens = (await store.load())?.tokens;
      if (!tokens) {
        console.log("Not signed in. Run `jun login chatgpt`.");
        return;
      }
      console.log(`ChatGPT account: ${tokens.email ?? "(unknown email)"}`);
      console.log(`Access token expires: ${new Date(tokens.expiresAt).toLocaleString()}`);
      console.log(`Plan usage granted: ${hasPlanUsageScope(tokens) ? "yes" : "no"}`);
      return;
    }
    case "models": {
      const provider = new ChatGPTProvider(new ChatGPTAuth(store));
      for (const model of await provider.listModels()) {
        console.log(model.displayName === model.slug ? model.slug : `${model.slug}  (${model.displayName})`);
      }
      return;
    }
    case "ask": {
      const question = positionals.slice(1).join(" ");
      if (!question) throw new Error('Usage: jun ask "<question>"');
      const provider = createProvider(values.provider ?? process.env.JUN_LLM_PROVIDER ?? "chatgpt", values.model ?? process.env.JUN_MODEL, store);
      await streamToStdout(provider, [{ role: "user", content: question }], values.instructions);
      return;
    }
    case "chat": {
      const provider = createProvider(values.provider ?? process.env.JUN_LLM_PROVIDER ?? "chatgpt", values.model ?? process.env.JUN_MODEL, store);
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      // History is sent with every request: plan usage requires store:false and no previous_response_id.
      const history: ChatMessage[] = [];
      console.log(`Chatting via ${provider.id}. Empty line or Ctrl+C to exit.`);
      try {
        while (true) {
          const line = (await rl.question("\nyou › ")).trim();
          if (!line) break;
          history.push({ role: "user", content: line });
          process.stdout.write("ai  › ");
          try {
            history.push({ role: "assistant", content: await streamToStdout(provider, history, values.instructions) });
          } catch (error) {
            history.pop();
            throw error;
          }
        }
      } finally {
        rl.close();
      }
      return;
    }
    default:
      throw new Error(`Unknown command "${command}".\n\n${HELP}`);
  }
}

main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof LlmError) console.error(`\nError (${error.code}): ${error.message}`);
  else console.error(`\nError: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
