/** herdr (herdr.dev): a terminal workspace manager for coding agents, driven
 *  over its socket API through the `herdr` CLI. A repo opens as a herdr
 *  workspace at its folder with Claude started in the workspace's pane, the
 *  way the agent opener starts it in a kitty window; opening a repo that
 *  already has a workspace focuses that one. The argv builders and the JSON
 *  readers are pure and tested; `openHerdr` is the Bun side. */

import { existsSync } from "node:fs";
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { claudeArgs } from "./agent";
import { exec, type ExecResult } from "./exec";
import { parseLocator, shellLine, shellQuote } from "./host";
import { DEFAULT_AGENT, type AgentSettings } from "./types";

/** `herdr agent start` waits for Claude to come up; its own default is 30s. */
const START_TIMEOUT = 45_000;
const CALL_TIMEOUT = 15_000;
/** how long a fresh herdr gets to bring its server up */
const BOOT_TIMEOUT = 20_000;

/** Where the herdr binary is: on PATH, else where its installer puts it. */
export function herdrBinary(): string | null {
  const onPath = Bun.which("herdr");
  if (onPath) return onPath;
  const local = join(homedir(), ".local", "bin", "herdr");
  return existsSync(local) ? local : null;
}

/* ---------- pure: names, argv, and herdr's JSON ---------- */

/** A herdr agent name for a repo: `[a-z][a-z0-9_-]{0,31}`, unique among the
 *  live agents (herdr refuses a duplicate). */
export function herdrAgentName(repoName: string, taken: Iterable<string>): string {
  const base =
    repoName
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, "-")
      .replace(/^[^a-z]+/, "")
      .replace(/-+$/, "")
      .slice(0, 32) || "claude";
  const used = new Set(taken);
  if (!used.has(base)) return base;
  for (let n = 2; ; n++) {
    const suffix = `-${n}`;
    const name = `${base.slice(0, 32 - suffix.length)}${suffix}`;
    if (!used.has(name)) return name;
  }
}

/** `herdr agent start`: Claude, by name, in an existing pane at a shell
 *  prompt, with the settings' flags after `--` where herdr passes them on. */
export function herdrStartArgs(name: string, paneId: string, agent: AgentSettings): string[] {
  const flags = claudeArgs(agent);
  return [
    "agent",
    "start",
    name,
    "--kind",
    "claude",
    "--pane",
    paneId,
    ...(flags.length ? ["--", ...flags] : []),
  ];
}

/** What a herdr pane runs for a repo on another host: an ssh session that
 *  lands at the repo and starts Claude there. */
export function herdrRemoteLine(host: string, path: string, agent: AgentSettings): string {
  const claude = shellLine(["claude", ...claudeArgs(agent)]);
  return shellLine(["ssh", "-t", "--", host, `cd ${shellQuote(path)} && ${claude}`]);
}

export interface HerdrPane {
  pane_id: string;
  workspace_id: string;
  cwd: string;
  /** herdr's read of what runs there: "unknown" when no agent is detected */
  agent_status: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

const str = (o: Record<string, unknown>, k: string): string =>
  typeof o[k] === "string" ? o[k] : "";

/** The `result` object of a herdr CLI reply, or null for anything else. */
function result(json: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(json);
    return isRecord(parsed) && isRecord(parsed["result"]) ? parsed["result"] : null;
  } catch {
    return null;
  }
}

/** `herdr pane list` → every pane with the fields the lookup needs. */
export function parsePanes(json: string): HerdrPane[] {
  const r = result(json);
  const panes = r?.["panes"];
  if (!Array.isArray(panes)) return [];
  return panes.flatMap((p: unknown) =>
    isRecord(p) && str(p, "pane_id") && str(p, "workspace_id")
      ? [
          {
            pane_id: str(p, "pane_id"),
            workspace_id: str(p, "workspace_id"),
            cwd: str(p, "cwd"),
            agent_status: str(p, "agent_status") || "unknown",
          },
        ]
      : [],
  );
}

/** `herdr workspace create` → the new workspace and its first pane. */
export function parseCreated(json: string): { workspace: string; pane: string } | null {
  const r = result(json);
  if (!r) return null;
  const ws = isRecord(r["workspace"]) ? str(r["workspace"], "workspace_id") : "";
  const pane = isRecord(r["root_pane"]) ? str(r["root_pane"], "pane_id") : "";
  return ws && pane ? { workspace: ws, pane } : null;
}

/** `herdr agent list` → the names in use, so a new one can avoid them. */
export function parseAgentNames(json: string): string[] {
  const r = result(json);
  const agents = r?.["agents"];
  if (!Array.isArray(agents)) return [];
  return agents.flatMap((a: unknown) => (isRecord(a) && str(a, "name") ? [str(a, "name")] : []));
}

