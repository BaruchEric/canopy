/**
 * The map of a repo (FR-070): canopy's copy of Floorplan (haydenschmitty/
 * floorplan, MIT, in lib/floorplan) draws a checkout's parts, files and
 * endpoints, each named and described in plain words, into the repo's own
 * `floorplan/` folder, which ignores itself in git. Floorplan's scripts do
 * the mechanical half (scan, build, layout, the health check); a canopy run
 * of the user's own claude, given the plugin with `--plugin-dir`, writes the
 * names and descriptions; the map's own server (`floorplan/serve.mjs`)
 * answers questions on it, and the page frames that server through a
 * preview slot, never at canopy's origin.
 *
 * This file is the pure half: the run's spec and prompt, how the scripts'
 * JSON reads, and the words a status is shown in. Browser-safe, so the page
 * and the CLI say the same thing. The Bun half is server/floorplan.ts.
 * Tested in floorplan.test.ts.
 */

import { TOOL_SETS, type ActionSpec } from "./actions";

/** the upstream release lib/floorplan holds (VENDOR.md says how to move it) */
export const FLOORPLAN_VERSION = "0.11.0";

/** a map run's action name, which the page and the CLI find it by */
export const FLOORPLAN_ACTION = "floorplan";

/** the map's folder at the checkout's root */
export const FLOORPLAN_FOLDER = "floorplan";

/** the skill's scripts a map run may start without asking: all but
 *  open.mjs, which canopy's own route stands in for */
export const FLOORPLAN_SCRIPTS = ["status", "scan", "build", "describe", "refresh", "recent", "plan"] as const;

/** what status.mjs reports: no map, architecture.json never built, a map,
 *  a blueprint (planned from a PRD) drawn or only started, or unreadable */
export type FloorplanState = "none" | "unbuilt" | "map" | "blueprint" | "blueprint-started" | "unknown";

const STATES: readonly FloorplanState[] = ["none", "unbuilt", "map", "blueprint", "blueprint-started", "unknown"];

/** A checkout's map as the route answers it. */
export interface FloorplanInfo {
  state: FloorplanState;
  /** when the map was last built (ISO), else null */
  builtAt: string | null;
  /** the files and top-level parts the map covers, else null */
  files: number | null;
  nodes: number | null;
  /** files changed in commits since the build, over the map's repos; null
   *  when no repo could be compared (no map, or no commit then or now) */
  changed: number | null;
  /** uncommitted changes now, over the same repos; null as above */
  uncommitted: number | null;
  /** why the status could not be read, with state `unknown` */
  error?: string;
  /** the map's own server, while one answers for this checkout */
  server: { port: number } | null;
  /** the canopy run making or updating the map, while one is going */
  run: string | null;
}

/** What `floorplanInfo` reads from status.mjs, before the server and run. */
export type FloorplanStatus = Omit<FloorplanInfo, "server" | "run">;

const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** status.mjs's `--json` (floorplan/status-result@1) as canopy keeps it.
 *  Anything it cannot read is state `unknown` with the reason. */
export function parseFloorplanStatus(raw: unknown): FloorplanStatus {
  const blank = { builtAt: null, files: null, nodes: null, changed: null, uncommitted: null };
  if (!isRecord(raw) || raw["schema"] !== "floorplan/status-result@1") return { state: "unknown", ...blank, error: "status.mjs said something canopy cannot read" };
  const state = STATES.find((s) => s === raw["state"]) ?? "unknown";
  const repos = Array.isArray(raw["repos"]) ? raw["repos"].filter(isRecord).filter((r) => r["compared"] === true) : [];
  const sum = (key: string): number | null => (repos.length === 0 ? null : repos.reduce((n, r) => n + (num(r[key]) ?? 0), 0));
  return {
    state,
    builtAt: typeof raw["builtAt"] === "string" ? raw["builtAt"] : null,
    files: num(raw["files"]),
    nodes: num(raw["nodes"]),
    changed: sum("changedFiles"),
    uncommitted: sum("uncommitted"),
    ...(state === "unknown" ? { error: typeof raw["error"] === "string" && raw["error"] ? raw["error"] : "status.mjs could not read the map" } : {}),
  };
}

/** A map's server as `floorplan/.cache/server.json` records it. */
export interface FloorplanServer {
  pid: number;
  port: number;
  token: string;
  hash: string;
}

/** server.json read back, or null when it is not one serve.mjs wrote. */
export function parseServerState(raw: unknown): FloorplanServer | null {
  if (!isRecord(raw)) return null;
  const pid = num(raw["pid"]);
  const port = num(raw["port"]);
  const { token, hash } = raw;
  if (pid === null || pid <= 0 || port === null || port <= 0 || port > 65535) return null;
  if (typeof token !== "string" || !token || typeof hash !== "string") return null;
  return { pid, port, token, hash };
}

/** A map run's start: where the skill is, where the checkout is, and what
 *  the user asked for. */
export interface FloorplanStart {
  /** the skill's folder in canopy's copy, which `${CLAUDE_SKILL_DIR}` names */
  skillDir: string;
  /** the checkout's real path: the codebase root, and the root of the rule
   *  that lets the run write `floorplan/` */
  root: string;
  /** a map (or a blueprint) is there to refresh */
  update: boolean;
  /** names and descriptions for developers, not the app's owner */
  developers?: boolean;
}

