/**
 * The map of a repo, its Bun half (FR-070): runs canopy's copy of
 * Floorplan's scripts (lib/floorplan) against a checkout on this machine,
 * starts and stops a map's own server, and finds the node both need. The
 * run's spec, the JSON readers and the words are core/floorplan.ts.
 *
 * A map's server is the repo's `floorplan/serve.mjs`, which the build
 * writes from the skill's own copy. canopy starts it only while its bytes
 * (and those of the `page-safety.mjs` it imports) are canopy's copy's, so a
 * clone that commits a `floorplan/` of its own never runs its code here. It
 * listens on 127.0.0.1 only, from 4378 up, and stops itself two hours after
 * its last tab closes; the page reaches it through a preview slot.
 */

import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { claudeBinary } from "../core/claudedrive";
import { exec } from "../core/exec";
import {
  FLOORPLAN_FOLDER,
  FLOORPLAN_VERSION,
  parseFloorplanStatus,
  parseServerState,
  type FloorplanInfo,
  type FloorplanServer,
  type FloorplanStatus,
} from "../core/floorplan";
import { configDir } from "../core/store";

/** canopy's copy of the plugin, which a map run loads with --plugin-dir */
export const FLOORPLAN_PLUGIN = join(import.meta.dir, "../../lib/floorplan");
/** the skill inside it: `${CLAUDE_SKILL_DIR}`, and where the scripts are */
export const FLOORPLAN_SKILL = join(FLOORPLAN_PLUGIN, "skills", "floorplan");

/** A refusal the route answers 400 with: the words say what to do. */
export class FloorplanError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FloorplanError";
  }
}

/** where node usually is when the server's PATH is launchd's short one */
const NODE_PLACES = ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"];

/** The node Floorplan's scripts run on (Node 18 or later): one on PATH or in
 *  a usual place, else bun itself through a link named `node` under the
 *  config dir, since bun started by that name answers as node. */
export function floorplanNode(): string {
  const found = Bun.which("node") ?? NODE_PLACES.find((p) => existsSync(p));
  if (found) return found;
  const dir = join(configDir(), "floorplan", "bin");
  const link = join(dir, "node");
  try {
    mkdirSync(dir, { recursive: true });
    if (!lstatSync(link, { throwIfNoEntry: false })) symlinkSync(process.execPath, link);
  } catch {
    // a link that cannot be made leaves the bare word, which fails loudly
  }
  return link;
}

/** PATH for the scripts and a map run: node's folder and claude's ahead of
 *  the server's own, so `node` in the skill's commands and the map server's
 *  `claude -p` both resolve under a launchd server's short PATH. */
export function floorplanPath(node: string, claude: string | null, base: string): string {
  const dirs = [dirname(node), ...(claude ? [dirname(claude)] : []), ...base.split(":")].filter(Boolean);
  return [...new Set(dirs)].join(":");
}

/** The variables a map run and the scripts get: the PATH above, Claude
 *  named as the map's agent, and the map's waitlist question off. */
export function floorplanEnv(node = floorplanNode()): Record<string, string> {
  return {
    PATH: floorplanPath(node, claudeBinary(), process.env["PATH"] ?? ""),
    FLOORPLAN_AGENT: "claude",
    FLOORPLAN_NO_PROMPTS: "1",
  };
}

/** One of the skill's scripts, from the checkout, with unattended mode left
 *  to the caller: the server's own env never turns it on, since open.mjs
 *  starts nothing under it. */
async function runScript(name: string, args: string[], root: string, timeoutMs: number) {
  const node = floorplanNode();
  const base: Record<string, string | undefined> = { ...process.env };
  delete base["FLOORPLAN_UNATTENDED"];
  return exec([node, join(FLOORPLAN_SKILL, "scripts", name), root, ...args], { cwd: root, timeoutMs, base, env: floorplanEnv(node) });
}

const lastLine = (s: string): string => s.trim().split("\n").pop() ?? "";

/** status.mjs's word on the checkout's map. Unattended, so its git reads
 *  take no optional locks; it never fails, and a run that cannot be read
 *  comes back as state `unknown` with the reason. */
