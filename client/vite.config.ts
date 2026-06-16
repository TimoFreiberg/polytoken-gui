import { svelte } from "@sveltejs/vite-plugin-svelte";
import { defineConfig } from "vite";

const SERVER = process.env.PILOT_SERVER ?? "http://localhost:8787";

// During dev the Svelte app runs on Vite (5173) and proxies the WS + introspection
// endpoints to the Bun server (8787). In prod the Bun server serves the built bundle.
export default defineConfig({
  plugins: [svelte()],
  server: {
    port: 5173,
    proxy: {
      "/ws": { target: SERVER.replace("http", "ws"), ws: true },
      "/debug": { target: SERVER },
      "/health": { target: SERVER },
    },
  },
});
