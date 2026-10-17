/**
 * `canopy health`: every check on a backend, one check's history, the
 * button, a live follow, a repo's own checks and canopy's layer over them,
 * and a health file's lint and starter, all from a terminal. The listing
 * exits 1 while something is down, so a script or a compose healthcheck can
 * read it. The arg parsing and the lines are pure (health.test.ts).
 */

import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { checkTarget, HEALTH_FILE, normalizeCheck, parseHealthFile } from "../core/repohealth";
import { detectTasks, parseTaskFile, TASK_FILES, type TaskFiles } from "../core/tasks";
import type { BackendEntry, HealthCheck, HealthInfo, MergedCheck, RepoCheckDef, RepoHealthInfo, ScanResult, ServerEvent } from "../core/types";
import { apiBase, callerHeaders } from "./api";
import { bold, dim, lichen, moss, rust } from "./render";

export const HEALTH_USAGE = `usage: canopy health [list] [--bad] [--repo R] [--canopy] [--json]
       canopy health show <id> [--on NAME] [--json]
       canopy health heal <id> [--on NAME]
       canopy health watch [--bad] [--repo R]
       canopy health checks <repo> [--json]
       canopy health add <repo> <name> (--http URL [--expect N] | --port N [--host H] | --task T | --compose S [--file F] | --command CMD)
                         [--fix CMD] [--heal auto|button|none] [--while TASK] [--every SECONDS]
       canopy health rm <repo> <name>
       canopy health lint [dir]
       canopy health init [dir]
  the listing, show, heal and watch ask every backend the home one lists (Mac, mini);
  --on NAME keeps one, --backend URL asks only that address ($CANOPY_API, else 127.0.0.1:7850);
  checks, add and rm speak to the home backend, or to --on's
  <repo> is an id the backend knows (web-apps/ripe) or a path (.)`;

/** the flags the kinds take: exactly one names the kind */
const KIND_FLAGS = { "--http": "http", "--port": "port", "--task": "task", "--compose": "compose", "--command": "command" } as const;

/** Pulls `--name value` out of `args`, or undefined. */
export function take(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1) return undefined;
  const [, value] = args.splice(i, 2);
  return value;
}

/** Pulls a bare `--name` out of `args`. */
export function has(args: string[], name: string): boolean {
  const i = args.indexOf(name);
  if (i === -1) return false;
  args.splice(i, 1);
  return true;
}

/** `add`'s flags as a check, through the rules the server keeps, or what is wrong. */
export function parseCheckArgs(name: string, flags: string[]): RepoCheckDef | string {
  const args = [...flags];
  const kinds = (Object.keys(KIND_FLAGS) as (keyof typeof KIND_FLAGS)[]).filter((f) => args.includes(f));
  const [flag, ...more] = kinds;
  if (!flag || more.length > 0) return "name one kind: --http, --port, --task, --compose or --command";
  const kind = KIND_FLAGS[flag];
  const value = take(args, flag);
  if (value === undefined) return `${flag} needs a value`;
  const raw: Record<string, unknown> = { name, kind };
  const num = (v: string | undefined): number | undefined => (v === undefined ? undefined : Number(v));
  if (kind === "http") raw["url"] = value;
  if (kind === "port") raw["port"] = num(value);
  if (kind === "task") raw["task"] = value;
  if (kind === "compose") raw["service"] = value;
  if (kind === "command") raw["run"] = value;
  const expect = take(args, "--expect");
  if (expect !== undefined) raw["expect"] = num(expect);
  const host = take(args, "--host");
  if (host !== undefined) raw["host"] = host;
  const file = take(args, "--file");
  if (file !== undefined) raw["file"] = file;
  const fix = take(args, "--fix");
  if (fix !== undefined) raw["fix"] = fix;
  const heal = take(args, "--heal");
  if (heal !== undefined) raw["heal"] = heal;
  const during = take(args, "--while");
  if (during !== undefined) raw["while"] = during;
  const every = take(args, "--every");
  if (every !== undefined) raw["every"] = num(every);
  if (args.length > 0) return `not understood: ${args.join(" ")}`;
  return normalizeCheck(raw);
}

const STATE_WORD: Record<HealthCheck["state"], string> = { ok: "ok", down: "down", healing: "healing", "gave-up": "gave up", off: "off", unknown: "checking" };

