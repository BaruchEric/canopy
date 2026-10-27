/** Read, export, or prune the run transcripts kept by a canopy backend. */

import { writeFile } from "node:fs/promises";
import { ago } from "../core/treelines";
import type { KeptRunHead, Run, RunStep } from "../core/types";
import { apiBase } from "./api";
import { ask, askText, errText, take, Unreachable, type Target } from "./health";

type Fail = (message: string) => never;

export const RUN_USAGE = `usage: canopy run <repo> <action> [-m note] [--times 1|2|3] [--auto-land] [--pr] [--backend URL] [--on NAME]
       canopy run [--backend URL]
       canopy run show <id> [--backend URL]
       canopy run export <id> [--out file.md] [--backend URL]
       canopy run prune [--backend URL]`;

/** One line per kept run, newest first. `now` is unix milliseconds. */
export function keptLines(heads: readonly KeptRunHead[], now: number = Date.now()): string[] {
  return [...heads]
    .sort((a, b) => b.ended - a.ended)
    .map((head) => `${head.id.padEnd(8)}  ${ago(head.ended / 1000, now).padEnd(3)}  ${head.repo.padEnd(24)}  ${head.verb}  ${head.status.padEnd(6)}  ${head.cost === null ? "-" : `$${head.cost.toFixed(2)}`}`);
}

/** The run's export-style head followed by its timeline in UTC. */
export function showLines(run: Run): string[] {
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
  const lines = [
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
  return [...lines, ...run.steps.map(showStep)];
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
  if (outFlag && (out === undefined || out.length === 0)) return fail("--out needs a file");

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
    const id = args[0];
    if (args.length !== 1 || !id || outFlag) return fail(RUN_USAGE);
    const run = await ask<Run>(target, "GET", `/api/runs/${encodeURIComponent(id)}`).catch(requestFailure(target, fail));
    for (const line of showLines(run)) console.log(line);
    return;
  }

  if (sub === "export") {
    const id = args[0];
    if (args.length !== 1 || !id) return fail(RUN_USAGE);
    const text = await askText(target, `/api/runs/${encodeURIComponent(id)}/export`).catch(requestFailure(target, fail));
    if (out === undefined) {
      process.stdout.write(text);
      return;
    }
    await writeFile(out, text, "utf8").catch((error: unknown) => fail(errText(error)));
    console.log(`wrote ${out}`);
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
