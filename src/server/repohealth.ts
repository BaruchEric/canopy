/**
 * Repos' own health checks (docs/superpowers/specs/2026-10-12-health-design.md,
 * phase 2): each repo's `.canopy/health.json` with canopy's layer over it,
 * kept in the health hub as `repo:<id>:<name>`. core/repohealth.ts says
 * what may run where; this runs the probes and heals and keeps the hub's
 * list in step with the scan and the config.
 *
 * - A check whose def did not change keeps its timer and its history: a
 *   sync re-adds only what moved.
 * - A check canopy will not run here stays listed as off, saying why.
 * - A repo on another host has its file read over ssh at most every five
 *   minutes; a forge-only repo has canopy's layer alone.
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { checkEnv } from "../core/cli";
import { exec, onHost, type ExecResult } from "../core/exec";
import { fail, pass, type ProbeResult } from "../core/health";
import { parseLocator } from "../core/host";
import { CHECK_EVERY, HEALTH_FILE, healOf, mergeChecks, normalizeCheck, parseHealthFile, repoCheckId, type CheckContext } from "../core/repohealth";
import { healthFor, removeHealthCheck, setHealthCheck } from "../core/store";
import type { CanopyConfig, MergedCheck, Repo, RepoCheckDef, RepoHealthInfo, TaskInfo } from "../core/types";
import type { CheckDef, HealthHub } from "./health";

const HTTP_TIMEOUT = 5_000;
const PORT_TIMEOUT = 5_000;
const COMPOSE_TIMEOUT = 15_000;
const COMMAND_TIMEOUT = 30_000;
/** how long a remote repo's file is trusted before it is read again */
const REMOTE_FILE_TTL = 5 * 60_000;

export type Run = (argv: string[], cwd: string, timeoutMs: number) => Promise<ExecResult>;

/** through a login shell, as a workflow check runs, so the user's PATH applies */
const runHere: Run = (argv, cwd, timeoutMs) => exec(argv, { cwd, timeoutMs, env: checkEnv() });

export interface ProbeDeps {
  taskStatus: (repo: Repo, name: string) => Promise<Pick<TaskInfo, "status" | "exitCode"> | undefined>;
  restartTask: (repo: Repo, name: string) => Promise<void>;
  run?: Run;
}

const lastLine = (r: ExecResult): string => {
  const lines = `${r.stdout}\n${r.stderr}`.split("\n").map((l) => l.trim()).filter(Boolean);
  return lines.at(-1) ?? "";
};

const words = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** why a connection failed, plainly: a refusal is nothing listening */
function connectWhy(err: unknown): string {
  const code = err instanceof Error && "code" in err ? String(err.code) : "";
  if (code === "ECONNREFUSED") return "nothing listening";
  return code && !words(err).includes(code) ? `${words(err)} (${code})` : words(err);
}

async function probeHttp(url: string, expect: number | undefined): Promise<ProbeResult> {
  const t0 = performance.now();
  try {
    const res = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(HTTP_TIMEOUT) });
    void res.body?.cancel().catch(() => {});
    const ms = Math.round(performance.now() - t0);
    const good = expect !== undefined ? res.status === expect : res.status >= 200 && res.status < 400;
    return good ? pass(`${res.status} in ${ms}ms`) : fail(`answered ${res.status}${expect !== undefined ? `, not ${expect}` : ""}`, `${ms}ms`);
  } catch (err) {
    const name = err instanceof Error ? err.name : "";
    return fail(name === "TimeoutError" ? `no answer in ${HTTP_TIMEOUT / 1000}s` : connectWhy(err));
  }
}

async function probePort(host: string, port: number): Promise<ProbeResult> {
  const t0 = performance.now();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const socket = await Promise.race([
      Bun.connect({ hostname: host, port, socket: { data() {}, error() {} } }),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`no answer in ${PORT_TIMEOUT / 1000}s`)), PORT_TIMEOUT);
      }),
    ]);
    socket.end();
    return pass(`open in ${Math.round(performance.now() - t0)}ms`);
  } catch (err) {
    return fail(connectWhy(err));
  } finally {
    clearTimeout(timer);
  }
}

async function probeTask(repo: Repo, task: string, deps: ProbeDeps): Promise<ProbeResult> {
  const t = await deps.taskStatus(repo, task);
  if (!t) return fail(`no task named ${task}`);
  switch (t.status) {
    case "running":
      return pass("running");
    case "backoff":
      return { state: "healing", why: "keep running restarts it" };
    case "gave-up":
      return { state: "gave-up", why: "keep running gave up on it" };
    case "exited":
      return fail(`exited${t.exitCode !== undefined && t.exitCode !== null ? ` ${t.exitCode}` : ""}`);
    // a task nobody started, or one stopped by hand, is not a failure, and
    // healing it would start what the user meant to be down
    case "idle":
      return { state: "off", why: "not started" };
    case "stopped":
      return { state: "off", why: "stopped by hand" };
    case "failed":
      return fail("failed to start");
  }
}