export function paintState(state: HealthCheck["state"]): string {
  const word = STATE_WORD[state];
  return state === "ok" ? moss(word) : state === "down" || state === "gave-up" ? rust(word) : state === "off" ? dim(word) : lichen(word);
}

const isBad = (c: HealthCheck): boolean => c.state === "down" || c.state === "gave-up";

/** one check on one line: state, label, why, detail, id */
export const checkLine = (c: HealthCheck): string =>
  `${paintState(c.state).padEnd(20)} ${bold(c.label)}${c.why ? dim(`  ${c.why}`) : ""}${c.detail ? dim(`  ${c.detail}`) : ""}  ${dim(c.id)}`;

export interface ListFilter {
  bad?: boolean;
  /** a repo's id: its checks only */
  repo?: string;
  /** canopy's own pieces only */
  canopy?: boolean;
}

export function filterChecks(checks: readonly HealthCheck[], f: ListFilter): HealthCheck[] {
  return checks.filter(
    (c) =>
      (!f.bad || isBad(c)) &&
      (!f.canopy || c.scope.kind === "canopy") &&
      (f.repo === undefined || (c.scope.kind === "repo" && c.scope.repoId === f.repo)),
  );
}

const clock = (ms: number): string => new Date(ms).toLocaleString();

/** one check at length: what it is, how it heals, what it has been through */
export function showLines(c: HealthCheck, now: number): string[] {
  const out = [`${bold(c.label)}  ${paintState(c.state)}${c.why ? `  ${c.why}` : ""}`, dim(c.id)];
  out.push(`since      ${clock(c.since)}`);
  if (c.lastOk !== null) out.push(`last ok    ${clock(c.lastOk)}`);
  if (c.detail) out.push(`detail     ${c.detail}`);
  out.push(`heals      ${c.heal}${c.button ? ", and by hand (canopy health heal)" : ""}`);
  if (c.fails > 0) out.push(`fails      ${c.fails} heal${c.fails === 1 ? "" : "s"} that did not hold`);
  if (c.nextHeal !== null) out.push(`next heal  in ${Math.max(0, Math.round((c.nextHeal - now) / 1000))}s`);
  if (c.history.length > 0) {
    out.push("history");
    for (const h of [...c.history].reverse()) out.push(`  ${dim(clock(h.at))}  ${paintState(h.state)}${h.why ? dim(`  ${h.why}`) : ""}`);
  }
  return out;
}

/** a repo's checks as defined: name, kind and target, heal, where from, and why one does not run */
export function defLines(info: RepoHealthInfo): string[] {
  const out = info.checks.map((c: MergedCheck) => {
    // an http or port check with no fix has nothing to run, whatever its mode
    const canHeal = c.fix !== undefined || c.kind === "task" || c.kind === "compose";
    const heal = c.blocked || !canHeal ? "none" : (c.heal ?? "button");
    const from = c.source === "repo" ? HEALTH_FILE : "canopy's config";
    return `${bold(c.name.padEnd(14))} ${c.kind.padEnd(8)} ${checkTarget(c)}${c.fix ? dim(`  fix: ${c.fix}`) : ""}  ${dim(`heal ${heal}, every ${c.every ?? 30}s${c.while ? `, while ${c.while} runs` : ""}, from ${from}`)}${c.blocked ? `  ${rust(c.blocked)}` : ""}`;
  });
  for (const e of info.errors) out.push(rust(e));
  if (out.length === 0) out.push(dim(`no checks: add one with canopy health add, or list them in ${HEALTH_FILE}`));
  return out;
}

/** What changed between two lists, as lines: a new check, one gone, or a
 *  state or why that moved. Unchanged checks say nothing. */
export function changeLines(before: ReadonlyMap<string, HealthCheck>, after: readonly HealthCheck[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of after) {
    seen.add(c.id);
    const old = before.get(c.id);
    if (!old || old.state !== c.state || old.why !== c.why) out.push(checkLine(c));
  }
  for (const [id, c] of before) if (!seen.has(id)) out.push(`${dim("gone".padEnd(20))} ${bold(c.label)}  ${dim(id)}`);
  return out;
}

/** A starter health file for a repo's task files: its dev task, healed on
 *  its own, when it has one. */
export function starterFile(files: TaskFiles): string {
  const names = new Set(detectTasks(files).map((t) => t.name));
  if (files.repoFile) for (const p of parseTaskFile(files.repoFile).patches) names.add(p.name);
  const checks: RepoCheckDef[] = names.has("dev") ? [{ name: "dev", kind: "task", task: "dev", heal: "auto" }] : [];
  return `${JSON.stringify({ checks }, null, 2)}\n`;
}

