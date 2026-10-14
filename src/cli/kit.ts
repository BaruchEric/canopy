import { ask, errText, has, take, targetsOf, Unreachable, type Target } from "./health";
import type { BackendEntry, KitAction, KitApplyResult, KitInfo } from "../core/types";

export function actionWord(a: KitAction): string {
  if (a.kind === "pull") return "pull";
  if (a.kind === "mkdir") return `mkdir ${a.agent}`;
  return `${a.kind} ${a.agent}/${a.name}`;
}

const PROBLEMS = new Set(["missing", "drift", "foreign", "no-source", "noagent", "away"]);

export function kitStatusLines(info: KitInfo, machine: string | null): string[] {
  if (!info.ok) return [info.error ?? "kit not read"];
  const out: string[] = [];
  for (const m of info.machines) {
    if (machine && m.machine !== machine) continue;
    const s = m.seen.store;
    if (m.seen.away) out.push(`${m.machine}  away: ${m.seen.away}`);
    else if (s) {
      const bits = [s.branch ?? "no branch"];
      if (s.ahead) bits.push(`${s.ahead} ahead`);
      if (s.behind) bits.push(`${s.behind} behind`);
      if (s.dirty) bits.push(`${s.dirty} changed`);
      if (s.fetchFailed) bits.push("fetch failed");
      out.push(`${m.machine}  store ${bits.join(", ")}`);
    }
    for (const c of info.cells) {
      if (c.machine !== m.machine || !PROBLEMS.has(c.state) || c.state === "away") continue;
      out.push(`  ${c.agent}  ${c.skill}  ${c.state}${c.why ? `  ${c.why}` : ""}`);
    }
    if (m.plan.length) out.push(`  plan: ${m.plan.map(actionWord).join(", ")}`);
  }
  return out;
}

export function kitApplyLines(r: KitApplyResult): string[] {
  return [
    ...r.done.map((a) => `${r.machine}: ${actionWord(a)} done`),
    ...r.failed.map((f) => `${r.machine}: ${actionWord(f.action)} failed: ${f.why}`),
  ];
}

export const KIT_USAGE = "usage: canopy kit [status|apply] [--machine m] [--dry-run] [--backend URL]";

export async function kitCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const machine = take(args, "--machine") ?? null;
  const dryRun = has(args, "--dry-run");
  const sub = args.shift() ?? "status";
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const homeTarget: Target = { name: "home", urls: [home] };
  const listed = await ask<{ self?: string; backends?: BackendEntry[] }>(homeTarget, "GET", "/api/backends").catch(() => null);
  const targets = given === undefined && listed?.self ? targetsOf(home, listed.self, listed.backends ?? []) : [homeTarget];
  const call = <T>(t: Target, method: string, path: string, body?: unknown) =>
    ask<T>(t, method, path, body).catch((err: unknown) => fail(err instanceof Unreachable ? `${t.name} did not answer: ${err.message}` : errText(err)));
  if (sub !== "status" && sub !== "apply") return fail(KIT_USAGE);
  let failed = false;
  for (const t of targets) {
    // one backend that cannot answer (unreachable, or a canopy from before
    // the kit) is named and skipped; the others still report
    let info: KitInfo;
    try {
      info = await ask<KitInfo>(t, "GET", "/api/kit");
    } catch (err) {
      console.log(`${t.name}: ${err instanceof Unreachable ? `did not answer: ${err.message}` : errText(err)}`);
      failed = true;
      continue;
    }
    if (!info.ok) {
      // machine lines name themselves; a whole backend's error needs its name
      console.log(`${t.name}: ${info.error ?? "kit not read"}`);
      if (sub === "apply") failed = true;
      continue;
    }
    if (sub === "status") {
      for (const line of kitStatusLines(info, machine)) console.log(line);
      continue;
    }
    for (const m of info.machines) {
      if ((machine && m.machine !== machine) || m.seen.away || m.plan.length === 0) continue;
      const r = await call<KitApplyResult>(t, "POST", "/api/kit/apply", { machine: m.machine, dryRun });
      for (const line of kitApplyLines(r)) console.log(line);
      if (r.failed.length) failed = true;
    }
  }
  if (failed) process.exitCode = 1;
}