const composeArgv = (file: string | undefined, ...rest: string[]): string[] => ["docker", "compose", ...(file ? ["-f", file] : []), ...rest];

export interface ComposeRow {
  State?: string;
  Health?: string;
  Status?: string;
}

/** a row's three fields, when they are strings */
function composeRow(v: unknown): ComposeRow | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>;
  const row: ComposeRow = {};
  for (const k of ["State", "Health", "Status"] as const) {
    const x = o[k];
    if (typeof x === "string") row[k] = x;
  }
  return row;
}

/** `docker compose ps --format json` prints one object per line (newer) or
 *  one array (older); either way, the service's rows */
export function composeRows(out: string): ComposeRow[] {
  const text = out.trim();
  if (!text) return [];
  const parse = (t: string): unknown => {
    try {
      return JSON.parse(t);
    } catch {
      return undefined;
    }
  };
  const whole = parse(text);
  const items: unknown[] = Array.isArray(whole) ? whole : whole !== undefined ? [whole] : text.split("\n").map(parse);
  return items.map(composeRow).filter((r): r is ComposeRow => r !== null);
}

async function probeCompose(repo: Repo, service: string, file: string | undefined, run: Run): Promise<ProbeResult> {
  const r = await run(composeArgv(file, "ps", "--format", "json", service), repo.path, COMPOSE_TIMEOUT);
  if (r.code !== 0) return fail(lastLine(r) || `docker compose exited ${r.code}`);
  const rows = composeRows(r.stdout);
  if (rows.length === 0) return fail(`${service} is not running`);
  const bad = rows.find((x) => x.State !== "running" || (x.Health !== undefined && x.Health !== "" && x.Health !== "healthy"));
  if (bad) return fail(`${service} ${bad.State ?? "unknown"}${bad.Health ? `, ${bad.Health}` : ""}`, bad.Status);
  return pass(rows[0]?.Status);
}

async function probeCommand(repo: Repo, cmd: string, run: Run): Promise<ProbeResult> {
  const r = await run(["sh", "-lc", cmd], repo.path, COMMAND_TIMEOUT);
  const line = lastLine(r);
  return r.code === 0 ? pass(line || undefined) : fail(line || `exited ${r.code}`, `exit ${r.code}`);
}

/** what a check's probe does */
export function probeFor(c: RepoCheckDef, repo: Repo, deps: ProbeDeps): () => Promise<ProbeResult> {
  const run = deps.run ?? runHere;
  switch (c.kind) {
    case "http":
      return () => probeHttp(c.url, c.expect);
    case "port":
      return () => probePort(c.host ?? "127.0.0.1", c.port);
    case "task":
      return () => probeTask(repo, c.task, deps);
    case "compose":
      return () => probeCompose(repo, c.service, c.file, run);
    case "command":
      return () => probeCommand(repo, c.run, run);
  }
}

/** what a check's heal does: its `fix`, else what its kind restarts, else
 *  nothing (an http or port check with no fix heals by no hand of canopy's) */
export function healFor(c: RepoCheckDef, repo: Repo, deps: ProbeDeps): (() => Promise<void>) | undefined {
  const run = deps.run ?? runHere;
  const ran = async (argv: string[], ms: number) => {
    const r = await run(argv, repo.path, ms);
    if (r.code !== 0) throw new Error(lastLine(r) || `exited ${r.code}`);
  };
  if (c.fix !== undefined) {
    const fix = c.fix;
    return () => ran(["sh", "-lc", fix], 60_000);
  }
  if (c.kind === "task") return () => deps.restartTask(repo, c.task);
  if (c.kind === "compose") return () => ran(composeArgv(c.file, "restart", c.service), 60_000);
  return undefined;
}

const probeTimeout = (c: RepoCheckDef): number =>
  c.kind === "command" ? COMMAND_TIMEOUT + 3_000 : c.kind === "compose" ? COMPOSE_TIMEOUT + 3_000 : 8_000;

export interface RepoHealthDeps extends ProbeDeps {
  hub: HealthHub;
  repos: () => Repo[];
  own: (repo: Repo) => Promise<boolean>;
  seed: (repo: Repo) => boolean;
  config: () => Promise<Pick<CanopyConfig, "health">>;
  /** a repo's health file's text, or null when it has none; the default reads it from disk or over ssh */
  readFile?: (repo: Repo) => Promise<string | null>;
  /** ms between syncs on the timer; 0 for none */
  every?: number;
}

async function readRepoFile(repo: Repo): Promise<string | null> {
  if (repo.forge) return null;
  const { host, path } = parseLocator(repo.path);
  if (host === null) return readFile(join(path, HEALTH_FILE), "utf8").catch(() => null);
  const r = await onHost(host, ["cat", `${path}/${HEALTH_FILE}`], { timeoutMs: 15_000 });
  return r.code === 0 ? r.stdout : null;
}

