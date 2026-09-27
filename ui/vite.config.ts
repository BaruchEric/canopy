import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";
import { readBuild } from "../src/core/build";

export default defineConfig({
  plugins: [react()],
  // the build the page was bundled from, which the settings' about section
  // holds up against the server's to tell a stale page or dist/web apart
  define: { __CANOPY_BUILD__: JSON.stringify(readBuild()) },
  build: {
    outDir: "../dist/web",
    emptyOutDir: true,
  },
  server: {
    port: 7851,
    proxy: {
      "/library": "http://127.0.0.1:7850",
      "/api": { target: "http://127.0.0.1:7850", ws: true },
    },
  },
});
