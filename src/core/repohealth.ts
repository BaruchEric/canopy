/**
 * A repo's declared health checks (docs/superpowers/specs/2026-10-12-health-design.md,
 * phase 2): read from `.canopy/health.json`, with canopy's config per machine
 * over it by name, and held to what may run where. Pure and browser-safe;
 * the probes are in server/repohealth.ts.
 *
 * - `http` and `port` only reach out, so they run for any repo.
 * - `task`, `compose`, `command` and a `fix` run in the checkout, so only a
 *   local one, never a seed. From the repo's own file, `compose`, `command`
 *   and `fix` run only in a repo that is the user's: a clone's file must
 *   not run code here. canopy's layer is the user's own words, so it may.
 * - `auto` from a repo's own file holds only in an own repo; elsewhere it
 *   is a button.
 */

import { isTaskName } from "./tasks";
import type { MergedCheck, RepoCheckDef, RepoCheckKind, RepoHealMode } from "./types";

export const HEALTH_FILE = ".canopy/health.json";
/** seconds between probes when a check does not say */
export const CHECK_EVERY = 30;
/** the fewest seconds between probes */
export const CHECK_EVERY_MIN = 5;

const KINDS: readonly RepoCheckKind[] = ["http", "port", "task", "compose", "command"];
const HEALS: readonly RepoHealMode[] = ["auto", "button", "none"];

const str = (v: unknown): string | null => (typeof v === "string" && v.trim() ? v.trim() : null);

/** One check from untrusted JSON, or what is wrong with it. */
export function normalizeCheck(v: unknown): RepoCheckDef | string {
  if (!v || typeof v !== "object" || Array.isArray(v)) return "a check is an object";
  const o = v as Record<string, unknown>;
  const name = o["name"];
  if (!isTaskName(name)) return `bad check name: ${JSON.stringify(name)}`;
  const kind = o["kind"];
  if (typeof kind !== "string" || !(KINDS as readonly string[]).includes(kind)) return `${name}: kind is one of ${KINDS.join(", ")}`;
  const base: { name: string; fix?: string; heal?: RepoHealMode; while?: string; every?: number } = { name };
  const fix = str(o["fix"]);
  if (fix) base.fix = fix;
  const heal = o["heal"];
  if (heal !== undefined) {
    if (typeof heal !== "string" || !(HEALS as readonly string[]).includes(heal)) return `${name}: heal is auto, button or none`;
    base.heal = heal as RepoHealMode;
  }
  const during = o["while"];
  if (during !== undefined) {
    if (!isTaskName(during)) return `${name}: while names a task`;
    if (kind === "task") return `${name}: a task check needs no while`;
    base.while = during;
  }
  const every = o["every"];
  if (every !== undefined) {
    if (typeof every !== "number" || !Number.isFinite(every)) return `${name}: every is a number of seconds`;
    base.every = Math.max(CHECK_EVERY_MIN, Math.round(every));
  }
  switch (kind) {
    case "http": {
      const url = str(o["url"]);
      if (!url || !/^https?:\/\/\S+$/.test(url)) return `${name}: an http check needs an http(s) url`;
      const expect = o["expect"];
      if (expect !== undefined && (typeof expect !== "number" || !Number.isInteger(expect) || expect < 100 || expect > 599)) return `${name}: expect is an HTTP status`;
      return { ...base, kind, url, ...(typeof expect === "number" ? { expect } : {}) };
    }
    case "port": {
      const port = o["port"];
      if (typeof port !== "number" || !Number.isInteger(port) || port < 1 || port > 65535) return `${name}: a port check needs a port, 1 to 65535`;
      const host = str(o["host"]);
      return { ...base, kind, port, ...(host ? { host } : {}) };
    }
    case "task": {
      const task = o["task"];
      if (!isTaskName(task)) return `${name}: a task check needs a task's name`;
      return { ...base, kind, task };
    }
    case "compose": {
      const service = str(o["service"]);
      if (!service || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(service)) return `${name}: a compose check needs a service's name`;
      const file = str(o["file"]);
      return { ...base, kind, service, ...(file ? { file } : {}) };
    }
    case "command": {
      const run = str(o["run"]);
      if (!run) return `${name}: a command check needs run`;
      return { ...base, kind, run };
    }
  }
  return `${name}: kind is one of ${KINDS.join(", ")}`;
}

