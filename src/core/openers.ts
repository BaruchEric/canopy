import { existsSync } from "node:fs";
import { lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentArgv, HARNESS, presentHarnesses, type AgentEnv } from "./harness";
import { exec } from "./exec";
import { openHerdr } from "./herdr";
import { parseLocator, shellLine, shellQuote } from "./host";
import { configDir } from "./store";
import { DEFAULT_AGENT, OPENER_IDS, type AgentSettings, type Backend, type Harness, type OpenerId } from "./types";

export { OPENER_IDS, type OpenerId };

/** Which settings a repo path gets; the group openers take one of these so
 *  every tab starts its agent the way its own repo says. */
export type AgentLookup = (path: string) => AgentSettings;

const defaultAgent: AgentLookup = () => DEFAULT_AGENT;

/** The settings' harness with their flags, as one shell line, with the
 *  first message after them when there is one (both harnesses take it as a
 *  positional argument). `env` is what the agent's own commands are to see
 *  (a canopy shell's TAILCHAN_AS), for a harness that does not pass the
 *  shell's environment on by itself. */
export const agentLine = (agent: AgentSettings = DEFAULT_AGENT, prompt?: string, env: AgentEnv = {}): string =>
  shellLine([...agentArgv(agent, env), ...(prompt ? [prompt] : [])]);

/* ---------- repos on another host: an ssh session in place of a cd ---------- */

/** What a terminal runs to land at a remote repo: the agent there, or the
 *  login shell. `-t` gets a tty so either is interactive. */
export function sshSessionArgs(
  host: string,
  path: string,
  what: "shell" | "agent",
  agent: AgentSettings = DEFAULT_AGENT,
): string[] {
  const cmd = what === "agent" ? agentLine(agent) : 'exec "$SHELL" -l';
  return ["ssh", "-t", "--", host, `cd ${shellQuote(path)} && ${cmd}`];
}

/** VS Code's Remote-SSH folder form, for the workspace file and the CLI. */
export const remoteFolderUri = (host: string, path: string): string =>
  `vscode-remote://ssh-remote+${host}${path}`;

/** VS Code at one file and line: `-g path:line` here, the same behind
 *  `--remote` for a repo on another host so the Remote-SSH window opens it. */
export function fileOpenArgs(
  host: string | null,
  repoPath: string,
  file: string,
  line: number,
): string[] {
  const target = `${repoPath}/${file}:${line}`;
  return host === null
    ? ["code", "-g", target]
    : ["code", "--remote", `ssh-remote+${host}`, "-g", target];
}

/** Open a file of a repo at a line in VS Code, wherever the repo lives. */
export async function openFile(repoPath: string, file: string, line: number): Promise<void> {
  if (!Bun.which("code")) throw new Error("the code CLI is not on PATH; opening a file needs it");
  const { host, path } = parseLocator(repoPath);
  const r = await exec(fileOpenArgs(host, path, file, line), { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "failed to open the file");
}

/** The openers that are a plain app: everything but the two that start an agent. */
export type AppOpener = Exclude<OpenerId, "agent" | "herdr">;

/** How the terminal openers (kitty, Terminal, and the agent in either) place
 *  a repo: a new OS window, or a tab in the front window. */
export interface OpenOptions {
  tab?: boolean;
}

/* ---------- kitty tabs: remote control over a socket ---------- */

/** Where a kitty that canopy starts listens. kitty appends its pid to the
 *  name, so lookups go by prefix. */
const kittySocketPrefix = (): string => join(configDir(), "kitty.sock");

/** Flags for every kitty window canopy opens: one kitty instance of its own
 *  (a plain --single-instance would hand the window to the user's kitty,
 *  which ignores the rest of these flags) that listens on a socket in the
 *  config dir, socket-only, so a later tab can reach it. */
export const kittyInstanceArgs = (prefix = kittySocketPrefix()): string[] => [
  "--single-instance",
  "--instance-group",
  "canopy",
  "--listen-on",
  `unix:${prefix}`,
  "-o",
  "allow_remote_control=socket-only",
];

/** The kitten binary: on PATH, else inside the app bundle. */
const kittenBin = (): string =>
  Bun.which("kitten") ?? "/Applications/kitty.app/Contents/MacOS/kitten";

/** Sockets a running kitty may answer on: canopy's own, and /tmp/kitty*,
 *  the convention kitty.conf's listen_on example sets up. */
async function kittySocketCandidates(): Promise<string[]> {
  const found: string[] = [];
  const places: Array<[string, string]> = [
    [configDir(), "kitty.sock"],
    ["/tmp", "kitty"],
  ];
  for (const [dir, prefix] of places) {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      continue;
    }
    for (const name of names) {
      if (!name.startsWith(prefix)) continue;
      const p = join(dir, name);
      try {
        if ((await lstat(p)).isSocket()) found.push(p);
      } catch {
        // gone between readdir and stat
      }
    }
  }
  return found;
}