export interface HealthDeps {
  fail: (msg: string) => never;
}

/** A backend as the CLI reaches it: its name and the addresses to try, in order. */
export interface Target {
  name: string;
  urls: string[];
}

/** Every backend the home one lists, home first at the address the CLI
 *  already reached, the rest at their tailnet address and then their public
 *  one (which a gate in front may refuse a terminal). */
export function targetsOf(home: string, self: string, list: readonly BackendEntry[]): Target[] {
  const out: Target[] = [{ name: self, urls: [home] }];
  for (const b of list) {
    if (b.name === self) continue;
    const urls = [b.tailnet, b.public].filter((u): u is string => typeof u === "string" && u.length > 0);
    if (urls.length > 0) out.push({ name: b.name, urls });
  }
  return out;
}

export class Unreachable extends Error {}

export const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One request to a backend at the first of its addresses that answers;
 *  a refusal by the backend is the answer, not a reason to try the next. */
export async function ask<T>(t: Target, method: string, path: string, body?: unknown): Promise<T> {
  const tried: string[] = [];
  for (const url of t.urls) {
    let res: Response;
    try {
      res = await fetch(`${url}${path}`, {
        method,
        redirect: "manual",
        signal: AbortSignal.timeout(8_000),
        headers: callerHeaders(url, undefined, body !== undefined ? { "content-type": "application/json" } : undefined),
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
    } catch (err) {
      tried.push(`${url}: ${errText(err)}`);
      continue;
    }
    const redirected = res.status >= 300 && res.status < 400;
    const out = redirected ? ({} as T & { error?: string; need?: string }) : ((await res.json().catch(() => ({}))) as T & { error?: string; need?: string });
    // canopy's own refusal names the right it wanted: that is the answer
    if ((res.status === 401 || res.status === 403) && typeof out.need === "string") throw new Error(out.error ?? `${t.name} refused: it needs the ${out.need} right`);
    // a sign-in gate or a redirect is not canopy answering
    if (res.status === 401 || redirected) {
      tried.push(`${url}: needs a sign-in`);
      continue;
    }
    if (!res.ok) throw new Error(out.error ?? `${t.name} answered ${res.status}`);
    return out;
  }
  throw new Unreachable(tried.join("; ") || "no address");
}

export async function healthCommand(argv: string[], { fail }: HealthDeps): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const on = take(args, "--on");
  const home = apiBase(given);
  if (!/^https?:\/\/[^/\s]+$/.test(home)) return fail(`--backend must be an http(s) origin, got ${home}`);
  const json = has(args, "--json");
  const sub = args[0] !== undefined && !args[0].startsWith("--") ? (args.shift() ?? "list") : "list";
  const homeTarget: Target = { name: "home", urls: [home] };

  /** every backend, or the one --backend or --on names */
  let known: Target[] | null = null;
  const targets = async (): Promise<Target[]> => {
    if (known) return known;
    if (given !== undefined && on === undefined) return (known = [homeTarget]);
    const listed = await ask<{ self?: string; backends?: BackendEntry[] }>(homeTarget, "GET", "/api/backends").catch(() => null);
    // an older backend lists none: it is the only one
    const all = listed?.self ? targetsOf(home, listed.self, listed.backends ?? []) : [homeTarget];
    if (on === undefined) return (known = all);
    const one = all.find((t) => t.name === on);
    return one ? (known = [one]) : fail(`no backend named ${on}; the home backend lists ${all.map((t) => t.name).join(", ")}`);
  };
  /** the backend a repo command speaks to: --on's, else home */
  const repoTarget = async (): Promise<Target> => (on === undefined ? homeTarget : ((await targets())[0] ?? homeTarget));
  const call = async <T>(t: Target, method: string, path: string, body?: unknown): Promise<T> =>
    ask<T>(t, method, path, body).catch((err: unknown) => fail(err instanceof Unreachable ? `${t.name} did not answer: ${err.message}` : errText(err)));

  /** an id as given, or the id of the repo at a path the backend scans */
  const repoId = async (t: Target, arg: string | undefined): Promise<string> => {
    if (!arg) return fail(HEALTH_USAGE);
    if (!(arg === "." || arg.startsWith("/") || arg.startsWith("./") || arg.startsWith("../") || arg.startsWith("~"))) return arg;
    const path = await realpath(resolve(arg.replace(/^~(?=$|\/)/, process.env["HOME"] ?? "~"))).catch(() => fail(`no such folder: ${arg}`));
    const tree = await call<ScanResult>(t, "GET", "/api/tree");
    const repo = tree.repos.find((r) => r.path === path);
    return repo ? repo.id : fail(`${t.name} does not scan ${path}`);
  };

  /** --repo is an id on every backend; a path is read on the first */
  const filter = async (first: Target): Promise<ListFilter> => {
    const repo = take(args, "--repo");
    return { bad: has(args, "--bad"), canopy: has(args, "--canopy"), ...(repo !== undefined ? { repo: await repoId(first, repo) } : {}) };
  };

  const repoInfo = async (t: Target, method: "GET" | "POST" | "DELETE", id: string, extra = "", body?: unknown) =>
    call<RepoHealthInfo>(t, method, `/api/repos/health?id=${encodeURIComponent(id)}${extra}`, body);

  /** each backend's checks, or why it did not answer */
  const everyList = async (ts: Target[]) =>
    Promise.all(
      ts.map(async (t) => {
        try {
          return { t, checks: (await ask<HealthInfo>(t, "GET", "/api/health")).checks, error: null };
        } catch (err) {
          return { t, checks: [] as HealthCheck[], error: errText(err) };
        }
      }),
    );

  switch (sub) {
    case "list": {
      const ts = await targets();
      const f = await filter(ts[0] ?? homeTarget);
      if (args.length > 0) return fail(HEALTH_USAGE);
      const all = (await everyList(ts)).map((r) => ({ ...r, checks: filterChecks(r.checks, f) }));
      const many = all.length > 1;
      if (json) {
        // one backend keeps the plain list scripts already read
        const one = all[0];
        const out = many || !one || one.error ? all.map((r) => ({ backend: r.t.name, ...(r.error ? { error: r.error } : { checks: r.checks }) })) : one.checks;
        console.log(JSON.stringify(out, null, 2));
      } else {
        for (const r of all) {
          if (many) console.log(bold(r.t.name));
          const pad = many ? "  " : "";
          if (r.error) console.log(`${pad}${rust("unreachable".padEnd(20))} ${dim(r.error)}`);
          else if (r.checks.length === 0) console.log(`${pad}${dim(f.bad ? "nothing is down" : "no checks")}`);
          else for (const c of r.checks) console.log(`${pad}${checkLine(c)}`);
        }
      }
      // a script or a compose healthcheck reads the exit code
      if (all.some((r) => r.error !== null || r.checks.some(isBad))) process.exitCode = 1;
      return;
    }
    case "show": {
      const id = args[0];
      if (!id) return fail("usage: canopy health show <id> [--on NAME]");
      const found = (await everyList(await targets())).flatMap((r) => r.checks.filter((c) => c.id === id).map((c) => ({ name: r.t.name, c })));
      if (found.length === 0) return fail(`no check ${id}; canopy health lists them`);
      if (json) console.log(JSON.stringify(found.length === 1 ? found[0]?.c : found.map((x) => ({ backend: x.name, ...x.c })), null, 2));
      else console.log(found.map((x) => (found.length > 1 ? [bold(`on ${x.name}`), ...showLines(x.c, Date.now())] : showLines(x.c, Date.now())).join("\n")).join("\n\n"));
      if (found.some((x) => isBad(x.c))) process.exitCode = 1;
      return;
    }
    case "heal": {
      const id = args[0];
      if (!id) return fail("usage: canopy health heal <id> [--on NAME]");
      const holders = (await everyList(await targets())).filter((r) => r.checks.some((c) => c.id === id)).map((r) => r.t);
      if (holders.length === 0) return fail(`no check ${id}; canopy health lists them`);
      if (holders.length > 1) return fail(`${id} is on ${holders.map((t) => t.name).join(" and ")}; say which with --on NAME`);
      const t = holders[0] ?? homeTarget;
      const c = await call<HealthCheck>(t, "POST", `/api/health/heal?id=${encodeURIComponent(id)}`);
      console.log(checkLine(c));
      if (isBad(c)) process.exitCode = 1;
      return;
    }
    case "watch": {
      const ts = await targets();
      const f = await filter(ts[0] ?? homeTarget);
      const many = ts.length > 1;
      await Promise.all(ts.map((t) => follow(t, f, many ? `${t.name} ` : "")));
      return fail("every event stream ended");
    }
    case "checks": {
      const t = await repoTarget();
      const info = await repoInfo(t, "GET", await repoId(t, args[0]));
      console.log(json ? JSON.stringify(info, null, 2) : defLines(info).join("\n"));
      if (info.errors.length > 0) process.exitCode = 1;
      return;
    }
    case "add": {
      const t = await repoTarget();
      const id = await repoId(t, args[0]);
      const name = args[1];
      if (!name) return fail(HEALTH_USAGE);
      const check = parseCheckArgs(name, args.slice(2));
      if (typeof check === "string") return fail(check);
      console.log(defLines(await repoInfo(t, "POST", id, "", check)).join("\n"));
      return;
    }
    case "rm": {
      const t = await repoTarget();
      const id = await repoId(t, args[0]);
      const name = args[1];
      if (!name) return fail("usage: canopy health rm <repo> <name>");
      const before = await repoInfo(t, "GET", id);
      const mine = before.checks.find((c) => c.name === name);
      if (!mine) return fail(`${id} has no check named ${name}`);
      if (mine.source === "repo") return fail(`${name} is in the repo's ${HEALTH_FILE}; edit that file to remove it`);
      console.log(defLines(await repoInfo(t, "DELETE", id, `&name=${encodeURIComponent(name)}`)).join("\n"));
      return;
    }
    case "lint": {
      const file = join(resolve(args[0] ?? "."), HEALTH_FILE);
      const text = await readFile(file, "utf8").catch(() => fail(`no ${file}`));
      const { checks, errors } = parseHealthFile(text);
      for (const c of checks) console.log(`${moss("ok")}  ${bold(c.name)}  ${c.kind} ${checkTarget(c)}`);
      for (const e of errors) console.log(`${rust("bad")} ${e}`);
      if (errors.length > 0) process.exitCode = 1;
      return;
    }
    case "init": {
      const dir = resolve(args[0] ?? ".");
      const file = join(dir, HEALTH_FILE);
      if (await readFile(file, "utf8").then(() => true, () => false)) return fail(`${file} is there already; canopy health lint checks it`);
      const files: TaskFiles = {};
      for (const [key, name] of Object.entries(TASK_FILES) as [keyof typeof TASK_FILES, string][]) {
        const text = await readFile(join(dir, name), "utf8").catch(() => undefined);
        if (text !== undefined) files[key] = text;
      }
      const starter = starterFile(files);
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, starter);
      console.log(`wrote ${file}`);
      console.log(dim(starter.trim()));
      return;
    }
    default:
      return fail(HEALTH_USAGE);
  }
}

