import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "./exec";
import { configDir } from "./store";

export const OPENER_IDS = ["kitty", "terminal", "code", "finder"] as const;
export type OpenerId = (typeof OPENER_IDS)[number];

function commandFor(app: OpenerId, path: string): string[] {
  switch (app) {
    case "kitty":
      return [
        "open",
        "-na",
        "kitty.app",
        "--args",
        "--single-instance",
        "--directory",
        path,
      ];
    case "terminal":
      return ["open", "-a", "Terminal", path];
    case "code":
      return Bun.which("code")
        ? ["code", path]
        : ["open", "-a", "Visual Studio Code", path];
    case "finder":
      return ["open", path];
  }
}

export async function openIn(app: OpenerId, path: string): Promise<void> {
  const r = await exec(commandFor(app, path), { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `failed to open ${app}`);
}

/** Open a group of repos as one unit:
 *  - code → generated multi-root .code-workspace
 *  - kitty → one OS window with a tab per repo (session file)
 *  - terminal/finder → one window per repo */
/** Workspace names become filenames — keep them to one harmless path segment. */
function safeFileName(name: string): string {
  const safe = name.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_");
  if (!safe) throw new Error(`unusable workspace name: ${name}`);
  return safe;
}

export async function openGroup(
  app: OpenerId,
  name: string,
  paths: string[],
): Promise<void> {
  if (paths.length === 0) throw new Error("workspace has no repos");
  // A newline in a stored path would inject extra `launch` lines into the
  // kitty session file below, which kitty executes.
  for (const p of paths) {
    if (/[\r\n]/.test(p)) throw new Error(`invalid repo path: ${p}`);
  }
  const dir = join(configDir(), "workspaces");
  await mkdir(dir, { recursive: true });

  if (app === "code") {
    const file = join(dir, `${safeFileName(name)}.code-workspace`);
    const folders = paths.map((p) => ({ path: p }));
    await writeFile(file, JSON.stringify({ folders }, null, 2) + "\n");
    await openIn("code", file);
    return;
  }
  if (app === "kitty") {
    const file = join(dir, `${safeFileName(name)}.kitty-session`);
    const lines = paths
      .map((p) => `new_tab ${p.split("/").pop()}\ncd ${p}\nlaunch`)
      .join("\n");
    await writeFile(file, lines + "\n");
    const r = await exec(
      ["open", "-na", "kitty.app", "--args", "--session", file],
      { timeoutMs: 15_000 },
    );
    if (r.code !== 0) throw new Error(r.stderr.trim() || "failed to open kitty");
    return;
  }
  await Promise.all(paths.map((p) => openIn(app, p)));
}

export function isOpenerId(v: string): v is OpenerId {
  return (OPENER_IDS as readonly string[]).includes(v);
}
