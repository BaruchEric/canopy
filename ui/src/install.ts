/** Installation state for this browser. Browser globals are read only when
 * main calls registerWorker, so the model also loads under bun test. */
import type { BuildInfo, DevicePlatform } from "../../src/core/types";
import { versionLine } from "../../src/core/version";
import { PAGE_BUILD } from "./build";
import { homeConn, useStore } from "./store";
import { shouldRegister, wantsUpdate } from "./worker";

export type Standing = "installed" | "dev" | "insecure" | "unsupported" | "ios" | "browser";
export function standing(w: { standalone: boolean; dev: boolean; secure: boolean; hasWorker: boolean; platform: DevicePlatform }): Standing {
  if (w.standalone) return "installed";
  if (w.dev) return "dev";
  if (!w.secure) return "insecure";
  if (!w.hasWorker) return "unsupported";
  return w.platform === "ios" ? "ios" : "browser";
}

export const STANDING_WORDS: Record<Standing, string> = {
  installed: "Installed: this page runs from the home screen, in a window of its own.",
  dev: "The Vite dev server registers no worker, so this page is not installable; the built page is.",
  insecure: "This page is on plain http; installing it and the offline shell need https or localhost.",
  unsupported: "This browser has no service worker, so the page cannot be installed; it still works as a tab.",
  ios: "Install it from Safari: share → Add to Home Screen. The installed page opens full screen, without the browser's bars.",
  browser: "Install it from the browser's menu (Chrome and Edge: Install canopy) to open it in a window of its own.",
};

export type WorkerState = { state: "none" } | { state: "registering" } | { state: "ready"; build: BuildInfo | null } | { state: "failed"; error: string };
export function workerLine(worker: WorkerState): string | null {
  switch (worker.state) {
    case "none": return null;
    case "registering": return "Offline shell: registering the worker…";
    case "ready": return `Offline shell: ${worker.build === null ? "an unstamped build" : `build ${versionLine(worker.build)}`}. The page opens without the backend; every list needs it.`;
    case "failed": return `The worker could not register: ${worker.error}${worker.error.endsWith(".") ? "" : "."} The page works as before, without the offline shell.`;
  }
}

export interface InstallPrompt extends Event { prompt(): Promise<unknown> }
export const isInstallPrompt = (event: Event): event is InstallPrompt => "prompt" in event && typeof event.prompt === "function";
interface InstallState { worker: WorkerState; prompt: InstallPrompt | null }
let snapshot: Readonly<InstallState> = Object.freeze<InstallState>({ worker: { state: "none" }, prompt: null });
const listeners = new Set<() => void>();
let registered = false;

function publish(worker: WorkerState, prompt: InstallPrompt | null = snapshot.prompt): void {
  snapshot = Object.freeze({ worker, prompt });
  for (const listener of listeners) listener();
}
export const installState = (): Readonly<InstallState> => snapshot;
export function subscribeInstall(listener: () => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** Consume the captured browser gesture once, even when it is declined. */
export async function requestInstall(): Promise<void> {
  const prompt = snapshot.prompt;
  if (prompt === null) return;
  publish(snapshot.worker, null);
  await prompt.prompt();
}

export function registerWorker(): void {
  if (registered || typeof window === "undefined") return;
  registered = true;
  window.addEventListener("beforeinstallprompt", (event) => {
    if (!isInstallPrompt(event)) return;
    event.preventDefault();
    publish(snapshot.worker, event);
  });
  if (!shouldRegister({ secure: window.isSecureContext, dev: import.meta.env.DEV, port: location.port, hasWorker: "serviceWorker" in navigator })) return;
  const start = async (): Promise<void> => {
    publish({ state: "registering" });
    try {
      const registration = await navigator.serviceWorker.register("/sw.js");
      await navigator.serviceWorker.ready;
      publish({ state: "ready", build: PAGE_BUILD });
      let lastAbout: ReturnType<typeof homeConn>["about"] = null;
      const watch = (state: Parameters<typeof homeConn>[0]): void => {
        const about = homeConn(state).about;
        if (about === lastAbout) return;
        lastAbout = about;
        if (wantsUpdate(PAGE_BUILD, about)) void registration.update().catch(() => {});
      };
      watch(useStore.getState());
      useStore.subscribe(watch);
    } catch (error) {
      publish({ state: "failed", error: error instanceof Error ? error.message : String(error) });
    }
  };
  if (document.readyState === "complete") void start();
  else window.addEventListener("load", () => { void start(); }, { once: true });
}