/** Prints one backend's checks, then what changes on each `health` event,
 *  `prefix` before every line. Resolves when its stream ends or never opens. */
async function follow(t: Target, f: ListFilter, prefix: string): Promise<void> {
  let first: HealthCheck[];
  try {
    first = filterChecks((await ask<HealthInfo>(t, "GET", "/api/health")).checks, f);
  } catch (err) {
    console.log(`${prefix}${rust("unreachable".padEnd(20))} ${dim(errText(err))}`);
    return;
  }
  for (const c of first) console.log(`${prefix}${checkLine(c)}`);
  let last = new Map(first.map((c) => [c.id, c]));
  for (const url of t.urls) {
    const res = await fetch(`${url}/api/events`, { redirect: "manual", headers: callerHeaders(url) }).catch(() => null);
    if (!res?.ok || !res.body) continue;
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = "";
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        console.log(`${prefix}${rust("stream ended")}`);
        return;
      }
      buf += dec.decode(value, { stream: true });
      let cut: number;
      while ((cut = buf.indexOf("\n\n")) !== -1) {
        const frame = buf.slice(0, cut);
        buf = buf.slice(cut + 2);
        const data = frame.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        let ev: ServerEvent | null = null;
        try {
          // the server's own events: only a health one is read past its type
          ev = JSON.parse(data.slice(6)) as ServerEvent;
        } catch {
          // a frame that is not JSON is not ours
        }
        if (ev?.type !== "health" || !Array.isArray(ev.checks)) continue;
        const now = filterChecks(ev.checks, f);
        const at = new Date().toLocaleTimeString();
        for (const line of changeLines(last, now)) console.log(`${prefix}${dim(at)} ${line}`);
        last = new Map(now.map((c) => [c.id, c]));
      }
    }
  }
  console.log(`${prefix}${rust("no event stream")}`);
}
