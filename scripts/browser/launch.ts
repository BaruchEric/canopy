// The launcher for the headless shell setup.sh installs. setup.sh and
// check.sh copy this file into the browser folder, where "playwright"
// resolves; it is outside the repo's tsconfig for the same reason.
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { chromium, type Browser, type LaunchOptions } from "playwright";

const dir = import.meta.dirname;
const build = readdirSync(join(dir, "browsers")).find((d) => d.startsWith("chromium_headless_shell-"));
if (!build) throw new Error(`no headless shell under ${dir}/browsers; run scripts/browser/setup.sh`);

export const executablePath = join(dir, "browsers", build, "chrome-headless-shell-linux64", "chrome-headless-shell");

// The container cannot make user namespaces, so the sandbox cannot start,
// and its /dev/shm is 64 MB, too small for Chromium's shared memory.
export const args = ["--no-sandbox", "--disable-dev-shm-usage"];

export function launch(options: LaunchOptions = {}): Promise<Browser> {
  return chromium.launch({ executablePath, headless: true, ...options, args: [...args, ...(options.args ?? [])] });
}
