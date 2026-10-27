/** Cache and registration rules shared by the page and worker. ESNext
 * only: this module is also checked without the DOM library. */
import { sameBuild, versionLine } from "../../src/core/version";
import type { BuildInfo } from "../../src/core/types";

export const SHELL = "/";
export const cacheName = (build: BuildInfo | null): string => build === null ? "canopy-dev" : `canopy-${versionLine(build)}`;
export type FetchPlan = "shell" | "asset" | "pass";

export function fetchPlan(req: { method: string; mode: string; url: string }, origin: string): FetchPlan {
  const url = new URL(req.url);
  if (req.method !== "GET" || url.origin !== origin) return "pass";
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/") || path === "/library" || path.startsWith("/library/") || path === "/sw.js" || path === "/manifest.webmanifest" || path === "/icons" || path.startsWith("/icons/")) return "pass";
  if (path.startsWith("/assets/")) return "asset";
  return req.mode === "navigate" ? "shell" : "pass";
}

export const keepable = (res: { status: number; redirected: boolean; type: string }): boolean => res.status === 200 && !res.redirected && res.type === "basic";
export const staleCaches = (names: readonly string[], keep: string): string[] => names.filter((name) => name !== keep);
export const shouldRegister = (w: { secure: boolean; dev: boolean; port: string; hasWorker: boolean }): boolean => w.secure && !w.dev && w.port !== "7851" && w.hasWorker;
export const wantsUpdate = (page: BuildInfo | null, server: BuildInfo | null): boolean => page !== null && server !== null && !sameBuild(page, server);
