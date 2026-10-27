import { expect, test } from "bun:test";
import type { BuildInfo } from "../../src/core/types";
import { installState, isInstallPrompt, standing, workerLine } from "./install";

const eligible: Parameters<typeof standing>[0] = { standalone: false, dev: false, secure: true, hasWorker: true, platform: "mac" };

test("installed mode takes precedence, then browser capabilities select the installation instructions", () => {
  expect(standing({ ...eligible, standalone: true, secure: false, dev: true })).toBe("installed");
  expect(standing({ ...eligible, dev: true, secure: false })).toBe("dev");
  expect(standing({ ...eligible, secure: false, hasWorker: false })).toBe("insecure");
  expect(standing({ ...eligible, hasWorker: false, platform: "ios" })).toBe("unsupported");
  expect(standing({ ...eligible, platform: "ios" })).toBe("ios");
  expect(standing({ ...eligible, platform: "android" })).toBe("browser");
  expect(standing(eligible)).toBe("browser");
});

test("registration state exposes the build or the browser's MIME failure with clean punctuation", () => {
  const build: BuildInfo = { version: "0.2.0", commit: "1ac8fe7", committedAt: "2026-10-26T12:42:06-07:00", dirty: false };
  expect(workerLine({ state: "none" })).toBeNull();
  expect(workerLine({ state: "ready", build })).toContain("build 0.2.0 (1ac8fe7, 2026-10-26)");
  expect(workerLine({ state: "ready", build: null })).toContain("an unstamped build");
  const error = "The script has an unsupported MIME type ('text/html').";
  expect(workerLine({ state: "failed", error })).toBe(`The worker could not register: ${error} The page works as before, without the offline shell.`);
  expect(workerLine({ state: "failed", error: "network error" })).toContain("network error. The page");
});

test("only an event with a prompt method is usable, and external-store reads are stable", () => {
  expect(isInstallPrompt(new Event("beforeinstallprompt"))).toBe(false);
  expect(isInstallPrompt(Object.assign(new Event("beforeinstallprompt"), { prompt: () => Promise.resolve() }))).toBe(true);
  expect(installState()).toBe(installState());
});
