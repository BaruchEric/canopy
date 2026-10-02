/**
 * The vault's view of a sprout: one note per project at
 * `02 - Dev/incubator/<slug>.md`, rewritten whole at each change, and a
 * line in that day's daily note when a project starts or parks (later
 * phases add live and rejected). An index and summaries only: no raw input
 * and no transcript ever reaches the vault. Pure, so it is tested.
 */
import type { Sprout, SproutStatus } from "./types";

export type NoteEvent = "started" | "questions" | "input" | "parked" | "stopped" | "live" | "rejected";

/** the events that also put a line in the day's note */
export const DAILY_EVENTS: ReadonlySet<NoteEvent> = new Set<NoteEvent>(["started", "parked"]);

export const sproutNotePath = (slug: string): string => `02 - Dev/incubator/${slug}.md`;

const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const pad2 = (n: number): string => String(n).padStart(2, "0");
const ymd = (d: Date): string => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;

export function dailyNotePath(d: Date): string {
  return `01 - Daily Notes/${pad2(d.getMonth() + 1)} - ${MONTHS[d.getMonth()] ?? ""} ${d.getFullYear()}/${ymd(d)}.md`;
}

/** what a daily note starts with when canopy is the first to write that day */
export function dailyNoteHead(d: Date): string {
  return [
    "---",
    "status: active",
    "project: personal",
    "type: log",
    `created: ${ymd(d)}`,
    "---",
    `# ${DAYS[d.getDay()] ?? ""}, ${MONTHS[d.getMonth()] ?? ""} ${d.getDate()}, ${d.getFullYear()}`,
    "",
    "## Index",
    "",
  ].join("\n");
}

/** one line: a park reason can carry a flow's error, newlines and all */
const flat = (t: string): string => t.replace(/\s+/g, " ").trim();

const link = (s: Sprout): string => `[[${sproutNotePath(s.slug).replace(/\.md$/, "")}|${s.slug}]]`;

export function dailyLine(s: Sprout, event: NoteEvent): string {
  const what =
    event === "started"
      ? `started in canopy's incubator as ${s.repoId}`
      : event === "parked"
        ? `parked: ${flat(s.parked ?? "") || "no reason given"}`
        : event;
  return `\n- **incubator: ${s.title}** - ${what}. Note: ${link(s)}\n`;
}

const STATUS_WORD: Record<SproutStatus, string> = {
  queued: "Waiting its turn.",
  clarifying: "Clarifying what is wanted.",
  researching: "Researching what exists.",
  building: "Building.",
  testing: "Testing.",
  accepting: "Checking the work against the intent.",
  deploying: "Deploying.",
  live: "Live.",
  parked: "Parked.",
  rejected: "Rejected.",
  "handed-off": "Handed off as a branch.",
  stopped: "Stopped by the user.",
};

function statusLine(s: Sprout): string {
  if (s.status === "parked") return `Parked: ${flat(s.parked ?? "") || "no reason given"}`;
  const n = s.questions?.length ?? 0;
  return n ? `${STATUS_WORD[s.status]} ${n} ${n === 1 ? "question waits" : "questions wait"} for the user.` : STATUS_WORD[s.status];
}

function spentLine(s: Sprout): string {
  const runs = s.spent.runs;
  const minutes = Math.round(s.spent.workMs / 60_000);
  return `${runs} agent ${runs === 1 ? "run" : "runs"}, ${minutes} ${minutes === 1 ? "minute" : "minutes"} of agent work.`;
}

/** the whole note; `intent` is the seed's intent.md, null before clarify wrote one */
export function sproutNote(s: Sprout, intent: string | null): string {
  const inputs = s.inputs.map((e) => `- [${e.n}] ${e.kind} ${flat(e.label)}: ${flat(e.summary || e.note || "not summarized yet")}`);
  const stages = s.flows.map((f) => `- ${f.workflow}: ${f.outcome ?? "running"}`);
  return [
    "---",
    "type: project",
    `status: ${s.status}`,
    `created: ${ymd(new Date(s.createdAt))}`,
    "source: canopy incubator",
    `seed: ${s.repoId}`,
    "---",
    `# ${s.title}`,
    "",
    statusLine(s),
    "",
    "## Intent",
    "",
    intent?.trim() || "Clarify has not written the intent yet.",
    "",
    "## Inputs",
    "",
    ...(inputs.length ? inputs : ["None yet."]),
    "",
    "## Stages",
    "",
    ...(stages.length ? stages : ["None has run yet."]),
    "",
    "## Spent",
    "",
    spentLine(s),
    "",
    "<!-- canopy rewrites this note at each change; edits here are replaced -->",
    "",
  ].join("\n");
}
