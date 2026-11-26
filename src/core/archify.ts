/**
 * Diagrams of a repo with Archify (FR-071): canopy's copy of Archify
 * (tt-a1i/archify, Apache-2.0 at the release canopy pins, in lib/archify) turns a checkout, or a
 * question about it, into a checked standalone HTML diagram: architecture,
 * workflow, sequence, data flow, lifecycle, ERD, class, tree, timeline,
 * waterfall, or a one-page explainer. A canopy run of the user's own claude,
 * given the plugin with `--plugin-dir`, reads the code, writes the diagram's
 * JSON and runs Archify's `finalize`, which renders and checks it. Each
 * diagram has a folder of its own under the repo's `.archify/`, which keeps
 * itself out of git. The map section lists them beside the Floorplan map
 * and frames one in a sandboxed iframe, so its scripts run at an opaque
 * origin and never at canopy's.
 *
 * This file is the pure half: the run's spec and prompt, the folder names,
 * how finalize's receipt reads, and the words a list is shown in.
 * Browser-safe, so the page and the CLI say the same thing. The Bun half is
 * server/archify.ts. Tested in archify.test.ts.
 */

import { TOOL_SETS, type ActionSpec } from "./actions";

/** the upstream release lib/archify holds (VENDOR.md says how to move it) */
export const ARCHIFY_VERSION = "3.3.2";

/** a diagram run's action name, which the page and the CLI find it by */
export const ARCHIFY_ACTION = "archify";

/** the diagrams' folder at the checkout's root, Archify's own default */
export const ARCHIFY_FOLDER = ".archify";

/** what Archify draws: its ten native diagrams and the one-page explainer */
export const ARCHIFY_TYPES = ["architecture", "workflow", "sequence", "dataflow", "lifecycle", "erd", "class", "tree", "timeline", "waterfall", "explainer"] as const;
export type ArchifyType = (typeof ARCHIFY_TYPES)[number];

/** a start's type: one of the above, or `auto` for the run to choose */
export type ArchifyPick = ArchifyType | "auto";

export const isArchifyType = (v: unknown): v is ArchifyType => typeof v === "string" && (ARCHIFY_TYPES as readonly string[]).includes(v);
export const isArchifyPick = (v: unknown): v is ArchifyPick => v === "auto" || isArchifyType(v);

/** What finalize's receipt says of a diagram: every gate passed, all but
 *  the browser check passed because this machine has no Chrome, or a gate
 *  failed. */
export type ArchifyChecks = "pass" | "browser-skipped" | "fail";

/** One diagram: a folder under `.archify/` holding at least one HTML page. */
export interface ArchifyDiagram {
  /** the folder's name, which names the diagram in the route and the CLI */
  id: string;
  /** the page's file name inside the folder */
  file: string;
  /** the page's <title>, else null */
  title: string | null;
  /** what kind of diagram, from finalize's receipt or the folder's name */
  type: ArchifyType | null;
  bytes: number;
  /** when the page was last written, unix ms */
  builtAt: number;
  /** finalize's verdict, else null when no receipt is there */
  checks: ArchifyChecks | null;
  /** the repo tracks the folder, so canopy will not remove it */
  tracked?: true;
}

/** A checkout's diagrams as the route answers them. */
export interface ArchifyInfo {
  /** newest first */
  diagrams: ArchifyDiagram[];
  /** the canopy run drawing or revising one, while one is going */
  run: string | null;
}

/** the most a diagram's page may weigh before canopy refuses to send it */
export const ARCHIFY_HTML_MAX = 32 * 1024 * 1024;

/** A folder or file name canopy reads, writes or removes: one plain part,
 *  so no `..`, slash, backslash or NUL ever reaches a path join. */
export const isPlainName = (name: string): boolean => /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(name) && !name.includes("..");

/** A page in a diagram's folder, by name. */
export const isPageName = (name: string): boolean => isPlainName(name) && name.endsWith(".html");

/** Words cut into a folder-name slug: lowercase letters, digits and single
 *  dashes, at most 32 characters, cut at a dash where it can be. */
export function slugOf(words: string): string {
  const flat = words
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (flat.length <= 32) return flat;
  const cut = flat.slice(0, 33);
  const dash = cut.lastIndexOf("-");
  return (dash >= 12 ? cut.slice(0, dash) : flat.slice(0, 32)).replace(/-+$/, "");
}

