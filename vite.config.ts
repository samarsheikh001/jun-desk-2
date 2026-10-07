import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { minifySync } from "rolldown/utils";
import { defineConfig, type Plugin } from "vite";

/**
 * public/widget.js stays readable in the repo; the copy we serve is minified (it runs on
 * every customer page, budget: 6 KB gzipped, D-38). Keeps the license header.
 */
function minifyLoader(): Plugin {
  return {
    name: "jun:minify-loader",
    apply: "build",
    writeBundle(options) {
      const file = join(options.dir ?? "", "widget.js");
      if (!existsSync(file)) return;
      const source = readFileSync(file, "utf8");
      if (!source.startsWith("/*!")) return; // already minified
      const result = minifySync("widget.js", source, { compress: true, mangle: true });
      if (result.errors.length) throw new Error(`widget.js minify failed: ${result.errors.map((e) => e.message).join("; ")}`);
      writeFileSync(file, `/*! Jun Desk widget loader | MIT License | source: public/widget.js */\n${result.code}`);
    },
  };
}

// Builds the dashboard (index.html), the widget frame (widget.html) and the Worker
// (worker/) together; `vite dev` runs them in the Workers runtime with local D1,
// R2 and Durable Objects. public/ (widget.js loader, demo.html) is copied; widget.js gets minified.
export default defineConfig({
  // JUN_STATE_DIR gives a separate local database (used by the e2e tests so they don't
  // touch your own local desk). Pair with `wrangler ... --persist-to` on the same path.
  // Tailwind (shadcn/ui) only processes CSS that imports it: web/desk.css, the dashboard's sheet.
  // The widget frame keeps its own plain CSS (web/styles.css + web/widget/widget.css).
  plugins: [react(), tailwindcss(), minifyLoader(), cloudflare(process.env.JUN_STATE_DIR ? { persistState: { path: process.env.JUN_STATE_DIR } } : {})],
  // Listen on 127.0.0.1: dev-only "Sign in with ChatGPT" must return to a 127.0.0.1
  // loopback URL (OpenAI forbids substituting localhost), and on Windows Vite would
  // otherwise bind IPv6 only. http://localhost:5173 still works in browsers.
  server: { host: "127.0.0.1" },
  // shadcn/ui imports: "@/components/ui/…", "@/lib/utils.ts".
  resolve: { alias: { "@": resolve(import.meta.dirname, "web") } },
  // Only the browser build has two pages; the Worker build keeps its own entry.
  environments: {
    client: {
      // The Dashboard's chart is lazy-loaded, so dev would only discover these on first open
      // and answer "504 Outdated Optimize Dep" until a reload: pre-bundle them at startup.
      optimizeDeps: { include: ["motion/react", "d3-scale", "d3-shape"] },
      build: { rollupOptions: { input: { main: "index.html", widget: "widget.html" } } },
    },
  },
});
