import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the dashboard (index.html), the widget frame (widget.html) and the Worker
// (worker/) together; `vite dev` runs them in the Workers runtime with local D1,
// R2 and Durable Objects. public/ (widget.js loader, demo.html) is copied as-is.
export default defineConfig({
  plugins: [react(), cloudflare()],
  // Only the browser build has two pages; the Worker build keeps its own entry.
  environments: {
    client: {
      build: { rollupOptions: { input: { main: "index.html", widget: "widget.html" } } },
    },
  },
});