const two = (n: number): string => String(n).padStart(2, "0");

/** A new diagram's folder, as the skill names one:
 *  `<type>-<slug>-<YYYYMMDD-HHMMSS>` in local time, the slug from the note
 *  or else the repo's name, and `diagram` for a type the run will choose. */
export function archifyFolder(type: ArchifyPick, note: string, repoName: string, now: Date): string {
  const slug = slugOf(note) || slugOf(repoName) || "repo";
  const stamp = `${now.getFullYear()}${two(now.getMonth() + 1)}${two(now.getDate())}-${two(now.getHours())}${two(now.getMinutes())}${two(now.getSeconds())}`;
  return `${type === "auto" ? "diagram" : type}-${slug}-${stamp}`;
}

/** The type a folder's name starts with, for a page finalize left no receipt for. */
export function typeOfFolder(id: string): ArchifyType | null {
  return ARCHIFY_TYPES.find((t) => id.startsWith(`${t}-`)) ?? null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What canopy keeps of finalize's summary receipt
 *  (`<page>.finalize-summary.json`): the type, the verdict and the page's
 *  file name. The receipt's paths are never followed, only the last part
 *  of the artifact's matched against the folder's pages. */
export interface FinalizeSummary {
  type: ArchifyType | null;
  checks: ArchifyChecks;
  file: string | null;
}

export function parseFinalizeSummary(raw: unknown): FinalizeSummary | null {
  if (!isRecord(raw) || raw["command"] !== "finalize") return null;
  const gates = isRecord(raw["gates"]) ? raw["gates"] : {};
  const passed = (gate: string): boolean => gates[gate] === "pass";
  const status = raw["status"];
  const checks: ArchifyChecks =
    status === "pass" ? "pass" : status === "skipped" && passed("deliver") && passed("check") && gates["browser-check"] === "skipped" ? "browser-skipped" : "fail";
  const artifact = isRecord(raw["artifact"]) ? raw["artifact"]["path"] : undefined;
  const file = typeof artifact === "string" ? (artifact.split(/[\\/]/).pop() ?? null) : null;
  return { type: isArchifyType(raw["type"]) ? raw["type"] : null, checks, file: file && isPageName(file) ? file : null };
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", "#39": "'", nbsp: " " };

/** The <title> of a page's first few kilobytes, its entities decoded. */
export function titleOfPage(head: string): string | null {
  const m = /<title>([^<]{1,400})<\/title>/i.exec(head);
  if (!m?.[1]) return null;
  const text = m[1]
    .replace(/&(#\d+|#x[0-9a-f]+|[a-z]+);/gi, (all, name: string) => {
      const known = ENTITIES[name.toLowerCase()];
      if (known !== undefined) return known;
      const code = name.startsWith("#x") || name.startsWith("#X") ? parseInt(name.slice(2), 16) : name.startsWith("#") ? parseInt(name.slice(1), 10) : NaN;
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : all;
    })
    .replace(/\s+/g, " ")
    .trim();
  return text || null;
}

/** Where a diagram run works: the skill, the checkout and the folder
 *  canopy chose for it. */
interface ArchifyWhere {
  /** the skill's folder in canopy's copy, where bin/archify.mjs is */
  skillDir: string;
  /** the checkout's real path: the codebase root and finalize's --repo-root */
  root: string;
  /** the folder under `.archify/` this run writes */
  folder: string;
  /** whether the checkout has an origin remote, which Archify's source
   *  evidence needs: without one a diagram cites no checked sources */
  origin: boolean;
}

/** A diagram run's start: a new diagram of a type, or a revision of the
 *  page `revise` names inside `folder`. */
export type ArchifyStart = ArchifyWhere & ({ type: ArchifyPick } | { revise: string });

/** The CLI commands a diagram run may call without asking: the ones that
 *  validate, render, check and repair a page from the files they are given.
 *  Left out, so each stops to ask: `start` and `code-analysis` (Archify
 *  3.3.0's Code Analysis, which serves on loopback, can ask api.github.com
 *  about a pull request, and runs go, java, python or the program a config
 *  file names), `pr` (its `attach` posts to a pull request with the user's
 *  gh), and `preview` and `demo`, which serve or write outside the folder.
 *  VENDOR.md says to check this list at each new release. */
export const ARCHIFY_COMMANDS = [
  "finalize",
  "validate",
  "deliver",
  "check",
  "browser-check",
  "visual-check",
  "render",
  "inspect",
  "patch",
  "compare",
  "migrate",
  "export-svg",
  "story",
  "guide",
  "brands",
  "examples",
  "doctor",
] as const;

/** What a diagram run may do without asking: read, git's reads, write
 *  inside its own folder, and run the commands above of canopy's copy of
 *  the skill's CLI by its absolute path. Claude matches file rules on Edit
 *  alone, which covers Write too, and `//` starts an absolute path. */
export function archifyTools(skillDir: string, root: string, folder: string): string[] {
  const cli = `node ${skillDir}/bin/archify.mjs`;
  return [...(TOOL_SETS["read"] ?? []), ...(TOOL_SETS["git-read"] ?? []), `Edit(/${root}/${ARCHIFY_FOLDER}/${folder}/**)`, ...ARCHIFY_COMMANDS.map((c) => `Bash(${cli} ${c}:*)`)];
}

const TYPE_WORDS: Record<ArchifyType, string> = {
  architecture: "an architecture diagram",
  workflow: "a workflow diagram",
  sequence: "a sequence diagram",
  dataflow: "a data-flow diagram",
  lifecycle: "a lifecycle (state) diagram",
  erd: "an ERD",
  class: "a class diagram",
  tree: "a tree diagram",
  timeline: "a timeline",
  waterfall: "a waterfall",
  explainer: "a one-page explainer",
};

/** The lines every diagram run gets: where canopy differs from the skill. */
function differences(s: ArchifyStart): string[] {
  const cli = `${s.skillDir}/bin/archify.mjs`;
  const folder = `${ARCHIFY_FOLDER}/${s.folder}`;
  const revising = "revise" in s;
  return [
    "Where canopy differs from the skill's own steps:",
    `- The skill's bin/archify.mjs is ${cli}. Call it as \`node ${cli} …\` with that absolute path every time: canopy's permission rules let exactly that run without asking, for the commands that draw, check and repair a page.`,
    "- Run each archify.mjs call as one plain command with literal paths, relative to the codebase root: no cd, no shell variables, no &&, ; or pipes. Anything else stops to ask the user.",
    "- Read the skill's references and the code with the Read, Grep and Glob tools, not cat, sed or other shell commands, and write or change the candidate with the Write and Edit tools, never sed, python or a shell redirect. Those are what canopy allows without asking.",
    `- This request's folder is ${folder}/, which canopy chose: keep the candidate and the HTML there${revising ? "" : ` (for a native diagram, meta.output is ${folder}/<slug>.html)`}.`,
    s.origin
      ? `- Pass --repo-root ${s.root} to finalize for a diagram backed by this code.`
      : "- This repository has no origin remote, and Archify's source evidence needs one: leave meta.repository and every sources entry out, name files and lines in the text only, and finalize without --repo-root. Do not add a remote, and do not ask about it.",
    "- A finalize that exits 2 with validate, deliver and check passed and browser-check skipped (viewer/chrome-unavailable) found no Chrome on this machine. The diagram is delivered and checked: say the browser check was skipped and stop, without repairing or retrying for it.",
    "- Do not open, preview or serve the HTML, and give no file link: canopy shows the diagram in this repository's map section.",
    "- Skip the update notice: canopy turns the skill's update check off and updates its own copy.",
    "- Make only the page this task asks for: no explainer page beside it, which the skill would otherwise add unasked, and never write an [archify explainer: …] line into any rules file.",
    "- Leave the Architecture Diagnosis section out of the summary, and do not run the CLI's start, code-analysis or pr commands unless the user's note asks for one: they serve a local page, run other toolchains or post to a pull request, and each stops to ask the user.",
    `- Write only inside ${folder}/, and commit nothing: ${ARCHIFY_FOLDER}/ keeps itself out of git.`,
  ];
}

/** The task paragraph of a diagram run's prompt. The skill holds the
 *  method; this says what to draw and where canopy differs from it. */
export function archifyTask(s: ArchifyStart): string {
  const loaded = `with the archify:archify skill, which canopy loaded for this run (Archify ${ARCHIFY_VERSION}, from ${s.skillDir}). Invoke the skill first and follow it.`;
  if ("revise" in s) {
    const folder = `${ARCHIFY_FOLDER}/${s.folder}`;
    return [
      `Task: revise the Archify diagram in ${folder}/ (its page is ${s.revise}) ${loaded}`,
      `The change to make is the note from the user below. Edit the candidate in that folder (candidate.json, or an explainer's candidate.archify.md), keep the same output path, and rerun the complete finalize command; once a run there has reached browser-check, give each later run its own --out-dir ${folder}/review-<n>, as the skill says.`,
      `The codebase root is ${s.root}, and the commands run from there.`,
      ...differences(s),
    ].join("\n");
  }
  const what =
    s.type === "explainer"
      ? "Answer as one page, by the skill's explainer path: the question is the note from the user below, or with no note, how this repository works, its main parts and how they fit."
      : [
          s.type === "auto" ? "Choose the diagram type with the skill's Type router." : `Make it ${TYPE_WORDS[s.type]}.`,
          "What to draw is the note from the user below. With no note, draw the repository's architecture: its main parts, what they call, and how a request or a job moves through them.",
          "Back it with the source, as the skill's repository authoring reference says.",
        ].join(" ");
  return [`Task: draw an Archify diagram of this repository ${loaded}`, what, `The codebase root is ${s.root}, and the commands run from there.`, ...differences(s)].join("\n");
}

/** A diagram run's spec: an ask, read-mostly, whose prompt is the task
 *  above plus the user's note. A revise needs the note, which is the
 *  change. Repairs take several finalize rounds, so the cap is generous. */
export function archifySpec(s: ArchifyStart): ActionSpec {
  const revising = "revise" in s;
  return {
    label: revising ? "revise the diagram" : "draw a diagram",
    verb: revising ? "revise" : "diagram",
    blurb: revising
      ? "Claude edits the diagram's JSON as your note asks and runs Archify's finalize again, which renders and checks it. It asks before running anything beyond reading, git's reads and Archify's drawing and checking commands."
      : "Claude reads the code and draws a checked, interactive diagram with Archify into .archify/ (kept out of git). It asks before running anything beyond reading, git's reads and Archify's drawing and checking commands.",
    notePlaceholder: revising ? "what to change" : "what to draw (optional: the repo's architecture)",
    noteRequired: revising,
    allowedTools: archifyTools(s.skillDir, s.root, s.folder),
    maxTurns: 200,
    progress: "drawing",
    expectsChange: false,
    mode: "ask",
    task: archifyTask(s),
  };
}

const plural = (n: number, one: string, many = `${one}s`): string => `${n} ${n === 1 ? one : many}`;

/** One line for a checkout's diagrams, as the section and `canopy archify`
 *  show it. `ago` words a unix-ms time (the page's "3h ago", the CLI's own). */
export function archifyLine(info: Pick<ArchifyInfo, "diagrams">, ago: (ms: number) => string): string {
  const [newest] = info.diagrams;
  if (!newest) return "no diagrams yet";
  const n = info.diagrams.length;
  return n === 1 ? `1 diagram, built ${ago(newest.builtAt)}` : `${plural(n, "diagram")}; the newest built ${ago(newest.builtAt)}`;
}

/** The few words after the section's name while it shows the diagrams. */
export function archifyHead(info: Pick<ArchifyInfo, "diagrams" | "run"> | null): string {
  if (!info) return "";
  if (info.run) return "drawing";
  return info.diagrams.length ? plural(info.diagrams.length, "diagram") : "";
}

/** What finalize's verdict means, in a few words. */
export function checksWord(checks: ArchifyChecks | null): string {
  switch (checks) {
    case "pass":
      return "checked";
    case "browser-skipped":
      return "checked, no browser check";
    case "fail":
      return "a check failed";
    case null:
      return "not checked";
  }
}

/** A type as the list says it. */
export const typeWord = (type: ArchifyType | null): string => (type === null ? "diagram" : type === "dataflow" ? "data flow" : type === "erd" ? "ERD" : type);
