import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath, URL } from "node:url";

// Vite builds the Pixi.js + React client into ./dist. Cloudflare Pages then
// serves ./dist as static assets while /functions is deployed as Pages
// Functions. Because the SPA and the API share the same origin, no CORS
// configuration is ever required (see functions/api/*).
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@shared": fileURLToPath(new URL("./src/shared", import.meta.url)),
      "@sim": fileURLToPath(new URL("./src/sim", import.meta.url)),
    },
  },
  build: {
    target: "es2022",
    sourcemap: true,
  },
});
