import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "./exec";
import { configDir } from "./store";
import { OPENER_IDS, type OpenerId } from "./types";

export { OPENER_IDS, type OpenerId };

function commandFor(app: Exclude<OpenerId, "agent">, path: string): string[] {
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

/* ---------- the agent: Claude Code, interactive, in a terminal ---------- */

/** The user's login shell, or zsh, the macOS default, when the server was
 *  started without one (launchd sets no SHELL). */
function userShell(): string {
  return process.env.SHELL || "/bin/zsh";
}

/** Run `claude` through the login, interactive shell so the rc files apply:
 *  PATH, and any `claude` wrapper function they define. A terminal tab runs
 *  the same shell the same way; the session starts as it would from a prompt. */
export function agentShellCommand(shell = userShell()): string[] {
  return [shell, "-l", "-i", "-c", "claude"];
}

/** A new kitty OS window at the repo running the agent. `--hold` keeps the
 *  window open, at a shell prompt, once the session ends. */
export function kittyAgentArgs(path: string, shell = userShell()): string[] {
  return [
    "open",
    "-na",
    "kitty.app",
    "--args",
    "--single-instance",
    "--hold",
    "--directory",
    path,
    ...agentShellCommand(shell),
  ];
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function appleScriptString(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Terminal.app: a new window whose login shell runs the agent at the repo.
 *  The path is quoted for that shell, then the whole line for AppleScript. */
export function terminalAgentArgs(path: string): string[] {
  const line = `cd ${shellQuote(path)} && claude`;
  return [
    "osascript",
    "-e",
    'tell application "Terminal"',
    "-e",
    `do script ${appleScriptString(line)}`,
    "-e",
    "activate",
    "-e",
    "end tell",
  ];
}

async function openAgentInTerminal(path: string): Promise<void> {
  const t = await exec(terminalAgentArgs(path), { timeoutMs: 15_000 });
  if (t.code !== 0) {
    throw new Error(t.stderr.trim() || "failed to open a terminal for the agent");
  }
}

/** kitty first; when `open` cannot find it, Terminal. */
async function openAgent(path: string): Promise<void> {
  const k = await exec(kittyAgentArgs(path), { timeoutMs: 15_000 });
  if (k.code === 0) return;
  await openAgentInTerminal(path);
}

export async function openIn(app: OpenerId, path: string): Promise<void> {
  if (app === "agent") return openAgent(path);
  const r = await exec(commandFor(app, path), { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || `failed to open ${app}`);
}

/** Open a group of repos as one unit:
 *  - code → generated multi-root .code-workspace
 *  - kitty → one OS window with a tab per repo (session file)
 *  - agent → the same window, each tab running the agent; one Terminal
 *    window per repo when kitty is not installed
 *  - terminal/finder → one window per repo */
/** Workspace names become filenames — keep them to one harmless path segment. */
function safeFileName(name: string): string {
  const safe = name.replace(/[^\w.-]/g, "_").replace(/^\.+/, "_");
  if (!safe) throw new Error(`unusable workspace name: ${name}`);
  return safe;
}

/** The kitty session for a workspace: a tab per repo, each at its root and,
 *  for the agent, running it with the window held open afterwards. */
export function kittySessionLines(
  paths: string[],
  app: "kitty" | "agent",
  shell = userShell(),
): string {
  const launch =
    app === "agent" ? `launch --hold ${agentShellCommand(shell).join(" ")}` : "launch";
  return (
    paths.map((p) => `new_tab ${p.split("/").pop()}\ncd ${p}\n${launch}`).join("\n") +
    "\n"
  );
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
  if (app === "kitty" || app === "agent") {
    const file = join(dir, `${safeFileName(name)}.kitty-session`);
    await writeFile(file, kittySessionLines(paths, app));
    const r = await exec(
      ["open", "-na", "kitty.app", "--args", "--session", file],
      { timeoutMs: 15_000 },
    );
    if (r.code === 0) return;
    if (app === "kitty") throw new Error(r.stderr.trim() || "failed to open kitty");
    await Promise.all(paths.map(openAgentInTerminal));
    return;
  }
  await Promise.all(paths.map((p) => openIn(app, p)));
}

export function isOpenerId(v: string): v is OpenerId {
  return (OPENER_IDS as readonly string[]).includes(v);
}
