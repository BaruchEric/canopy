import { resolve } from "node:path";
import { defineConfig } from "vite";
import { readBuild } from "../src/core/build";

export default defineConfig({
  define: { __CANOPY_BUILD__: JSON.stringify(readBuild()) },
  build: {
    outDir: "../dist/web",
    emptyOutDir: false,
    rollupOptions: { input: resolve(import.meta.dirname, "sw.ts"), output: { entryFileNames: "sw.js", format: "es" } },
  },
});
