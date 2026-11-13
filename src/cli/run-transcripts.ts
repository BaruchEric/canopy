/** Read, export, fork, or prune the run transcripts kept by a canopy backend. */

import { writeFile } from "node:fs/promises";
import { forkLine } from "../core/handoff";
import { RUN_ID } from "../core/runlog";
import { ago } from "../core/treelines";
import type { KeptRunHead, Run, RunReplay, RunStep } from "../core/types";
import { apiBase } from "./api";
import { ask, askText, errText, has, take, Unreachable, type Target } from "./health";

type Fail = (message: string) => never;

export const RUN_USAGE = `usage: canopy run <repo> <action> [-m note] [--times 1|2|3] [--profiles a,b,c] [--reviewers 2] [--auto-land] [--pr] [--priority interactive|normal|low] [--tools|--no-tools] [--loadout NAME] [--backend URL] [--on NAME]
       canopy run [--backend URL]
       canopy run show <id> [--wire] [--backend URL]
       canopy run export <id> [--out file.md] [--backend URL]
       canopy run fork <id> [--at N] [--profile NAME] [-m note] [--backend URL]
       canopy run say <id> <words…> [--backend URL]
       canopy run interrupt <id> [words…] [--backend URL]
       canopy run prune [--backend URL]`;

/** One line per kept run, newest first. `now` is unix milliseconds. */
export function keptLines(heads: readonly KeptRunHead[], now: number = Date.now()): string[] {
  return [...heads]
    .sort((a, b) => b.ended - a.ended)
    .map((head) => `${head.id.padEnd(8)}  ${ago(head.ended / 1000, now).padEnd(3)}  ${head.repo.padEnd(24)}  ${head.verb}  ${head.status.padEnd(6)}  ${head.cost === null ? "-" : `$${head.cost.toFixed(2)}`}`);
}

/** The run's export-style head followed by its timeline in UTC. */
export function showLines(run: Run): string[] {
  return [...headLines(run), ...run.steps.map(showStep)];
}

function headLines(run: Run): string[] {
  const end = run.endedAt ?? Date.now();
  const endLabel = run.endedAt === undefined ? "now" : new Date(run.endedAt).toISOString();
  const elapsedSeconds = Math.max(0, Math.floor((end - run.startedAt) / 1_000));
  const duration = `${Math.floor(elapsedSeconds / 60)}:${String(elapsedSeconds % 60).padStart(2, "0")}`;
  const cost = run.result?.costUsd !== undefined
    ? `$${run.result.costUsd.toFixed(2)}`
    : run.result?.tokens
      ? `${new Intl.NumberFormat("en-US").format(run.result.tokens.total)} tokens`
      : "unknown";
  const model = run.result?.model ?? "unknown";
  return [
    `${run.verb} in ${run.repoId} (${run.kept ? "kept" : "live"})`,
    `run: ${run.id}`,
    `action: ${run.action}`,
    `agent: ${agentName(run.harness)}, model ${model}`,
    `when: ${new Date(run.startedAt).toISOString()} to ${endLabel}, ${duration}`,
    `status: ${run.status}`,
    `cost: ${cost}`,
    ...(run.note !== "" ? [`note: ${run.note}`] : []),
    ...(run.branch ? [`branch: ${run.branch.name} onto ${run.branch.target}, ${run.branch.state}`] : []),
  ];
}

/** `showLines` over the replay's steps: the record's own with the prompts
 *  the wire shows the harness asking, or every step folded back out of the
 *  wire when the record kept none of its own or trimmed its oldest. */
export function replayLines(run: Run, replay: RunReplay): string[] {
  const from = replay.source === "wire"
    ? "steps: rebuilt from the wire, without canopy's own notes"
    : "steps: the record's, with the prompts its wire shows";
  const cut = replay.cut ? ["the wire was cut at its size limit, so the steps stop short"] : [];
  return [...headLines(run), from, ...cut, ...replay.steps.map(showStep)];
}

function showStep(step: RunStep): string {
  const at = new Date(step.at).toISOString().slice(11, 19);
  return `${step.parent ? "    " : "  "}${at}  ${step.kind}  ${stepContent(step)}`;
}

function agentName(harness: Run["harness"]): string {
  switch (harness) {
    case "claude": return "Claude Code";
    case "codex": return "Codex";
    default: {
      const exhaustive: never = harness;
      return exhaustive;
    }
  }
}

function stepContent(step: RunStep): string {
  switch (step.kind) {
    case "text":
    case "note":
    case "user":
      return step.text ?? "";
    case "tool":
      return step.tool ? `${step.tool.name}: ${step.tool.title} (${step.tool.status})` : "";
    default: {
      const exhaustive: never = step.kind;
      return exhaustive;
    }
  }
}

