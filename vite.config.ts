import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the dashboard (index.html), the widget frame (widget.html) and the Worker
// (worker/) together; `vite dev` runs them in the Workers runtime with local D1,
// R2 and Durable Objects. public/ (widget.js loader, demo.html) is copied as-is.
export default defineConfig({
  // JUN_STATE_DIR gives a separate local database (used by the e2e tests so they don't
  // touch your own local desk). Pair with `wrangler ... --persist-to` on the same path.
  plugins: [react(), cloudflare(process.env.JUN_STATE_DIR ? { persistState: { path: process.env.JUN_STATE_DIR } } : {})],
  // Listen on 127.0.0.1: dev-only "Sign in with ChatGPT" must return to a 127.0.0.1
  // loopback URL (OpenAI forbids substituting localhost), and on Windows Vite would
  // otherwise bind IPv6 only. http://localhost:5173 still works in browsers.
  server: { host: "127.0.0.1" },
  // Only the browser build has two pages; the Worker build keeps its own entry.
  environments: {
    client: {
      build: { rollupOptions: { input: { main: "index.html", widget: "widget.html" } } },
    },
  },
});
