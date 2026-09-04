import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec } from "./exec";
import { parseLocator, shellQuote } from "./host";
import { configDir } from "./store";
import { OPENER_IDS, type OpenerId } from "./types";

export { OPENER_IDS, type OpenerId };

/* ---------- repos on another host: an ssh session in place of a cd ---------- */

/** What a terminal runs to land at a remote repo: the agent there, or the
 *  login shell. `-t` gets a tty so either is interactive. */
export function sshSessionArgs(
  host: string,
  path: string,
  what: "shell" | "agent",
): string[] {
  const cmd = what === "agent" ? "claude" : 'exec "$SHELL" -l';
  return ["ssh", "-t", "--", host, `cd ${shellQuote(path)} && ${cmd}`];
}

/** VS Code's Remote-SSH folder form, for the workspace file and the CLI. */
export const remoteFolderUri = (host: string, path: string): string =>
  `vscode-remote://ssh-remote+${host}${path}`;

function remoteCommandFor(
  app: Exclude<OpenerId, "agent">,
  host: string,
  path: string,
): string[] {
  switch (app) {
    case "kitty":
      return [
        "open",
        "-na",
        "kitty.app",
        "--args",
        "--single-instance",
        ...sshSessionArgs(host, path, "shell"),
      ];
    case "terminal":
      return terminalLineArgs(sshSessionArgs(host, path, "shell").map(shellQuote).join(" "));
    case "code":
      if (!Bun.which("code")) {
        throw new Error("the code CLI is not on PATH; a remote folder needs it");
      }
      return ["code", "--folder-uri", remoteFolderUri(host, path)];
    case "finder":
      throw new Error("Finder cannot show a folder on another host");
  }
}

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

function appleScriptString(s: string): string {
  return `"${s.replace(/[\\"]/g, (c) => `\\${c}`)}"`;
}

/** Terminal.app: a new window whose login shell runs `line`, quoted once
 *  more for AppleScript. */
function terminalLineArgs(line: string): string[] {
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

/** Terminal.app running the agent at the repo: the path is quoted for the
 *  shell, then the whole line for AppleScript. A remote repo gets an ssh
 *  session that runs the agent there instead. */
export function terminalAgentArgs(path: string): string[] {
  const { host, path: dir } = parseLocator(path);
  return terminalLineArgs(
    host === null
      ? `cd ${shellQuote(dir)} && claude`
      : sshSessionArgs(host, dir, "agent").map(shellQuote).join(" "),
  );
}

async function openAgentInTerminal(path: string): Promise<void> {
  const t = await exec(terminalAgentArgs(path), { timeoutMs: 15_000 });
  if (t.code !== 0) {
    throw new Error(t.stderr.trim() || "failed to open a terminal for the agent");
  }
}

/** A held kitty window running the agent wherever the repo is. */
function kittyAgentArgsFor(path: string): string[] {
  const { host, path: dir } = parseLocator(path);
  if (host === null) return kittyAgentArgs(dir);
  return [
    "open",
    "-na",
    "kitty.app",
    "--args",
    "--single-instance",
    "--hold",
    ...sshSessionArgs(host, dir, "agent"),
  ];
}

/** kitty first; when `open` cannot find it, Terminal. */
async function openAgent(path: string): Promise<void> {
  const k = await exec(kittyAgentArgsFor(path), { timeoutMs: 15_000 });
  if (k.code === 0) return;
  await openAgentInTerminal(path);
}

export async function openIn(app: OpenerId, path: string): Promise<void> {
  if (app === "agent") return openAgent(path);
  const { host, path: dir } = parseLocator(path);
  const cmd = host === null ? commandFor(app, dir) : remoteCommandFor(app, host, dir);
  const r = await exec(cmd, { timeoutMs: 15_000 });
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
    paths
      .map((p) => {
        const { host, path } = parseLocator(p);
        const name = path.split("/").pop();
        if (host === null) return `new_tab ${name}\ncd ${path}\n${launch}`;
        // kitty splits launch lines like a shell, so the ssh line's quoting
        // survives; the tab opens an ssh session in place of a cd.
        const ssh = sshSessionArgs(host, path, app === "agent" ? "agent" : "shell")
          .map(shellQuote)
          .join(" ");
        return `new_tab ${name}\nlaunch${app === "agent" ? " --hold" : ""} ${ssh}`;
      })
      .join("\n") + "\n"
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
    const folders = paths.map((p) => {
      const { host, path } = parseLocator(p);
      return host === null ? { path } : { uri: remoteFolderUri(host, path) };
    });
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