function requestFailure(target: Target, fail: Fail): (error: unknown) => never {
  return (error: unknown) => fail(error instanceof Unreachable ? `${target.name} did not answer: ${error.message}` : errText(error));
}

export async function runTranscriptCommand(argv: string[], { fail }: { fail: Fail }): Promise<void> {
  const args = [...argv];
  const backendFlag = args.includes("--backend");
  const given = take(args, "--backend");
  const outFlag = args.includes("--out");
  const out = take(args, "--out");
  if (backendFlag && given === undefined) return fail("--backend needs a value");
  if (outFlag && (out === undefined || out.length === 0 || out.startsWith("-"))) return fail("--out needs a file");

  const home = apiBase(given);
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const target: Target = { name: "home", urls: [home] };
  const sub = args.shift();

  if (sub === undefined) {
    if (args.length > 0 || outFlag) return fail(RUN_USAGE);
    const heads = await ask<KeptRunHead[]>(target, "GET", "/api/runs?kept=1").catch(requestFailure(target, fail));
    if (heads.length === 0) return console.log("no kept runs");
    for (const line of keptLines(heads)) console.log(line);
    return;
  }

  if (sub === "show") {
    const wire = has(args, "--wire");
    const id = args[0];
    if (args.length !== 1 || !id || outFlag) return fail(RUN_USAGE);
    if (!RUN_ID.test(id)) return fail(`invalid run id: ${id}`);
    const run = await ask<Run>(target, "GET", `/api/runs/${encodeURIComponent(id)}`).catch(requestFailure(target, fail));
    if (!wire) {
      for (const line of showLines(run)) console.log(line);
      return;
    }
    const replay = await ask<RunReplay>(target, "GET", `/api/runs/${encodeURIComponent(id)}/replay`).catch(requestFailure(target, fail));
    for (const line of replayLines(run, replay)) console.log(line);
    return;
  }

  if (sub === "export") {
    const id = args[0];
    if (args.length !== 1 || !id) return fail(RUN_USAGE);
    if (!RUN_ID.test(id)) return fail(`invalid run id: ${id}`);
    const text = await askText(target, `/api/runs/${encodeURIComponent(id)}/export`).catch(requestFailure(target, fail));
    if (out === undefined) {
      process.stdout.write(text);
      return;
    }
    await writeFile(out, text, "utf8").catch((error: unknown) => fail(errText(error)));
    console.log(`wrote ${out}`);
    return;
  }

  if (sub === "fork") {
    const id = args.shift();
    if (!id || outFlag) return fail(RUN_USAGE);
    if (!RUN_ID.test(id)) return fail(`invalid run id: ${id}`);
    const atFlag = args.includes("--at");
    const at = take(args, "--at");
    if (atFlag && (at === undefined || !/^[1-9]\d*$/.test(at))) return fail("--at needs a step's number, from 1, as canopy run show --wire counts them");
    const profileFlag = args.includes("--profile");
    const profile = take(args, "--profile");
    if (profileFlag && !profile) return fail("--profile needs a profile's name");
    const noteFlag = args.includes("-m");
    const note = take(args, "-m");
    if (noteFlag && note === undefined) return fail("-m needs a note");
    if (args.length > 0) return fail(RUN_USAGE);
    const body = { run: id, ...(at !== undefined ? { step: Number(at) } : {}), ...(profile ? { profile } : {}), ...(note ? { note } : {}) };
    const run = await ask<Run>(target, "POST", "/api/runs/fork", body).catch(requestFailure(target, fail));
    console.log(`${run.id} ${run.status}`);
    if (run.forkOf) console.log(forkLine(run.forkOf));
    return;
  }

  // a person's words into a live run: a chat's next turn, or a steer into
  // any run at work; interrupt stops the turn first, the words going next
  if (sub === "say" || sub === "interrupt") {
    const id = args.shift();
    if (!id || outFlag) return fail(RUN_USAGE);
    if (!RUN_ID.test(id)) return fail(`invalid run id: ${id}`);
    const text = args.join(" ").trim();
    if (sub === "say" && !text) return fail("canopy run say needs the words to send");
    const body = { id, ...(text ? { text } : {}) };
    const run = await ask<Run>(target, "POST", sub === "say" ? "/api/runs/say" : "/api/runs/interrupt", body).catch(requestFailure(target, fail));
    console.log(`${run.id} ${run.status}`);
    return;
  }

  if (sub === "prune") {
    if (args.length > 0 || outFlag) return fail(RUN_USAGE);
    const result = await ask<{ removed: string[]; kept: number }>(target, "POST", "/api/runs/prune").catch(requestFailure(target, fail));
    console.log(`removed ${result.removed.length} transcripts, ${result.kept} kept`);
    return;
  }

  return fail(RUN_USAGE);
}