/** The first socket a kitty answers on, or null when none is reachable: no
 *  kitty running, or one started without remote control. */
async function kittySocket(): Promise<string | null> {
  const kitten = kittenBin();
  for (const sock of await kittySocketCandidates()) {
    const r = await exec([kitten, "@", "--to", `unix:${sock}`, "ls"], { timeoutMs: 3_000 });
    if (r.code === 0) return sock;
  }
  return null;
}

/** `kitten @ launch` for a tab in the front kitty window: at `dir` running
 *  the shell, or running `cmd` (held open afterwards when asked). A remote
 *  repo passes no dir and an ssh line as the command. */
export function kittyTabArgs(
  kitten: string,
  sock: string,
  dir: string | null,
  cmd: string[] = [],
  hold = false,
): string[] {
  return [
    kitten,
    "@",
    "--to",
    `unix:${sock}`,
    "launch",
    "--type=tab",
    ...(dir === null ? [] : [`--cwd=${dir}`]),
    ...(hold ? ["--hold"] : []),
    ...cmd,
  ];
}

async function kittyTab(sock: string, dir: string | null, cmd: string[], hold: boolean) {
  const r = await exec(kittyTabArgs(kittenBin(), sock, dir, cmd, hold), { timeoutMs: 15_000 });
  if (r.code !== 0) throw new Error(r.stderr.trim() || "kitty refused the tab");
  // launch adds the tab; this brings the window forward
  await exec(["open", "-a", "kitty.app"], { timeoutMs: 5_000 });
}

function remoteCommandFor(app: AppOpener, host: string, path: string, tab = false): string[] {
  switch (app) {
    case "kitty":
      return [
        "open",
        "-na",
        "kitty.app",
        "--args",
        ...kittyInstanceArgs(),
        ...sshSessionArgs(host, path, "shell"),
      ];
    case "terminal":
      return terminalLineArgs(sshSessionArgs(host, path, "shell").map(shellQuote).join(" "), tab);
    case "code":
      if (!Bun.which("code")) {
        throw new Error("the code CLI is not on PATH; a remote folder needs it");
      }
      return ["code", "--folder-uri", remoteFolderUri(host, path)];
    case "finder":
      throw new Error("Finder cannot show a folder on another host");
  }
}

function commandFor(app: AppOpener, path: string, tab = false): string[] {
  switch (app) {
    case "kitty":
      return [
        "open",
        "-na",
        "kitty.app",
        "--args",
        ...kittyInstanceArgs(),
        "--directory",
        path,
      ];
    case "terminal":
      return tab
        ? terminalLineArgs(`cd ${shellQuote(path)}`, true)
        : ["open", "-a", "Terminal", path];
    case "code":
      return Bun.which("code")
        ? ["code", path]
        : ["open", "-a", "Visual Studio Code", path];
    case "finder":
      return ["open", path];
  }
}

/* ---------- the same openers on a Linux desktop (a helper there) ---------- */

/** kitty on Linux is a plain binary: `--detach` returns at once the way
 *  `open` does on a Mac, and the instance flags are the same. Terminal.app
 *  and Finder have no Linux; the "finder" opener is `xdg-open` on the
 *  folder, and "terminal" is refused, since which terminal a Linux desktop
 *  has is anyone's guess and kitty is the one canopy drives. */
export function linuxCommandFor(app: AppOpener, path: string, instance = kittyInstanceArgs()): string[] {
  switch (app) {
    case "kitty":
      return ["kitty", "--detach", ...instance, "--directory", path];
    case "code":
      return ["code", path];
    case "finder":
      return ["xdg-open", path];
    case "terminal":
      throw new Error("Terminal.app is a Mac app; use kitty on Linux");
  }
}

export function linuxRemoteCommandFor(
  app: AppOpener,
  host: string,
  path: string,
  instance = kittyInstanceArgs(),
): string[] {
  switch (app) {
    case "kitty":
      return ["kitty", "--detach", ...instance, ...sshSessionArgs(host, path, "shell")];
    case "code":
      return ["code", "--folder-uri", remoteFolderUri(host, path)];
    case "finder":
      throw new Error("xdg-open cannot show a folder on another host");
    case "terminal":
      throw new Error("Terminal.app is a Mac app; use kitty on Linux");
  }
}

