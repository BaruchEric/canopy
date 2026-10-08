/**
 * The helper protocol. `canopy helper` runs on a client machine (a laptop
 * next to a headless backend), dials the backend at `GET /api/helper` as a
 * websocket, and registers what it can open there: its name, platform and
 * openers ride in the query. From then on the backend sends it intents, one
 * JSON text frame each with an `id`, and the helper answers each with `ok`
 * or `error` under the same id. A browser names the helper that is its own
 * machine (`clientCaps` below decides what it can open), and a click there
 * lands on that helper. Nothing here touches a process; this is the wire
 * shape and the pure decisions, tested in helper.test.ts.
 */
import { HARNESSES, OPENER_IDS, type AgentSettings, type Harness, type HelperInfo, type OpenerId } from "./types";
import { normalizeAgent } from "./agent";
import { HARNESS } from "./harness";
import { parseLocator } from "./host";

export { clientCaps, clientKey, isLoopback, isLoopbackHost } from "./client";

/** what the backend asks of a helper: one opener at one repo, a file in
 *  VS Code, or a workspace of repos as one unit; `id` pairs the reply */
export type HelperIntent =
  | { id: number; open: { app: OpenerId; path: string; agent: AgentSettings; tab: boolean } }
  | { id: number; file: { path: string; file: string; line: number } }
  | {
      id: number;
      /** `primary` is where the agent opener starts; a backend from before
       *  it leaves it out, and the first member stands in */
      group: { app: OpenerId; name: string; repos: string[]; agents: Record<string, AgentSettings>; primary?: string };
    };

export type HelperReply = { id: number; ok: true } | { id: number; error: string };

/** an intent before the backend numbers it */
export type HelperAsk = HelperIntent extends infer T ? (T extends unknown ? Omit<T, "id"> : never) : never;

/** how long the backend waits for a helper to answer an intent */
export const HELPER_TIMEOUT = 20_000;

/** How often each end pings the other, and how long it goes unanswered
 *  before that end treats the socket as gone. A peer that dies with its host
 *  (a reboot, a pulled cable) sends no close frame, so the socket sits
 *  half-open and neither end hears anything again: the helper would keep
 *  believing it is registered and the backend would keep offering it. A ping
 *  is answered by the websocket layer itself, so the pong is proof the host
 *  on the other end is still there. */
export const HELPER_PING = 20_000;
export const HELPER_DEAD = 60_000;

/** the peers not heard from inside the deadline, by name; what a sweep drops */
export function staleHelpers<T extends { name: string; seen: number }>(peers: Iterable<T>, now: number, dead = HELPER_DEAD): string[] {
  const gone: string[] = [];
  for (const p of peers) if (now - p.seen > dead) gone.push(p.name);
  return gone;
}

const isOpener = (v: unknown): v is OpenerId => typeof v === "string" && (OPENER_IDS as readonly string[]).includes(v);

/** the registration off the socket's query: a name (up to 64 plain
 *  characters), a platform word, the openers as a comma list, each one
 *  canopy knows, and the harnesses it can start (absent from a helper older
 *  than harnesses; a name this backend does not know is passed over, a
 *  newer helper's); anything else is refused with a reason */
export function parseHelperQuery(params: URLSearchParams, address: string, now = Date.now()): HelperInfo | { error: string } {
  const name = (params.get("name") ?? "").trim();
  if (!name || name.length > 64 || !/^[\w.-]+$/.test(name)) return { error: "name= must be 1 to 64 letters, digits, dots or dashes" };
  const platform = (params.get("platform") ?? "").trim();
  if (!/^[a-z0-9]{1,16}$/.test(platform)) return { error: "platform= must be a platform word (darwin, linux)" };
  const openers: OpenerId[] = [];
  for (const raw of (params.get("openers") ?? "").split(",")) {
    const v = raw.trim();
    if (v === "") continue;
    if (!isOpener(v)) return { error: `openers= names an opener canopy does not know: ${v}` };
    if (!openers.includes(v)) openers.push(v);
  }
  const listed = params.get("harnesses");
  const harnesses =
    listed === null ? null : HARNESSES.filter((h) => listed.split(",").some((raw) => raw.trim() === h));
  return { name, platform, openers, ...(harnesses ? { harnesses } : {}), since: now, address };
}

/** The openers that start the agent, and so read an intent's harness. */
const STARTS_AGENT: readonly OpenerId[] = ["agent", "herdr"];

/** Why a helper must not be sent an intent, or null. A helper older than
 *  harnesses reads an intent's settings without their harness and keeps
 *  the rest, so a codex intent would start claude with codex's flags; it
 *  is refused here, in words that say what to do, rather than sent. */
