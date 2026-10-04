import { Hono } from "hono";
import { auth } from "./routes/auth.ts";
import { conversations } from "./routes/conversations.ts";
import { files } from "./routes/files.ts";
import { widget } from "./routes/widget.ts";
import { workspaces } from "./routes/workspaces.ts";
import { HttpError, type AppEnv } from "./types.ts";

export { Conversation } from "./conversation.ts";
export { WorkspaceHub } from "./hub.ts";

const app = new Hono<AppEnv>().basePath("/api");

// CSRF protection for cookie-authenticated requests: state-changing requests must be
// JSON or carry our X-Jun-Upload header (neither of which a cross-site form can send)
// and, when the browser says where they came from, come from this origin.
app.use("*", async (c, next) => {
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("origin");
    if (origin && origin !== new URL(c.req.url).origin) {
      throw new HttpError(403, "bad_origin", "Cross-origin request rejected.");
    }
    const isUpload = c.req.header("x-jun-upload") === "1";
    if (c.req.method !== "DELETE" && !isUpload && !c.req.header("content-type")?.startsWith("application/json")) {
      throw new HttpError(400, "json_required", "Send JSON with Content-Type: application/json.");
    }
  }
  await next();
});

app.get("/health", (c) => c.json({ ok: true }));
app.route("/", auth);
app.route("/", workspaces);
app.route("/", conversations);
app.route("/", widget);
app.route("/", files);

app.notFound((c) => c.json({ error: { code: "not_found", message: "No such API route." } }, 404));

app.onError((error, c) => {
  if (error instanceof HttpError) {
    return c.json({ error: { code: error.code, message: error.message } }, error.status);
  }
  console.error(error);
  return c.json({ error: { code: "internal", message: "Something went wrong." } }, 500);
});

export default app;