/* ---------- Bun: talking to herdr ---------- */

const tail = (r: ExecResult): string =>
  (r.stderr.trim() || r.stdout.trim()).split("\n").slice(-3).join("\n");

async function call(bin: string, args: string[], timeoutMs = CALL_TIMEOUT): Promise<ExecResult> {
  const r = await exec([bin, ...args], { timeoutMs });
  if (r.code !== 0) throw new Error(`herdr ${args.slice(0, 2).join(" ")}: ${tail(r) || `exit ${r.code}`}`);
  return r;
}

/** herdr's socket API answers only while its server runs; the server comes
 *  up with the first client. With none running, start one in a terminal
 *  (kitty, else Terminal) and wait for the socket. */
async function ensureServer(bin: string): Promise<void> {
  const probe = () => exec([bin, "pane", "list"], { timeoutMs: CALL_TIMEOUT });
  if ((await probe()).code === 0) return;
  const kitty = await exec(
    ["open", "-na", "kitty.app", "--args", "--single-instance", bin],
    { timeoutMs: CALL_TIMEOUT },
  );
  if (kitty.code !== 0) {
    const t = await exec(
      [
        "osascript",
        "-e",
        'tell application "Terminal"',
        "-e",
        `do script "${bin}"`,
        "-e",
        "activate",
        "-e",
        "end tell",
      ],
      { timeoutMs: CALL_TIMEOUT },
    );
    if (t.code !== 0) throw new Error("herdr is not running and no terminal could start it");
  }
  const until = Date.now() + BOOT_TIMEOUT;
  while (Date.now() < until) {
    await Bun.sleep(500);
    if ((await probe()).code === 0) return;
  }
  throw new Error("herdr did not come up in time");
}

/** Starts Claude in a pane. A pane that is not at a shell prompt (herdr
 *  checks) is left alone when `tolerate` is set: the workspace was already
 *  there, and whatever runs in it is the user's. herdr's own answer for a
 *  Claude that came up but stopped on a startup dialog is `agent_not_ready`,
 *  which is a running Claude, not a failure. */
async function startAgent(
  bin: string,
  repoName: string,
  paneId: string,
  agent: AgentSettings,
  tolerate = false,
): Promise<void> {
  const names = parseAgentNames((await exec([bin, "agent", "list"], { timeoutMs: CALL_TIMEOUT })).stdout);
  const name = herdrAgentName(repoName, names);
  const r = await exec([bin, ...herdrStartArgs(name, paneId, agent)], { timeoutMs: START_TIMEOUT });
  if (r.code === 0 || tolerate) return;
  const text = `${r.stdout}\n${r.stderr}`;
  if (text.includes("agent_not_ready")) return;
  throw new Error(`herdr could not start claude: ${tail(r) || `exit ${r.code}`}`);
}

async function sameFolder(a: string, b: string): Promise<boolean> {
  if (a === b) return true;
  const [ra, rb] = await Promise.all([
    realpath(a).catch(() => a),
    realpath(b).catch(() => b),
  ]);
  return ra === rb;
}

/** Opens the repo in herdr: focuses its workspace when one exists (starting
 *  Claude there if nothing runs in it), else creates one at the repo and
 *  starts Claude in it. A repo on another host gets a workspace whose pane
 *  runs the ssh session. */
export async function openHerdr(path: string, agent: AgentSettings = DEFAULT_AGENT): Promise<void> {
  const bin = herdrBinary();
  if (!bin) throw new Error("herdr is not installed (herdr.dev)");
  await ensureServer(bin);
  const { host, path: dir } = parseLocator(path);
  const name = dir.split("/").filter(Boolean).pop() ?? dir;

  if (host !== null) {
    const created = parseCreated(
      (await call(bin, ["workspace", "create", "--label", `${host}:${name}`, "--focus"])).stdout,
    );
    if (!created) throw new Error("herdr created a workspace but did not say which");
    await call(bin, ["pane", "run", created.pane, herdrRemoteLine(host, dir, agent)]);
    return;
  }

  const panes = parsePanes((await call(bin, ["pane", "list"])).stdout);
  for (const p of panes) {
    if (!p.cwd || !(await sameFolder(p.cwd, dir))) continue;
    await call(bin, ["workspace", "focus", p.workspace_id]);
    if (p.agent_status === "unknown") await startAgent(bin, name, p.pane_id, agent, true);
    return;
  }
  const created = parseCreated(
    (await call(bin, ["workspace", "create", "--cwd", dir, "--label", name, "--focus"])).stdout,
  );
  if (!created) throw new Error("herdr created a workspace but did not say which");
  await startAgent(bin, name, created.pane, agent);
}
