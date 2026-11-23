/** The start box (FR-079). At the intermediate level the pre-flight of one
 *  plain run or chat is one box: the words, chips on its top edge for where
 *  the run works (the repo, the branch or "new worktree", the backend), one
 *  chip on its bottom edge for the loadout or the model, then send. A chip
 *  opens a small menu where the pre-flight lets that be changed, and is
 *  plain text where it does not. This file says which starts get the box,
 *  what each chip reads and which of the pre-flight's lines go under the
 *  box. The box is a second drawing of the pre-flight's own state (`Plan`
 *  in RunSheet.tsx), so a start from it sends what the pre-flight sends
 *  with nothing behind "more options" touched. Pure; tested in
 *  startbox.test.ts. */

import type { RunAction } from "../../src/core/types";

/** One plain run or chat takes the box. A coordinator keeps its pre-flight:
 *  its note on what will happen is the point of it. */
export const boxFits = (action: RunAction): boolean => action === "ask" || action === "chat" || action === "propose";

export interface BoxOption {
  value: string;
  label: string;
  /** what picking it does, under the label */
  what: string;
}

export interface BoxMenu {
  /** what the choices are, for a screen reader */
  label: string;
  /** the choice in use */
  value: string;
  options: BoxOption[];
}

export type BoxChipId = "repo" | "branch" | "backend" | "agent";

export interface BoxChip {
  id: BoxChipId;
  text: string;
  /** the hover line */
  title: string;
  /** the choices, where the pre-flight lets this be changed; null draws the chip as plain text */
  menu: BoxMenu | null;
}

/** Where the run will work, in plain values. */
export interface BoxPlace {
  repo: string;
  /** the workspace the run spans, with `repo` its primary */
  workspace: string | null;
  /** the checkout's branch, once its status has been read */
  branch: string | null;
  /** the run may take a branch of its own: never a workspace run, nor a
   *  checkout on another host or the forge */
  branchable: boolean;
  onBranch: boolean;
  /** the checkout is in use, which is why the start opened on a worktree
   *  of its own (FR-080, the store's `ownBranchBeside`) */
  beside: boolean;
  backend: string;
  /** the ssh host the checkout is on, for a repo the backend reaches that way */
  host: string | null;
}

/** the branch chip's two choices */
export const IN_CHECKOUT = "checkout";
export const NEW_WORKTREE = "worktree";

/** The chips on the box's top edge: the repo, the branch, the backend. */
export function placeChips(p: BoxPlace): BoxChip[] {
  const here = p.branch ?? "the checkout";
  const repo: BoxChip = {
    id: "repo",
    text: p.workspace === null ? p.repo : `workspace ${p.workspace}`,
    title: p.workspace === null ? `The run works in ${p.repo}` : `The run starts in ${p.repo}, the workspace's primary, and can work in its other folders too`,
    menu: null,
  };
  const branch: BoxChip = p.branchable
    ? {
        id: "branch",
        text: p.onBranch ? "new worktree" : here,
        title: p.onBranch
          ? `${p.beside ? "This checkout is in use, so the agent" : "The agent"} works in a worktree of its own on a run/ branch and commits there; the landing queue lands it once you say land`
          : `The agent works in the checkout${p.branch === null ? "" : `, on ${p.branch}`}, beside whatever else is going there`,
        menu: {
          label: "Where the run works",
          value: p.onBranch ? NEW_WORKTREE : IN_CHECKOUT,
          options: [
            { value: IN_CHECKOUT, label: here, what: "in the checkout, beside what is going there" },
            { value: NEW_WORKTREE, label: "new worktree", what: "a branch of its own, landed once you say land" },
          ],
        },
      }
    : {
        id: "branch",
        text: here,
        title:
          p.workspace !== null
            ? "A workspace run works in its folders' checkouts as they are"
            : p.host !== null
              ? `A checkout on ${p.host} takes no branch of its own`
              : "A repo on the forge takes no branch of its own",
        menu: null,
      };
  const backend: BoxChip = {
    id: "backend",
    text: p.host === null ? p.backend : `${p.host} · ${p.backend}`,
    title: p.host === null ? `The run starts on ${p.backend}, where this checkout is` : `The run starts on ${p.backend}, which reaches the checkout on ${p.host} over ssh`,
    menu: null,
  };
  return [repo, branch, backend];
}