export class RepoHealth {
  /** the def each check was last added with, so a sync re-adds only what moved */
  private keys = new Map<string, string>();
  private info = new Map<string, RepoHealthInfo>();
  private remoteFiles = new Map<string, { at: number; text: string | null }>();
  private syncing: Promise<void> | null = null;
  private again = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private stopped = false;

  constructor(private readonly deps: RepoHealthDeps) {
    if (deps.every) this.timer = setInterval(() => void this.sync().catch(() => {}), deps.every);
  }

  /** what a repo's checks are, merged, with its file's errors */
  of(repoId: string): RepoHealthInfo {
    return this.info.get(repoId) ?? { checks: [], errors: [] };
  }

  /** One sync at a time; a call while one runs asks for one more after it. */
  sync(): Promise<void> {
    if (this.syncing) {
      this.again = true;
      return this.syncing;
    }
    this.syncing = (async () => {
      do {
        this.again = false;
        await this.syncOnce();
      } while (this.again && !this.stopped);
    })().finally(() => (this.syncing = null));
    return this.syncing;
  }

  private async fileOf(repo: Repo): Promise<string | null> {
    if (this.deps.readFile) return this.deps.readFile(repo);
    if (!repo.host) return readRepoFile(repo);
    const cached = this.remoteFiles.get(repo.path);
    if (cached && Date.now() - cached.at < REMOTE_FILE_TTL) return cached.text;
    const text = await readRepoFile(repo).catch(() => null);
    this.remoteFiles.set(repo.path, { at: Date.now(), text });
    return text;
  }

  private async syncOnce(): Promise<void> {
    const { hub } = this.deps;
    const cfg = await this.deps.config();
    const seen = new Set<string>();
    const repoIds = new Set<string>();
    for (const repo of this.deps.repos()) {
      if (this.stopped) return;
      const text = await this.fileOf(repo);
      const file = text === null ? { checks: [], errors: [] } : parseHealthFile(text);
      const canopy = healthFor(cfg, repo.path);
      if (file.checks.length === 0 && canopy.length === 0 && file.errors.length === 0) continue;
      repoIds.add(repo.id);
      const ctx: CheckContext = {
        own: await this.deps.own(repo).catch(() => false),
        local: !repo.host && !repo.forge,
        seed: this.deps.seed(repo),
      };
      const checks = mergeChecks(file.checks, canopy, ctx);
      this.info.set(repo.id, { checks, errors: file.errors });
      for (const c of checks) {
        const id = repoCheckId(repo.id, c.name);
        seen.add(id);
        const key = JSON.stringify([c, repo.path]);
        if (this.keys.get(id) === key && hub.has(id)) continue;
        this.keys.set(id, key);
        hub.add(this.defOf(repo, c, id));
        if (c.blocked) hub.report(id, { state: "off", why: c.blocked });
      }
    }
    for (const id of this.info.keys()) if (!repoIds.has(id)) this.info.delete(id);
    for (const id of hub.ids("repo:")) {
      if (seen.has(id)) continue;
      hub.remove(id);
      this.keys.delete(id);
    }
  }

  private defOf(repo: Repo, c: MergedCheck, id: string): CheckDef {
    const base: CheckDef = { id, label: c.name, scope: { kind: "repo", repoId: repo.id }, heal: healOf(c) };
    if (c.blocked) return base;
    const doHeal = healFor(c, repo, this.deps);
    return {
      ...base,
      every: (c.every ?? CHECK_EVERY) * 1000,
      probe: probeFor(c, repo, this.deps),
      timeout: probeTimeout(c),
      ...(doHeal ? { doHeal, healTimeout: 65_000 } : {}),
    };
  }

  /**
   * `GET /api/repos/health?id=` a repo's merged checks; `POST` with a check
   * stores it in canopy's layer; `DELETE ?id=&name=` takes one out of it.
   */
  async handle(req: Request, url: URL, repoOf: (id: string) => Repo | undefined): Promise<Response | null> {
    if (url.pathname !== "/api/repos/health") return null;
    const id = url.searchParams.get("id") ?? "";
    const repo = repoOf(id);
    if (!repo) return json({ error: `no repo ${id}` }, 404);
    if (req.method === "GET") return json(this.of(repo.id));
    if (req.method === "POST") {
      const body: unknown = await req.json().catch(() => null);
      const check = normalizeCheck(body);
      if (typeof check === "string") return json({ error: check }, 400);
      await setHealthCheck(repo.path, check);
      await this.sync();
      return json(this.of(repo.id));
    }
    if (req.method === "DELETE") {
      const name = url.searchParams.get("name") ?? "";
      await removeHealthCheck(repo.path, name);
      await this.sync();
      return json(this.of(repo.id));
    }
    return json({ error: "method not allowed" }, 405);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