/** What a map run may do without asking: read, git's reads, the skill's
 *  scripts, the map's own lookups, and write inside `floorplan/`. Claude
 *  matches file rules on Edit alone, which covers Write too (a Write rule
 *  is refused with a note saying so), and `//` starts an absolute path. */
export function floorplanTools(skillDir: string, root: string): string[] {
  return [
    ...(TOOL_SETS["read"] ?? []),
    ...(TOOL_SETS["git-read"] ?? []),
    `Edit(/${root}/${FLOORPLAN_FOLDER}/**)`,
    ...FLOORPLAN_SCRIPTS.map((name) => `Bash(node ${skillDir}/scripts/${name}.mjs:*)`),
    `Bash(node ${FLOORPLAN_FOLDER}/query.mjs:*)`,
  ];
}

/** The task paragraph of a map run's prompt. The skill holds the method;
 *  this says which half of it applies and the three places canopy differs:
 *  canopy serves the map, no CLAUDE.local.md note, and nothing outside
 *  `floorplan/` is written or committed. */
export function floorplanTask(s: FloorplanStart): string {
  return [
    `Task: ${s.update ? "update this repository's floorplan" : "make a floorplan of this repository"} with the floorplan:floorplan skill, which canopy loaded for this run (Floorplan ${FLOORPLAN_VERSION}, from ${s.skillDir}). A floorplan is an interactive map of the app's parts, files and endpoints, each with a plain-English name and description, kept in floorplan/ at the repository root. Invoke the skill first and follow it.`,
    s.update
      ? `A map is there already: refresh it as the skill's "A map already exists?" section says, and describe only what refresh.mjs lists.`
      : "There is no map yet: follow the skill's first-run workflow.",
    `The codebase root is ${s.root}.`,
    "Three things differ from the skill's own steps here:",
    "- Skip open.mjs in step 8. canopy serves the map and shows it in this repository's map section once the build is done, so end with the report the skill asks for, without a URL.",
    "- Never add the CLAUDE.local.md note and do not offer it: run build.mjs without --claude-md.",
    "- Write only inside floorplan/, and commit nothing: the folder keeps itself out of git.",
    ...(s.developers ? [`Write the map for developers: set "audience": "developers" in architecture.json.`] : []),
  ].join("\n");
}

/** A map run's spec: an ask, read-mostly, whose prompt is the task above
 *  plus the user's note. Its turns are per reply, and one reply describes
 *  every file, so the cap is high. */
export function floorplanSpec(s: FloorplanStart): ActionSpec {
  return {
    label: s.update ? "update the map" : "make the map",
    verb: "map",
    blurb:
      "Claude reads the code with Floorplan's scripts and draws a map of its parts, files and endpoints, each named in plain words, into floorplan/ (kept out of git). It asks before running anything beyond reading, git's reads and Floorplan's own scripts.",
    notePlaceholder: "anything the map should know (optional)",
    noteRequired: false,
    allowedTools: floorplanTools(s.skillDir, s.root),
    maxTurns: 300,
    progress: "mapping",
    expectsChange: false,
    mode: "ask",
    task: floorplanTask(s),
  };
}

/** Whether a start would refresh a map rather than draw the first one. */
export const isUpdate = (state: FloorplanState): boolean => state === "map" || state === "blueprint" || state === "unbuilt" || state === "blueprint-started";

/** "make the map" or "update the map", for a button and the CLI's verb. */
export const startWord = (state: FloorplanState): string => (isUpdate(state) ? "update the map" : "make the map");

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One line for a checkout's map, as the section and `canopy floorplan`
 *  show it. `ago` words a time (the page's "3h ago", the CLI's own). */
export function floorplanLine(info: Pick<FloorplanInfo, "state" | "builtAt" | "files" | "nodes" | "changed" | "uncommitted" | "error">, ago: (iso: string) => string): string {
  const built = info.builtAt ? `, built ${ago(info.builtAt)}` : "";
  const size = info.files !== null && info.nodes !== null ? `${plural(info.files, "file")} in ${plural(info.nodes, "part")}` : "";
  switch (info.state) {
    case "none":
      return "no map yet";
    case "unbuilt":
      return "architecture.json is written but the map was never built";
    case "blueprint-started":
      return "a blueprint was started but never drawn";
    case "blueprint":
      return `a blueprint${size ? ` of ${size.replace("file", "planned file")}` : ""}${built}`;
    case "unknown":
      return `could not read the map${info.error ? `: ${info.error}` : ""}`;
    case "map": {
      const since = [
        info.changed ? `${plural(info.changed, "file")} changed since` : "",
        info.uncommitted ? `${info.uncommitted} uncommitted` : "",
      ].filter(Boolean);
      return `${size || "a map"}${built}${since.length ? `; ${since.join(", ")}` : ""}`;
    }
  }
}

/** The few words after the section's name: what state the map is in. */
export function floorplanHead(info: Pick<FloorplanInfo, "state" | "changed" | "run"> | null): string {
  if (!info) return "";
  if (info.run) return "mapping";
  switch (info.state) {
    case "map":
      return info.changed ? `${info.changed} changed` : "current";
    case "blueprint":
      return "blueprint";
    case "none":
      return "";
    case "unknown":
      return "unreadable";
    default:
      return "unfinished";
  }
}
