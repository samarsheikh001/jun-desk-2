import { cloudflare } from "@cloudflare/vite-plugin";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Builds the dashboard (web/) and the Worker (worker/) together; `vite dev` runs both
// in the Workers runtime with local D1 and Durable Objects.
export default defineConfig({
  plugins: [react(), cloudflare()],
});
