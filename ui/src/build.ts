import type { BuildInfo } from "../../src/core/types";

declare const __CANOPY_BUILD__: BuildInfo | undefined;

/** The build this page was bundled from, stamped by vite.config.ts; null
 *  where nothing stamped it (under bun test). */
export const PAGE_BUILD: BuildInfo | null = typeof __CANOPY_BUILD__ === "undefined" ? null : __CANOPY_BUILD__;
