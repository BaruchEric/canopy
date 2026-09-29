/* The guided (intermediate) panel's words and decisions, pure so they are
   tested: what the repo's state is in plain words, what the dev task is
   doing, the prompts the buttons type into Claude, which shell they type
   into, and the tour's steps. */
import type { Repo, TaskInfo } from "../../src/core/types";
import type { TermTab } from "./term";

export type DevState = "none" | "stopped" | "running" | "failed";

/** A dev task's state as the buttons read it: a restart after a crash is
 *  still running, a crash or a give-up is failed. */
export function devState(dev: TaskInfo | undefined): DevState {
  if (!dev) return "none";
  if (dev.status === "running" || dev.status === "backoff") return "running";
  if (dev.status === "failed" || dev.status === "gave-up") return "failed";
  return "stopped";
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** the repo's state in words a non-programmer reads */
export function plainStatus(repo: Repo, dev: DevState): string {
  const st = repo.status;
  if (repo.error || !st) return "can't read this project";
  const base =
    st.files.length > 0
      ? `${plural(st.files.length, "file")} changed, not saved yet`
      : !st.upstream
        ? "saved on this computer only"
        : st.ahead > 0
          ? "saved, not backed up yet"
          : "all saved and backed up";
  if (dev === "running") return `${base} · app running`;
  if (dev === "failed") return `${base} · app stopped with an error`;
  return base;
}

/** something to commit or push: a dirty tree, commits ahead, or a branch
 *  that was never pushed */
export function canSave(repo: Repo): boolean {
  const st = repo.status;
  if (!st) return false;
  return st.files.length > 0 || st.ahead > 0 || (!st.upstream && st.lastCommit !== null);
}

export const SAVE_PROMPT = "Save my work: commit everything with a clear message, then push.";
export const SETUP_PROMPT = "Set up a way to run this app locally and tell me how to open it.";
const DEBUG_ASK = "My app shows this error. Find the cause and fix it.";
const DEBUG_LINES = 40;

export function debugPrompt(lines: readonly string[]): string {
  const tail = lines.slice(-DEBUG_LINES);
  return tail.length ? `${DEBUG_ASK}\n\n${tail.join("\n")}` : DEBUG_ASK;
}

/** The shells a prompt may go to, best first: the showing one when it is a
 *  shell of this repo, then the repo's panel shells newest first, then its
 *  strip shells. A task's tab is never one. */
export function claudeCandidates(showing: TermTab | null, tabs: readonly TermTab[], repoId: string): string[] {
  const mine = tabs.filter((t) => t.repoId === repoId && t.task === undefined && t.exit === undefined);
  const out: string[] = [];
  if (showing && mine.some((t) => t.id === showing.id)) out.push(showing.id);
  for (const t of [...mine].reverse()) if (t.place === "panel" && !out.includes(t.id)) out.push(t.id);
  for (const t of [...mine].reverse()) if (t.place === "strip" && !out.includes(t.id)) out.push(t.id);
  return out;
}

/** The shell of this repo canopy last started with claude, still open: one
 *  that may not have come up yet, so a prompt waits for it rather than
 *  opening another. */
export function pendingClaude(tabs: readonly TermTab[], repoId: string): string | null {
  for (let i = tabs.length - 1; i >= 0; i--) {
    const t = tabs[i];
    if (t && t.repoId === repoId && t.start === "claude" && t.exit === undefined && t.task === undefined) return t.id;
  }
  return null;
}

export type TourStep = 0 | 1 | 2 | "done";

export const TOUR_TEXT = [
  "Tell Claude what you want to build, in your own words.",
  "See your app running here.",
  "Keep your changes. Claude saves and backs them up.",
] as const;

export function tourStep(step: TourStep, action: "next" | "skip"): TourStep {
  if (step === "done" || action === "skip") return "done";
  return step === 2 ? "done" : ((step + 1) as 1 | 2);
}
