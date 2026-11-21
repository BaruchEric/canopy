/** `canopy archify`: a checkout's diagrams (FR-071). Lists them, starts the
 *  Claude run that draws a new one or revises one, saves a diagram's page
 *  to a file here, and removes one, the same things the repo panel's map
 *  section does with its archify switch on. */

import { existsSync } from "node:fs";
import { ARCHIFY_TYPES, archifyLine, checksWord, isArchifyPick, isPlainName, typeWord, type ArchifyInfo, type ArchifyPick } from "../core/archify";
import type { Run } from "../core/types";
import { ask, askText, has, take } from "./health";
import { repoId, requestFailure, selectedTarget } from "./run";
import { ageWord } from "./worktrees";

export const ARCHIFY_USAGE = [
  "usage: canopy archify <repo> [list] [--json] [--backend URL] [--on NAME]",
  `       canopy archify <repo> make [--type auto|${ARCHIFY_TYPES.join("|")}] [-m note] [--backend URL] [--on NAME]`,
  "       canopy archify <repo> revise <diagram> -m note [--backend URL] [--on NAME]",
  "       canopy archify <repo> save <diagram> [file] [--backend URL] [--on NAME]",
  "       canopy archify <repo> rm <diagram> [--backend URL] [--on NAME]",
].join("\n");

export type ArchifyArgs = { repo: string; json: boolean; backend?: string; on?: string } & (
  | { act: "list" }
  | { act: "make"; type: ArchifyPick; note: string }
  | { act: "revise"; diagram: string; note: string }
  | { act: "save"; diagram: string; file: string | null }
  | { act: "rm"; diagram: string }
);

/** The command's words, without changing the caller's list. */
export function parseArchifyArgs(argv: string[]): ArchifyArgs | string {
  const args = [...argv];
  const backend = take(args, "--backend");
  const on = take(args, "--on");
  const note = take(args, "-m") ?? take(args, "--note");
  const type = take(args, "--type");
  const json = has(args, "--json");
  const [repo, word = "list", ...rest] = args;
  if (!repo || repo.startsWith("-")) return ARCHIFY_USAGE;
  if (backend !== undefined && on !== undefined) return "use either --backend URL or --on NAME";
  const where = { repo, json, ...(backend !== undefined ? { backend } : {}), ...(on !== undefined ? { on } : {}) };
  if (type !== undefined && word !== "make") return `--type goes with make\n\n${ARCHIFY_USAGE}`;
  if (note !== undefined && word !== "make" && word !== "revise") return `-m goes with make or revise\n\n${ARCHIFY_USAGE}`;
  const diagram = rest[0];
  const named = diagram !== undefined && isPlainName(diagram);
  switch (word) {
    case "list":
      return rest.length === 0 ? { ...where, act: "list" } : ARCHIFY_USAGE;
    case "make": {
      const pick = type ?? "auto";
      if (!isArchifyPick(pick)) return `--type is auto or one of ${ARCHIFY_TYPES.join(", ")}`;
      return rest.length === 0 ? { ...where, act: "make", type: pick, note: note ?? "" } : ARCHIFY_USAGE;
    }
    case "revise":
      if (!named || rest.length !== 1) return ARCHIFY_USAGE;
      if (!note?.trim()) return "say what to change with -m";
      return { ...where, act: "revise", diagram, note };
    case "save":
      return named && rest.length <= 2 ? { ...where, act: "save", diagram, file: rest[1] ?? null } : ARCHIFY_USAGE;
    case "rm":
      return named && rest.length === 1 ? { ...where, act: "rm", diagram } : ARCHIFY_USAGE;
    default:
      return ARCHIFY_USAGE;
  }
}

/** A list in lines: the summary, one line per diagram, the run at work. `now` is unix ms. */
export function archifyLines(info: ArchifyInfo, now: number): string[] {
  const ago = (ms: number): string => `${ageWord(now - ms)} ago`.replace("now ago", "just now");
  return [
    archifyLine(info, ago),
    ...info.diagrams.map((d) => `  ${d.id}  ${d.title ?? d.file}  (${typeWord(d.type)}, ${ago(d.builtAt)}, ${checksWord(d.checks)}${d.tracked ? ", in git" : ""})`),
    ...(info.run ? [`run ${info.run} is drawing one now (canopy run show ${info.run})`] : []),
  ];
}

export async function archifyCommand(argv: string[], { fail }: { fail: (message: string) => never }): Promise<void> {
  const parsed = parseArchifyArgs(argv);
  if (typeof parsed === "string") return fail(parsed);
  const target = await selectedTarget(parsed, fail);
  const id = await repoId(parsed.repo, target, fail);
  const path = `/api/repos/archify?${new URLSearchParams({ id })}`;
  const failed = requestFailure(target, fail);
  const started = (run: Run) => console.log(`started run ${run.id} (${run.verb}). Follow it with canopy run show ${run.id}; its questions wait in the page.`);
  switch (parsed.act) {
    case "list": {
      const info = await ask<ArchifyInfo>(target, "GET", path, undefined, 30_000).catch(failed);
      if (parsed.json) console.log(JSON.stringify(info, null, 2));
      else for (const line of archifyLines(info, Date.now())) console.log(line);
      return;
    }
    case "make":
      return started(await ask<Run>(target, "POST", path, { act: "make", type: parsed.type, note: parsed.note }, 30_000).catch(failed));
    case "revise":
      return started(await ask<Run>(target, "POST", path, { act: "revise", diagram: parsed.diagram, note: parsed.note }, 30_000).catch(failed));
    case "save": {
      const info = await ask<ArchifyInfo>(target, "GET", path, undefined, 30_000).catch(failed);
      const d = info.diagrams.find((x) => x.id === parsed.diagram);
      if (!d) return fail(`no diagram ${parsed.diagram}; canopy archify ${parsed.repo} lists them`);
      const file = parsed.file ?? d.file;
      if (existsSync(file)) return fail(`${file} is there already; name another file`);
      const html = await askText(target, `${path}&${new URLSearchParams({ diagram: d.id })}`, 60_000).catch(failed);
      await Bun.write(file, html);
      console.log(`saved ${d.title ?? d.id} to ${file}; it opens in any browser`);
      return;
    }
    case "rm": {
      const { removed } = await ask<{ removed: string }>(target, "POST", path, { act: "remove", diagram: parsed.diagram }).catch(failed);
      console.log(`removed .archify/${removed}`);
      return;
    }
  }
}
