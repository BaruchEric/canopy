// The launcher for the headless shell setup.sh installs. setup.sh and
// check.sh copy this file into the browser folder, where "playwright"
// resolves; it is outside the repo's tsconfig for the same reason.
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright";

const dir = import.meta.dirname;

// Playwright names the shell's folder by platform: linux64 in canopy's
// containers, mac-arm64 or mac-x64 on a Mac whose `browsers` folder is
// Playwright's own cache (~/Library/Caches/ms-playwright).
const platform = process.platform === "darwin" ? `mac-${process.arch === "arm64" ? "arm64" : "x64"}` : "linux64";
const exe = (build: string): string => join(dir, "browsers", build, `chrome-headless-shell-${platform}`, "chrome-headless-shell");

// The newest build that holds this platform's shell; a cache can hold several.
const builds = readdirSync(join(dir, "browsers"))
  .filter((d) => d.startsWith("chromium_headless_shell-"))
  .sort((a, b) => Number(b.split("-").pop()) - Number(a.split("-").pop()));
const build = builds.find((b) => existsSync(exe(b)));
if (!build) throw new Error(`no ${platform} headless shell under ${dir}/browsers; run scripts/browser/setup.sh`);

export const executablePath = exe(build);

// The container cannot make user namespaces, so the sandbox cannot start,
// and its /dev/shm is 64 MB, too small for Chromium's shared memory.
export const args = ["--no-sandbox", "--disable-dev-shm-usage"];

export function launch(options: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ executablePath, headless: true, ...options, args: [...args, ...(options.args ?? [])] });
}