/** A list of checks from untrusted JSON: the good ones and what was wrong
 *  with the rest. A second check by one name is an error. */
export function normalizeChecks(list: unknown): { checks: RepoCheckDef[]; errors: string[] } {
  const checks: RepoCheckDef[] = [];
  const errors: string[] = [];
  if (!Array.isArray(list)) return { checks, errors: ["checks is a list"] };
  const seen = new Set<string>();
  for (const v of list) {
    const c = normalizeCheck(v);
    if (typeof c === "string") errors.push(c);
    else if (seen.has(c.name)) errors.push(`${c.name}: named twice`);
    else {
      seen.add(c.name);
      checks.push(c);
    }
  }
  return { checks, errors };
}

/** `.canopy/health.json`: `{ "checks": [...] }` */
export function parseHealthFile(text: string): { checks: RepoCheckDef[]; errors: string[] } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    return { checks: [], errors: [`${HEALTH_FILE} is not JSON: ${err instanceof Error ? err.message : String(err)}`] };
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return { checks: [], errors: [`${HEALTH_FILE} is an object with a checks list`] };
  return normalizeChecks((parsed as Record<string, unknown>)["checks"] ?? []);
}

export interface CheckContext {
  /** the user's own repo, by the rule tasks use */
  own: boolean;
  /** a checkout on this machine's disk (no host, no forge) */
  local: boolean;
  /** a seed of the incubator */
  seed: boolean;
}

const LOOPBACK = /^(127\.\d+\.\d+\.\d+|localhost|\[?::1\]?)$/i;

/** the host an http or port check reaches, or null for the other kinds */
function reaches(c: RepoCheckDef): string | null {
  if (c.kind === "port") return c.host ?? "127.0.0.1";
  if (c.kind !== "http") return null;
  try {
    return new URL(c.url).hostname;
  } catch {
    return null;
  }
}

/** what keeps a check from running here, or null */
function blockedWhy(c: MergedCheck, ctx: CheckContext): string | null {
  // the probe runs where canopy does: a loopback address there is not the
  // repo's machine
  const host = reaches(c);
  if (!ctx.local && host !== null && LOOPBACK.test(host)) return `${host} is this machine, not where the repo lives`;
  const runsHere = c.kind === "task" || c.kind === "compose" || c.kind === "command" || c.fix !== undefined;
  if (!runsHere) return null;
  if (ctx.seed) return "seeds run no checks of their own";
  if (!ctx.local) return "runs only on a checkout on this machine";
  if (!ctx.own && c.source === "repo" && (c.kind === "compose" || c.kind === "command" || c.fix !== undefined)) return "not run: not your repo";
  return null;
}

/**
 * The repo's checks and canopy's over them, by name (a check canopy's
 * layer names replaces the repo's whole), each held to what may run here.
 */
export function mergeChecks(repo: readonly RepoCheckDef[], canopy: readonly RepoCheckDef[], ctx: CheckContext): MergedCheck[] {
  const order: string[] = [];
  const by = new Map<string, MergedCheck>();
  const layer = (list: readonly RepoCheckDef[], source: "repo" | "canopy") => {
    for (const c of list) {
      if (!by.has(c.name)) order.push(c.name);
      by.set(c.name, { ...c, source });
    }
  };
  layer(repo, "repo");
  layer(canopy, "canopy");
  return order.map((name) => {
    const c = by.get(name)!;
    const out: MergedCheck = { ...c };
    if (c.heal === "auto" && c.source === "repo" && !ctx.own) out.heal = "button";
    const why = blockedWhy(c, ctx);
    if (why) out.blocked = why;
    return out;
  });
}

/** the heal mode a merged check runs with: a blocked one heals by nothing */
export const healOf = (c: MergedCheck): RepoHealMode => (c.blocked ? "none" : (c.heal ?? "button"));

/** the id the hub keeps a repo's check under */
export const repoCheckId = (repoId: string, name: string): string => `repo:${repoId}:${name}`;

/** what a check looks at, in a few words for its row */
export function checkTarget(c: RepoCheckDef): string {
  switch (c.kind) {
    case "http":
      return c.url;
    case "port":
      return `${c.host ?? "127.0.0.1"}:${c.port}`;
    case "task":
      return `task ${c.task}`;
    case "compose":
      return `compose ${c.service}`;
    case "command":
      return c.run;
  }
}