export function helperRefusal(info: Pick<HelperInfo, "name" | "harnesses">, intent: HelperAsk): string | null {
  const needs: Harness[] =
    "open" in intent
      ? STARTS_AGENT.includes(intent.open.app) ? [intent.open.agent.harness] : []
      : "group" in intent && STARTS_AGENT.includes(intent.group.app)
        ? Object.values(intent.group.agents).map((a) => a.harness)
        : [];
  const missing = needs.find((h) => h !== "claude" && !(info.harnesses ?? []).includes(h));
  if (!missing) return null;
  return info.harnesses === undefined
    ? `the helper on ${info.name} is older than ${HARNESS[missing].label} support and would start claude in its place: update canopy there and restart canopy helper`
    : `the helper on ${info.name} cannot start ${HARNESS[missing].label}`;
}

/** a reply frame from the helper, or null for anything malformed */
export function parseHelperReply(text: string): HelperReply | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "number" || !Number.isInteger(o.id)) return null;
  if (o.ok === true) return { id: o.id, ok: true };
  if (typeof o.error === "string") return { id: o.id, error: o.error.slice(0, 500) };
  return null;
}

/** an intent frame as the helper reads it, or null for anything malformed;
 *  agent settings go through `normalizeAgent` field by field, so nothing off
 *  the wire reaches a claude command line as a flag */
export function parseHelperIntent(text: string): HelperIntent | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  if (typeof o.id !== "number") return null;
  const id = o.id;
  if (typeof o.open === "object" && o.open !== null) {
    const x = o.open as Record<string, unknown>;
    if (!isOpener(x.app) || typeof x.path !== "string") return null;
    return { id, open: { app: x.app, path: x.path, agent: normalizeAgent(x.agent), tab: x.tab === true } };
  }
  if (typeof o.file === "object" && o.file !== null) {
    const x = o.file as Record<string, unknown>;
    if (typeof x.path !== "string" || typeof x.file !== "string") return null;
    const line = typeof x.line === "number" && Number.isInteger(x.line) && x.line > 0 ? x.line : 1;
    return { id, file: { path: x.path, file: x.file, line } };
  }
  if (typeof o.group === "object" && o.group !== null) {
    const x = o.group as Record<string, unknown>;
    if (!isOpener(x.app) || typeof x.name !== "string" || !Array.isArray(x.repos)) return null;
    const repos = x.repos.filter((r): r is string => typeof r === "string");
    if (repos.length !== x.repos.length) return null;
    const agents: Record<string, AgentSettings> = {};
    if (typeof x.agents === "object" && x.agents !== null) {
      for (const [k, v] of Object.entries(x.agents as Record<string, unknown>)) agents[k] = normalizeAgent(v);
    }
    const primary = typeof x.primary === "string" && repos.includes(x.primary) ? { primary: x.primary } : {};
    return { id, group: { app: x.app, name: x.name, repos, agents, ...primary } };
  }
  return null;
}

/** Which openers a helper on a platform offers, given what is installed
 *  there (`has` answers for a command or app name). A Mac has Terminal and
 *  Finder always and the agent falls back to Terminal, so those three need
 *  nothing; kitty, the code CLI and herdr only when present. Linux has no
 *  Terminal.app or Finder: kitty carries the shell and the agent, xdg-open
 *  stands in for Finder, and herdr is a Mac app. */
export function helperOpeners(platform: string, has: (name: string) => boolean): OpenerId[] {
  if (platform === "darwin") {
    const out: OpenerId[] = [];
    if (has("kitty")) out.push("kitty");
    out.push("terminal");
    if (has("code")) out.push("code");
    out.push("finder", "agent");
    if (has("herdr")) out.push("herdr");
    return out;
  }
  if (platform === "linux") {
    const out: OpenerId[] = [];
    if (has("kitty")) out.push("kitty");
    if (has("code")) out.push("code");
    if (has("xdg-open")) out.push("finder");
    if (has("kitty")) out.push("agent");
    return out;
  }
  return [];
}

/** Where a helper finds a repo the backend holds: a repo local to the
 *  backend is reached over ssh through the backend's alias (`sshHost`, the
 *  same one the VS Code link uses), and a repo that is already on another
 *  host keeps its own locator, which the helper's ssh config must know. */
export function reachFrom(path: string, sshHost: string | null): string | { error: string } {
  const { host } = parseLocator(path);
  if (host !== null) return path;
  if (!sshHost) return { error: "the backend has no CANOPY_SSH_HOST, so a helper cannot reach its repos over ssh" };
  return `ssh://${sshHost}${path}`;
}

/** The default gateway out of `/proc/net/route` (Linux): the row whose
 *  destination is 0.0.0.0, its gateway a little-endian hex IPv4. A container
 *  behind docker's userland proxy sees that address as the source of every
 *  published-port connection, so a client there is not told apart by it. */
export function parseDefaultGateway(text: string): string | null {
  for (const line of text.split("\n").slice(1)) {
    const f = line.trim().split(/\s+/);
    if (f.length < 3 || f[1] !== "00000000") continue;
    const hex = f[2]!;
    if (!/^[0-9a-f]{8}$/i.test(hex)) continue;
    const octets: number[] = [];
    for (let i = 6; i >= 0; i -= 2) octets.push(parseInt(hex.slice(i, i + 2), 16));
    return octets.join(".");
  }
  return null;
}
