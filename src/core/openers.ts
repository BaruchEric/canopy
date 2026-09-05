import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { claudeArgs } from "./agent";
import { exec } from "./exec";
import { openHerdr } from "./herdr";
import { parseLocator, shellLine, shellQuote } from "./host";
import { configDir } from "./store";
import { DEFAULT_AGENT, OPENER_IDS, type AgentSettings, type OpenerId } from "./types";

export { OPENER_IDS, type OpenerId };

/** Which settings a repo path gets; the group openers take one of these so
 *  every tab starts Claude the way its own repo says. */
export type AgentLookup = (path: string) => AgentSettings;

const defaultAgent: AgentLookup = () => DEFAULT_AGENT;

/** `claude` with the settings' flags, as one shell line. */
export const claudeLine = (agent: AgentSettings = DEFAULT_AGENT): string =>
  shellLine(["claude", ...claudeArgs(agent)]);

/* ---------- repos on another host: an ssh session in place of a cd ---------- */

/** What a terminal runs to land at a remote repo: the agent there, or the
 *  login shell. `-t` gets a tty so either is interactive. */
export function sshSessionArgs(
  host: string,
  path: string,
  what: "shell" | "agent",
  agent: AgentSettings = DEFAULT_AGENT,
): string[] {
  const cmd = what === "agent" ? claudeLine(agent) : 'exec "$SHELL" -l';
  return ["ssh", "-t", "--", host, `cd ${shellQuote(path)} && ${cmd}`];
}

/** VS Code's Remote-SSH folder form, for the workspace file and the CLI. */
export const remoteFolderUri = (host: string, path: string): string =>
  `vscode-remote://ssh-remote+${host}${path}`;

/** The openers that are a plain app: everything but the two that start Claude. */
type AppOpener = Exclude<OpenerId, "agent" | "herdr">;

function remoteCommandFor(app: AppOpener, host: string, path: string): string[] {
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

function commandFor(app: AppOpener, path: string): string[] {
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
export function agentShellCommand(
  shell = userShell(),
  agent: AgentSettings = DEFAULT_AGENT,
): string[] {
  return [shell, "-l", "-i", "-c", claudeLine(agent)];
}

/** A new kitty OS window at the repo running the agent. `--hold` keeps the
 *  window open, at a shell prompt, once the session ends. */
export function kittyAgentArgs(
  path: string,
  shell = userShell(),
  agent: AgentSettings = DEFAULT_AGENT,
): string[] {
  return [
    "open",
    "-na",
    "kitty.app",
    "--args",
    "--single-instance",
    "--hold",
    "--directory",
    path,
    ...agentShellCommand(shell, agent),
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
export function terminalAgentArgs(path: string, agent: AgentSettings = DEFAULT_AGENT): string[] {
  const { host, path: dir } = parseLocator(path);
  return terminalLineArgs(
    host === null
      ? `cd ${shellQuote(dir)} && ${claudeLine(agent)}`
      : sshSessionArgs(host, dir, "agent", agent).map(shellQuote).join(" "),
  );
}

async function openAgentInTerminal(path: string, agent: AgentSettings): Promise<void> {
  const t = await exec(terminalAgentArgs(path, agent), { timeoutMs: 15_000 });
  if (t.code !== 0) {
    throw new Error(t.stderr.trim() || "failed to open a terminal for the agent");
  }
}

/** A held kitty window running the agent wherever the repo is. */
function kittyAgentArgsFor(path: string, agent: AgentSettings): string[] {
  const { host, path: dir } = parseLocator(path);
  if (host === null) return kittyAgentArgs(dir, userShell(), agent);
  return [
    "open",
    "-na",
    "kitty.app",
    "--args",
    "--single-instance",
    "--hold",
    ...sshSessionArgs(host, dir, "agent", agent),
  ];
}

/** kitty first; when `open` cannot find it, Terminal. */
async function openAgent(path: string, agent: AgentSettings): Promise<void> {
  const k = await exec(kittyAgentArgsFor(path, agent), { timeoutMs: 15_000 });
  if (k.code === 0) return;
  await openAgentInTerminal(path, agent);
}

export async function openIn(
  app: OpenerId,
  path: string,
  agent: AgentSettings = DEFAULT_AGENT,
): Promise<void> {
  if (app === "agent") return openAgent(path, agent);
  if (app === "herdr") return openHerdr(path, agent);
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
 *  - herdr → one herdr workspace per repo, each running the agent
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
  agentFor: AgentLookup = defaultAgent,
): string {
  return (
    paths
      .map((p) => {
        const { host, path } = parseLocator(p);
        const name = path.split("/").pop();
        const agent = agentFor(p);
        const launch =
          app === "agent" ? `launch --hold ${agentShellCommand(shell, agent).join(" ")}` : "launch";
        if (host === null) return `new_tab ${name}\ncd ${path}\n${launch}`;
        // kitty splits launch lines like a shell, so the ssh line's quoting
        // survives; the tab opens an ssh session in place of a cd.
        const ssh = sshSessionArgs(host, path, app === "agent" ? "agent" : "shell", agent)
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
  agentFor: AgentLookup = defaultAgent,
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
    await writeFile(file, kittySessionLines(paths, app, userShell(), agentFor));
    const r = await exec(
      ["open", "-na", "kitty.app", "--args", "--session", file],
      { timeoutMs: 15_000 },
    );
    if (r.code === 0) return;
    if (app === "kitty") throw new Error(r.stderr.trim() || "failed to open kitty");
    await Promise.all(paths.map((p) => openAgentInTerminal(p, agentFor(p))));
    return;
  }
  if (app === "herdr") {
    // One at a time: herdr focuses each new workspace, and two creates racing
    // would leave the focus on whichever finished last.
    for (const p of paths) await openHerdr(p, agentFor(p));
    return;
  }
  await Promise.all(paths.map((p) => openIn(app, p)));
}

export function isOpenerId(v: string): v is OpenerId {
  return (OPENER_IDS as readonly string[]).includes(v);
}