/** A held kitty window running the agent, here or over ssh, on Linux. */
export function linuxAgentArgs(
  path: string,
  agent: AgentSettings = DEFAULT_AGENT,
  shell = userShell(),
  instance = kittyInstanceArgs(),
): string[] {
  const { host, path: dir } = parseLocator(path);
  const cmd = host === null
    ? ["--directory", dir, ...agentShellCommand(shell, agent)]
    : sshSessionArgs(host, dir, "agent", agent);
  return ["kitty", "--detach", ...instance, "--hold", ...cmd];
}

/** The platform the openers build for; the server and the helper each run
 *  them where they are, so this is the process's own. */
const platform = (): string => process.platform;

/* ---------- the agent: the repo's harness, interactive, in a terminal ---------- */

/** The user's login shell, or the platform's default when the server was
 *  started without one: zsh on a Mac (launchd sets no SHELL), bash elsewhere
 *  (a container has no zsh, and a shell that is not there exits at once, so
 *  every tmux session would die at birth). */
export function userShell(): string {
  return process.env.SHELL || (process.platform === "darwin" ? "/bin/zsh" : "/bin/bash");
}

/** Run the agent through the login, interactive shell so the rc files
 *  apply: PATH, and any `claude` or `codex` wrapper function they define. A
 *  terminal tab runs the same shell the same way; the session starts as it
 *  would from a prompt. */
export function agentShellCommand(
  shell = userShell(),
  agent: AgentSettings = DEFAULT_AGENT,
): string[] {
  return [shell, "-l", "-i", "-c", agentLine(agent)];
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
    ...kittyInstanceArgs(),
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
 *  more for AppleScript. As a tab: Terminal's dictionary has no "new tab",
 *  so the script presses cmd-t in the front window and runs the line in
 *  the tab that appears (which needs Accessibility access for the sender);
 *  with no window open it falls back to a new one. */
export function terminalLineArgs(line: string, tab = false): string[] {
  const script = appleScriptString(line);
  const lines = tab
    ? [
        'tell application "Terminal"',
        "activate",
        "if (count of windows) is 0 then",
        `do script ${script}`,
        "else",
        'tell application "System Events" to keystroke "t" using command down',
        "delay 0.4",
        `do script ${script} in front window`,
        "end if",
        "end tell",
      ]
    : ['tell application "Terminal"', `do script ${script}`, "activate", "end tell"];
  return ["osascript", ...lines.flatMap((l) => ["-e", l])];
}

/** Terminal.app running the agent at the repo: the path is quoted for the
 *  shell, then the whole line for AppleScript. A remote repo gets an ssh
 *  session that runs the agent there instead. */
export function terminalAgentArgs(
  path: string,
  agent: AgentSettings = DEFAULT_AGENT,
  tab = false,
): string[] {
  const { host, path: dir } = parseLocator(path);
  return terminalLineArgs(
    host === null
      ? `cd ${shellQuote(dir)} && ${agentLine(agent)}`
      : sshSessionArgs(host, dir, "agent", agent).map(shellQuote).join(" "),
    tab,
  );
}

async function openAgentInTerminal(path: string, agent: AgentSettings, tab = false): Promise<void> {
  const t = await exec(terminalAgentArgs(path, agent, tab), { timeoutMs: 15_000 });
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
    ...kittyInstanceArgs(),
    "--hold",
    ...sshSessionArgs(host, dir, "agent", agent),
  ];
}

/** What a kitty tab at the repo runs: nothing (the shell at `dir`) or the
 *  agent, here or over ssh. */
function kittyTabPlan(
  path: string,
  what: "shell" | "agent",
  agent: AgentSettings,
): { dir: string | null; cmd: string[] } {
  const { host, path: dir } = parseLocator(path);
  if (host !== null) return { dir: null, cmd: sshSessionArgs(host, dir, what, agent) };
  return { dir, cmd: what === "agent" ? agentShellCommand(userShell(), agent) : [] };
}

/** A tab in a reachable kitty, or false when there is none to add it to. */
async function tryKittyTab(path: string, what: "shell" | "agent", agent: AgentSettings) {
  const sock = await kittySocket();
  if (sock === null) return false;
  const { dir, cmd } = kittyTabPlan(path, what, agent);
  await kittyTab(sock, dir, cmd, what === "agent");
  return true;
}

/** kitty first; when `open` cannot find it, Terminal. As a tab: a kitty
 *  that answers gets the tab; otherwise a new kitty window that will answer
 *  next time, and Terminal only when kitty is not installed. */