export async function readFloorplanStatus(root: string): Promise<FloorplanStatus> {
  const r = await runScript("status.mjs", ["--json", "--unattended"], root, 20_000);
  try {
    const raw: unknown = JSON.parse(r.stdout);
    return parseFloorplanStatus(raw);
  } catch {
    return { state: "unknown", builtAt: null, files: null, nodes: null, changed: null, uncommitted: null, error: lastLine(r.stderr) || `status.mjs exited ${r.code}` };
  }
}

const stateFile = (root: string): string => join(root, FLOORPLAN_FOLDER, ".cache", "server.json");

function readServer(root: string): FloorplanServer | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(stateFile(root), "utf8"));
    return parseServerState(raw);
  } catch {
    return null;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err instanceof Error && "code" in err && err.code === "EPERM";
  }
}

/** The checkout's map server when one answers: its pid alive and its
 *  /api/status naming this root and that pid, so a pid the system gave to
 *  something else since is never taken for it. */
export async function liveServer(root: string): Promise<FloorplanServer | null> {
  const s = readServer(root);
  if (!s || !alive(s.pid)) return null;
  try {
    const r = await fetch(`http://127.0.0.1:${s.port}/api/status`, { headers: { "x-floorplan-token": s.token }, signal: AbortSignal.timeout(2_000) });
    if (!r.ok) return null;
    const body: unknown = await r.json();
    if (typeof body !== "object" || body === null) return null;
    return "root" in body && body.root === root && "pid" in body && body.pid === s.pid ? s : null;
  } catch {
    return null;
  }
}

/** The checkout's real path, which serve.mjs reports as its root. */
export const realRoot = (root: string): string => {
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
};

/** A checkout's map: status.mjs's word, its server and the run at it. */
export async function floorplanInfo(root: string, run: string | null): Promise<FloorplanInfo> {
  const real = realRoot(root);
  const [status, server] = await Promise.all([readFloorplanStatus(real), liveServer(real)]);
  return { ...status, server: server ? { port: server.port } : null, run };
}

function sameBytes(a: string, b: string): boolean {
  try {
    return readFileSync(a).equals(readFileSync(b));
  } catch {
    return false;
  }
}

/** The files next to a map that run when its server starts, which must be
 *  canopy's copy's byte for byte. */
const SERVED = ["serve.mjs", "page-safety.mjs"];

/** Starts the checkout's map server, or finds the one already up, through
 *  the skill's own open.mjs (which restarts a server whose serve.mjs
 *  changed), and answers its port. */
export async function openFloorplan(root: string): Promise<{ port: number }> {
  const real = realRoot(root);
  const dir = join(real, FLOORPLAN_FOLDER);
  if (!existsSync(join(dir, "index.html"))) throw new FloorplanError("there is no map here yet: make it first");
  const other = SERVED.find((name) => !sameBytes(join(dir, name), join(FLOORPLAN_SKILL, "assets", name)));
  if (other) {
    throw new FloorplanError(`floorplan/${other} is not the one canopy's Floorplan ${FLOORPLAN_VERSION} writes, so canopy will not start it; update the map, which writes it again`);
  }
  const r = await runScript("open.mjs", ["--no-open"], real, 45_000);
  if (r.code !== 0) throw new Error(lastLine(r.stderr) || lastLine(r.stdout) || `open.mjs exited ${r.code}`);
  const s = await liveServer(real);
  if (!s) throw new Error("the map's server did not answer; its log is floorplan/.cache/server.log");
  return { port: s.port };
}

/** how long a map server gets to end after SIGTERM before SIGKILL */
const STOP_GRACE = 3_000;

/** Stops the checkout's map server and answers once it is gone, so a read
 *  straight after finds none and the page does not frame it again; false
 *  when none was up. */
export async function stopFloorplan(root: string): Promise<boolean> {
  const s = await liveServer(realRoot(root));
  if (!s) return false;
  const gone = async (ms: number): Promise<boolean> => {
    for (const end = Date.now() + ms; Date.now() < end; await Bun.sleep(50)) if (!alive(s.pid)) return true;
    return !alive(s.pid);
  };
  try {
    process.kill(s.pid, "SIGTERM");
    if (!(await gone(STOP_GRACE))) {
      process.kill(s.pid, "SIGKILL");
      await gone(1_000);
    }
  } catch {
    // it ended between the check and the signal
  }
  return true;
}