/** What the run starts with, in plain values. */
export interface BoxAgent {
  /** the loadouts on offer for this start; none when it takes no loadout */
  loadouts: readonly { name: string; label: string; note: string }[];
  /** the pick: "" for what a start that names none takes, "none" for the
   *  repo's route, or a loadout's name */
  pick: string;
  /** the first choice's words: what a start that names none takes here */
  inherited: string;
  /** a start that names none inherits a loadout, so going without is a choice of its own */
  inherits: boolean;
  /** the loadout the start will take, as its label; null for the repo's route */
  loadout: string | null;
  /** the route's agent in words (`routeWords`) */
  route: string;
}

/** The route's agent as the chip says it: the model and effort, behind the
 *  harness when it is not Claude Code. "default model" when the route names
 *  none, so the chip never reads empty. */
export function routeWords(a: { harness: string; model: string; effort: string }, harnessName: string): string {
  return [a.harness === "claude" ? "" : harnessName, a.model === "default" ? "default model" : a.model, a.effort === "default" ? "" : a.effort].filter(Boolean).join(" · ");
}

/** The chip on the box's bottom edge: the loadout the start takes, or the
 *  route's model when it takes none. It opens the loadouts where the
 *  pre-flight offers them. The model alone cannot be picked for one start,
 *  so with no loadout on offer the chip is plain text. */
export function agentChip(a: BoxAgent): BoxChip {
  const text = a.loadout ?? a.route;
  if (a.loadouts.length === 0) return { id: "agent", text, title: "The model this repo's route starts a run with. Settings and the kit change it.", menu: null };
  // a pick that no longer fits the list reads as no pick, as the pre-flight's own select does
  const value = a.pick === "" || a.pick === "none" || a.loadouts.some((l) => l.name === a.pick) ? a.pick : "";
  return {
    id: "agent",
    text,
    title: a.loadout === null ? "The repo's route starts this run. Pick a loadout to start with its model, effort, skills and servers." : "The loadout this run starts with: a named set of model, effort, skills and servers from kit.json",
    menu: {
      label: "Loadout",
      value,
      options: [
        { value: "", label: a.inherited, what: "what a start that names none takes here" },
        ...(a.inherits ? [{ value: "none", label: "no loadout", what: `the repo's route: ${a.route}` }] : []),
        ...a.loadouts.map((l) => ({ value: l.name, label: l.label, what: l.note })),
      ],
    },
  };
}

/** Why the box opened on a worktree of its own (FR-080): the checkout is in
 *  use. The pre-flight's own line ends "untick the box"; the box has no box
 *  to untick, so its line names the branch chip. */
export const ownBranchWords = (branch: string | null): string =>
  `This checkout is in use, so the run starts in a worktree of its own, on a branch the landing queue lands on main once you say land. Pick ${branch ?? "the checkout"} on the branch chip to work in the checkout beside what is going there.`;

/** What the pre-flight tells a person before a start, which the box says
 *  too so none of it waits behind "more options". A line each, in the
 *  pre-flight's order: the workflow going in the checkout the run will
 *  share (FR-073), the workflows going in a workspace's other folders, why
 *  the start opened on a worktree of its own (FR-080), and why a chat on a
 *  branch waits for its first words. */
export function boxNotes(o: {
  /** the pre-flight's line for a workflow in this checkout; null when the run shares nothing with one */
  besideFlow: string | null;
  /** its lines for a workspace's other folders with a workflow going */
  memberFlows: readonly string[];
  /** the start opened on a worktree because the checkout is in use, and is still on one */
  ownBranch: boolean;
  /** the checkout's branch, for the way back */
  branch: string | null;
  /** the pre-flight's line for a chat on a branch with nothing said yet; null otherwise */
  chatHint: string | null;
}): string[] {
  return [o.besideFlow, ...o.memberFlows, o.ownBranch ? ownBranchWords(o.branch) : null, o.chatHint].filter((line): line is string => line !== null);
}

/** Why send is held on a branch run: every branch slot on the repo is in
 *  use. Null when the start can go. */
export function boxHeld(o: { branchable: boolean; onBranch: boolean; free: number; slots: number }): string | null {
  if (!o.branchable || !o.onBranch || o.free >= 1) return null;
  return `All ${o.slots} branch slots on this repo are in use. Pick the checkout, or wait for a branch run to end.`;
}
