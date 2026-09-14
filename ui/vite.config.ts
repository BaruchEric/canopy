import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
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