async function openAgent(path: string, agent: AgentSettings, tab = false): Promise<void> {
  if (tab && (await tryKittyTab(path, "agent", agent))) return;
  if (platform() !== "darwin") {
    if (!Bun.which("kitty")) throw new Error("the agent needs kitty on PATH here");
    const r = await exec(linuxAgentArgs(path, agent), { timeoutMs: 15_000 });
    if (r.code !== 0) throw new Error(r.stderr.trim() || "failed to open kitty for the agent");
    return;
  }
  const k = await exec(kittyAgentArgsFor(path, agent), { timeoutMs: 15_000 });
  if (k.code === 0) return;
  await openAgentInTerminal(path, agent, tab);
}

export async function openIn(
  app: OpenerId,
  path: string,
  agent: AgentSettings = DEFAULT_AGENT,
  opts: OpenOptions = {},
): Promise<void> {
  const tab = opts.tab === true;
  if (app === "agent") return openAgent(path, agent, tab);
  if (app === "herdr") return openHerdr(path, agent);
  if (app === "kitty" && tab && (await tryKittyTab(path, "shell", agent))) return;
  const { host, path: dir } = parseLocator(path);
  const mac = platform() === "darwin";
  const cmd = host === null
    ? mac ? commandFor(app, dir, tab) : linuxCommandFor(app, dir)
    : mac ? remoteCommandFor(app, host, dir, tab) : linuxRemoteCommandFor(app, host, dir);
  if (!mac && !Bun.which(cmd[0]!)) throw new Error(`${cmd[0]} is not on PATH here`);
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
        // kitty splits a launch line like a shell, so the agent line has to
        // stay one quoted word, or `-c` gets the binary and every flag after
        // it becomes the shell's own arguments
        const launch =
          app === "agent" ? `launch --hold ${shellLine(agentShellCommand(shell, agent))}` : "launch";
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
    const mac = platform() === "darwin";
    if (!mac && !Bun.which("kitty")) throw new Error("a workspace of shells needs kitty on PATH here");
    const r = await exec(
      mac ? ["open", "-na", "kitty.app", "--args", "--session", file] : ["kitty", "--detach", "--session", file],
      { timeoutMs: 15_000 },
    );
    if (r.code === 0) return;
    if (app === "kitty" || !mac) throw new Error(r.stderr.trim() || "failed to open kitty");
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

/** Whether this backend host can run the desktop openers and the launcher.
 *  They are macOS `open`/`osascript` commands, so only a mac desktop can; a
 *  Linux container (the shared backend) cannot, and both the UI and the open
 *  routes hide or refuse them there. VS Code becomes a client-side Remote-SSH
 *  link instead, which the browser opens wherever it runs. `CANOPY_NO_DESKTOP=1`
 *  forces the headless behaviour on a mac, to try the shared-backend UI. */
export const hostOpeners = (): boolean =>
  process.env["CANOPY_NO_DESKTOP"] !== "1" && process.platform === "darwin";

/** Where a harness's installer puts its binary, for a server started with
 *  a short PATH (launchd's): the shells it types into are login shells,
 *  which find it there even when this process would not. */
const HARNESS_DIRS = [".local/bin", ".bun/bin", ".npm-global/bin"];
const SYSTEM_DIRS = ["/opt/homebrew/bin", "/usr/local/bin"];

/** Whether an agent harness's binary is here: on PATH, or where its
 *  installers put it. */
export function hasBinary(binary: string): boolean {
  if (Bun.which(binary)) return true;
  const home = homedir();
  return [...HARNESS_DIRS.map((d) => join(home, d)), ...SYSTEM_DIRS].some((d) => existsSync(join(d, binary)));
}

/** The harnesses this backend can start. */
export const availableHarnesses = (): Harness[] => presentHarnesses(hasBinary);

/** The refusal for a start on a harness a machine lacks, in the words the
 *  UI shows: "codex is not installed on mini". */
export const missingHarness = (h: Harness, machine: string): string => `${HARNESS[h].label} is not installed on ${machine}`;

/** What this backend advertises to its clients: whether the desktop openers
 *  work here, the ssh alias a client reaches it at for VS Code Remote-SSH
 *  (`CANOPY_SSH_HOST`, unset means no VS Code link), and which agent
 *  harnesses it has. */
export const backendCaps = (harnesses: Harness[] = availableHarnesses()): Backend => ({
  openers: hostOpeners(),
  sshHost: process.env.CANOPY_SSH_HOST || null,
  harnesses,
});
