/** `canopy diagnosis`: a checkout's Architecture Diagnosis (FR-075). Says
 *  what the last analysis found, starts one on the backend and waits for it,
 *  saves its page to a file here, and removes it, the same things the repo
 *  panel's map section does with its diagnosis switch on. */

import { existsSync } from "node:fs";
import { DIAGNOSIS_LANGUAGES, DIAGNOSIS_PAGE, DIAGNOSIS_PATH, changesLine, diagnosisLine, isDiagnosisPick, othersLine, type DiagnosisInfo, type DiagnosisPick } from "../core/diagnosis";
import { ask, askText, has, take } from "./health";
import { repoId, requestFailure, selectedTarget } from "./run";
import { ageWord } from "./worktrees";

export const DIAGNOSIS_USAGE = [
  "usage: canopy diagnosis <repo> [status] [--json] [--backend URL] [--on NAME]",
  `       canopy diagnosis <repo> run [--language auto|${DIAGNOSIS_LANGUAGES.join("|")}] [--no-wait] [--backend URL] [--on NAME]`,
  "       canopy diagnosis <repo> save [file] [--backend URL] [--on NAME]",
  "       canopy diagnosis <repo> rm [--backend URL] [--on NAME]",
].join("\n");

export type DiagnosisArgs = { repo: string; json: boolean; backend?: string; on?: string } & ({ act: "status" } | { act: "run"; language: DiagnosisPick; wait: boolean } | { act: "save"; file: string | null } | { act: "rm" });

/** The command's words, without changing the caller's list. */
export function parseDiagnosisArgs(argv: string[]): DiagnosisArgs | string {
  const args = [...argv];
  const backend = take(args, "--backend");
  const on = take(args, "--on");
  const language = take(args, "--language");
  const json = has(args, "--json");
  const noWait = has(args, "--no-wait");
  const [repo, word = "status", ...rest] = args;
  if (!repo || repo.startsWith("-")) return DIAGNOSIS_USAGE;
  if (backend !== undefined && on !== undefined) return "use either --backend URL or --on NAME";
  const where = { repo, json, ...(backend !== undefined ? { backend } : {}), ...(on !== undefined ? { on } : {}) };
  if ((language !== undefined || noWait) && word !== "run") return `--language and --no-wait go with run\n\n${DIAGNOSIS_USAGE}`;
  switch (word) {
    case "status":
      return rest.length === 0 ? { ...where, act: "status" } : DIAGNOSIS_USAGE;
    case "run": {
      const pick = language ?? "auto";
      if (!isDiagnosisPick(pick)) return `--language is auto or one of ${DIAGNOSIS_LANGUAGES.join(", ")}`;
      return rest.length === 0 ? { ...where, act: "run", language: pick, wait: !noWait } : DIAGNOSIS_USAGE;
    }
    case "save":
      return rest.length <= 1 ? { ...where, act: "save", file: rest[0] ?? null } : DIAGNOSIS_USAGE;
    case "rm":
      return rest.length === 0 ? { ...where, act: "rm" } : DIAGNOSIS_USAGE;
    default:
      return DIAGNOSIS_USAGE;
  }
}

/** A diagnosis in lines: the summary, what changed, what to look at first,
 *  what was left out, and the last failure. `now` is unix ms. */
export function diagnosisLines(info: DiagnosisInfo, now: number): string[] {
  const ago = (ms: number): string => `${ageWord(now - ms)} ago`.replace("now ago", "just now");
  const facts = info.report?.facts ?? null;
  const changes = facts ? changesLine(facts.changes) : null;
  const others = facts ? othersLine(facts.others) : null;
  return [
    `${diagnosisLine(info, ago)}${info.tracked ? " (in git)" : ""}`,
    ...(info.running !== null && info.report ? ["an analysis is going now"] : []),
    ...(changes ? [changes] : []),
    ...(facts?.leads ?? []).map((l) => `  ${l.severity}  ${l.message}${l.where ? `  (${l.where})` : ""}`),
    ...(others ? [others] : []),
    ...(info.failed && info.running === null ? [`the last analysis failed: ${info.failed}`] : []),
  ];
}

/** how often a waiting `run` reads the route, and for how long */
const WAIT_EVERY = 2_000;
const WAIT_MS = 16 * 60_000;

export async function diagnosisCommand(argv: string[], { fail }: { fail: (message: string) => never }): Promise<void> {
  const parsed = parseDiagnosisArgs(argv);
  if (typeof parsed === "string") return fail(parsed);
  const target = await selectedTarget(parsed, fail);
  const id = await repoId(parsed.repo, target, fail);
  const path = `/api/repos/diagnosis?${new URLSearchParams({ id })}`;
  const failed = requestFailure(target, fail);
  const read = () => ask<DiagnosisInfo>(target, "GET", path, undefined, 30_000).catch(failed);
  const say = (info: DiagnosisInfo) => {
    if (parsed.json) console.log(JSON.stringify(info, null, 2));
    else for (const line of diagnosisLines(info, Date.now())) console.log(line);
  };
  switch (parsed.act) {
    case "status":
      return say(await read());
    case "run": {
      await ask<{ running: number }>(target, "POST", path, { act: "run", language: parsed.language }, 60_000).catch(failed);
      if (!parsed.wait) return console.log(`the analysis started; canopy diagnosis ${parsed.repo} says when it is done`);
      const until = Date.now() + WAIT_MS;
      for (;;) {
        await Bun.sleep(WAIT_EVERY);
        const info = await read();
        if (info.running === null) {
          if (info.failed) return fail(`the analysis failed: ${info.failed}`);
          return say(info);
        }
        if (Date.now() > until) return fail(`the analysis is still going; canopy diagnosis ${parsed.repo} says when it is done`);
      }
    }
    case "save": {
      const info = await read();
      if (!info.report) return fail(`no diagnosis yet; canopy diagnosis ${parsed.repo} run makes one`);
      const file = parsed.file ?? DIAGNOSIS_PAGE;
      if (existsSync(file)) return fail(`${file} is there already; name another file`);
      const html = await askText(target, `${path}&page=1`, 120_000).catch(failed);
      await Bun.write(file, html);
      console.log(`saved the diagnosis to ${file}; it opens in any browser`);
      return;
    }
    case "rm":
      await ask<{ removed: boolean }>(target, "POST", path, { act: "remove" }).catch(failed);
      console.log(`removed ${DIAGNOSIS_PATH}`);
      return;
  }
}
