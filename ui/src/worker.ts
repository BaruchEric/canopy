/** Cache and registration rules shared by the page and worker. ESNext
 * only: this module is also checked without the DOM library. */
import { sameBuild, versionLine } from "../../src/core/version";
import type { BuildInfo } from "../../src/core/types";
import { isShareCache, SHARE_PATH } from "./sharetarget";

export const SHELL = "/";
export const cacheName = (build: BuildInfo | null): string => build === null ? "canopy-dev" : `canopy-${versionLine(build)}`;
export type FetchPlan = "shell" | "asset" | "share" | "pass";

export function fetchPlan(req: { method: string; mode: string; url: string }, origin: string): FetchPlan {
  const url = new URL(req.url);
  if (url.origin !== origin) return "pass";
  // the share sheet's POST, which the worker holds for the page to take
  if (req.method === "POST" && req.mode === "navigate" && url.pathname === SHARE_PATH) return "share";
  if (req.method !== "GET") return "pass";
  const path = url.pathname;
  if (path === "/api" || path.startsWith("/api/") || path === "/library" || path.startsWith("/library/") || path === "/sw.js" || path === "/manifest.webmanifest" || path === "/icons" || path.startsWith("/icons/")) return "pass";
  if (path.startsWith("/assets/")) return "asset";
  return req.mode === "navigate" ? "shell" : "pass";
}

export const keepable = (res: { status: number; redirected: boolean; type: string }): boolean => res.status === 200 && !res.redirected && res.type === "basic";
/** every cache but this build's, leaving a share the page has yet to take */
export const staleCaches = (names: readonly string[], keep: string): string[] => names.filter((name) => name !== keep && !isShareCache(name));
export const shouldRegister = (w: { secure: boolean; dev: boolean; port: string; hasWorker: boolean }): boolean => w.secure && !w.dev && w.port !== "7851" && w.hasWorker;
export const wantsUpdate = (page: BuildInfo | null, server: BuildInfo | null): boolean => page !== null && server !== null && !sameBuild(page, server);
