/**
 * The ranger, canopy's always-on agent (docs/superpowers/specs/2026-10-10-ranger-design.md):
 * the pure part. Its settings as stored, the claude argv it starts with
 * (never yolo), the brief it is told, when a fresh conversation is due and
 * whether it is quiet enough for one, and its wakes: reading one from a
 * request, when it next fires, and the line canopy DMs it. Browser-safe;
 * the hub that runs it is server/ranger.ts.
 */

import { CLOCK_RE, isCron, lastClock, nextFire, parseCron, parseWhen } from "./cron";
import { agentArgs, splitArgs } from "./harness";
import { isProfileName } from "./route";
import { HANDLE_RE } from "./tailchan";
import type { AgentSettings, AgentState, RangerFresh, RangerHome, RangerSettings, RangerWake, RangerWakeBy } from "./types";

export const RANGER_HANDLE = "ranger";

/** the session's display name (`--name`), what `/resume` and the prompt's rule show */
export const RANGER_NAME = "ranger";

export const RANGER_FRESH: RangerFresh = { daily: "04:00", maxMb: 25 };

export const RANGER_DEFAULTS: RangerSettings = { on: false, profile: null, handle: null, telegram: false, fresh: { ...RANGER_FRESH }, home: "own" };

/** the plugin the ranger owns the Telegram bot through */
export const TELEGRAM_PLUGIN = "telegram@claude-plugins-official";

/** the biggest transcript size a fresh start can wait for, in MB */
const MAX_MB = 1000;

function normalizeFresh(v: unknown): RangerFresh {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...RANGER_FRESH };
  const f = v as Record<string, unknown>;
  const daily = f["daily"] === null ? null : typeof f["daily"] === "string" && CLOCK_RE.test(f["daily"]) ? f["daily"] : RANGER_FRESH.daily;
  const mb = f["maxMb"];
  const maxMb = mb === null ? null : typeof mb === "number" && Number.isFinite(mb) && mb >= 1 && mb <= MAX_MB ? Math.round(mb) : RANGER_FRESH.maxMb;
  return { daily, maxMb };
}

/** The stored settings, field by field: anything that does not read falls
 *  back to its default rather than failing the config. */
export function normalizeRanger(v: unknown): RangerSettings {
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ...RANGER_DEFAULTS, fresh: { ...RANGER_FRESH } };
  const r = v as Record<string, unknown>;
  return {
    on: r["on"] === true,
    profile: isProfileName(r["profile"]) ? r["profile"] : null,
    handle: typeof r["handle"] === "string" && HANDLE_RE.test(r["handle"]) ? r["handle"] : null,
    telegram: r["telegram"] === true,
    fresh: normalizeFresh(r["fresh"]),
    home: r["home"] === "root" ? "root" : "own",
  };
}

const isHome = (v: unknown): v is RangerHome => v === "own" || v === "root";

/**
 * A change to the settings as a request sends it, applied over `base`. Only
 * the fields present change; a field that is present and does not read is
 * refused with the reason, rather than quietly kept.
 */
export function patchRanger(base: RangerSettings, body: unknown): RangerSettings | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "send the settings as an object";
  const b = body as Record<string, unknown>;
  const out: RangerSettings = { ...base, fresh: { ...base.fresh } };
  if ("on" in b) {
    if (typeof b["on"] !== "boolean") return "on is true or false";
    out.on = b["on"];
  }
  if ("profile" in b) {
    if (b["profile"] !== null && !isProfileName(b["profile"])) return "profile is a profile's name, or null for the default";
    out.profile = b["profile"] as string | null;
  }
  if ("handle" in b) {
    const h = b["handle"];
    if (h !== null && !(typeof h === "string" && HANDLE_RE.test(h))) return "a handle is lower-case letters, digits, dots, dashes and underscores, at most 40";
    out.handle = h === RANGER_HANDLE ? null : (h as string | null);
  }
  if ("telegram" in b) {
    if (typeof b["telegram"] !== "boolean") return "telegram is true or false";
    out.telegram = b["telegram"];
  }
  if ("home" in b) {
    if (!isHome(b["home"])) return "home is own (a folder of its own) or root (the scan root)";
    out.home = b["home"];
  }
  if ("fresh" in b) {
    const f = b["fresh"];
    if (!f || typeof f !== "object" || Array.isArray(f)) return "fresh is { daily, maxMb }";
    const fr = f as Record<string, unknown>;
    if ("daily" in fr) {
      if (fr["daily"] !== null && !(typeof fr["daily"] === "string" && CLOCK_RE.test(fr["daily"]))) return "fresh.daily is HH:MM on the 24-hour clock, or null";
      out.fresh.daily = fr["daily"] as string | null;
    }
    if ("maxMb" in fr) {
      const mb = fr["maxMb"];
      if (mb !== null && !(typeof mb === "number" && Number.isFinite(mb) && mb >= 1 && mb <= MAX_MB)) return `fresh.maxMb is 1 to ${MAX_MB}, or null`;
      out.fresh.maxMb = mb === null ? null : Math.round(mb as number);
    }
  }
  return out;
}

export const rangerHandle = (s: RangerSettings): string => s.handle ?? RANGER_HANDLE;

/**
 * Flags the ranger never takes from a profile's extra box, each with
 * whether it carries a value: the ones that skip permissions (it is
 * reachable by any handle on the tailnet), and the ones canopy sets itself
 * (which conversation, its name, its prompt, its settings and channels) or
 * that would make it something other than an interactive session.
 */
const DROPPED: Record<string, boolean> = {
  "--dangerously-skip-permissions": false,
  "--allow-dangerously-skip-permissions": false,
  "--permission-mode": true,
  "--resume": true,
  "-r": true,
  "--continue": false,
  "-c": false,
  "--session-id": true,
  "--fork-session": false,
  "--name": true,
  "-n": true,
  "--append-system-prompt": true,
  "--append-system-prompt-file": true,
  "--system-prompt": true,
  "--system-prompt-file": true,
  "--settings": true,
  "--channels": true,
  "--dangerously-load-development-channels": true,
  "-p": false,
  "--print": false,
};

/** A permission mode the ranger may run in: any but bypass. */
const SAFE_MODE = /^(default|acceptEdits|plan|auto|dontAsk)$/;

/** The profile's extra flags minus the dropped ones; a `--permission-mode`
 *  other than bypass is kept. */
export function rangerExtra(extra: string): string[] {
  const words = splitArgs(extra);
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i] ?? "";
    const [flag = "", inline] = w.startsWith("--") ? w.split(/=(.*)/s) : [w];
    if (flag === "--permission-mode") {
      const mode = inline ?? words[i + 1] ?? "";
      if (inline === undefined) i++;
      if (SAFE_MODE.test(mode)) out.push("--permission-mode", mode);
      continue;
    }
    if (flag in DROPPED) {
      if (DROPPED[flag] && inline === undefined) i++;
      continue;
    }
    out.push(w);
  }
  return out;
}

export interface RangerLaunch {
  /** the profile's settings; yolo is dropped whatever they say */
  settings: AgentSettings;
  /** the conversation's id, canopy's own */
  session: string;
  /** whether the conversation is new (`--session-id`) or picked up (`--resume`) */
  first: boolean;
  /** the file the filled-in brief was written to, which both the server
   *  and the session's machine see (the config dir) */
  briefFile: string;
  telegram: boolean;
  /** the opening prompt, last on the line (`rangerHello`) */
  hello?: string;
  /** a folder beside its own to work in (`--add-dir`): the scan root, when it runs in a folder of its own */
  addDir?: string;
}

/**
 * The prompt every start opens with. A session that has had no turn yet
 * has no tailchan Stop hook waiting on its handle, so a DM to it would sit
 * unread until someone typed; one short turn arms that waiter, and the
 * prompt hook hands the turn whatever came while it was down. It opens
 * with "[canopy]" so claude never reads its first word as a subcommand.
 */
export function rangerHello(kind: "new" | "fresh" | "resume"): string {
  const what =
    kind === "resume" ? "canopy started you again on this conversation" : kind === "fresh" ? "this is a fresh conversation; your brief names the last one" : "this is your first conversation";
  return `[canopy] ${what}. Act on any message tailchan hands you with this; otherwise answer "ready" and wait.`;
}

/**
 * The argv the ranger runs: claude with the profile's model, effort and
 * extra flags but never yolo, then its name, the brief, Telegram when it
 * owns the bot, the conversation it is on, and the opening prompt.
 */
export function rangerArgv(l: RangerLaunch): string[] {
  const flags = agentArgs({ ...l.settings, harness: "claude", yolo: false, extra: "" });
  return [
    "claude",
    ...flags,
    ...rangerExtra(l.settings.extra),
    // ahead of --name: claude's --add-dir takes every plain word after it
    ...(l.addDir ? ["--add-dir", l.addDir] : []),
    "--name",
    RANGER_NAME,
    "--append-system-prompt-file",
    l.briefFile,
    ...(l.telegram ? ["--settings", JSON.stringify({ enabledPlugins: { [TELEGRAM_PLUGIN]: true } }), "--channels", `plugin:${TELEGRAM_PLUGIN}`] : []),
    l.first ? "--session-id" : "--resume",
    l.session,
    ...(l.hello ? [l.hello] : []),
  ];
}

export interface BriefVars {
  backend: string;
  handle: string;
  root: string;
  /** the folder it runs in */
  home: string;
  /** the previous conversation's transcript, after a fresh start */
  previous: string | null;
  telegram: boolean;
}

/**
 * The brief with its `{{name}}` slots filled. A `{{#previous}}…{{/previous}}`
 * or `{{#telegram}}…{{/telegram}}` block stays only when that var is set.
 * An unknown slot is left as it was, so a typo shows rather than vanishing.
 */
export function rangerBrief(template: string, v: BriefVars): string {
  const blocks = template.replace(/\{\{#(previous|telegram)\}\}([\s\S]*?)\{\{\/\1\}\}/g, (_m, name: string, body: string) =>
    (name === "previous" ? v.previous : v.telegram) ? body : "",
  );
  const vals: Record<string, string> = { backend: v.backend, handle: v.handle, root: v.root, home: v.home, previous: v.previous ?? "" };
  return blocks
    .replace(/\{\{(\w+)\}\}/g, (m, name: string) => vals[name] ?? m)
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** what Claude's trust dialog says, seen on the ranger's pane (Claude Code 2.1.296) */
export const TRUST_RE = /Yes, I trust this folder|Is this a project you created or one you trust|Do you trust the files in this folder/;

/** Whether a card says its agent is idle at its prompt. Claude's own
 *  notice after a minute at the prompt reaches the card as waiting "your
 *  turn" (tailchan's `idle_prompt`), which for the ranger, reached by DM,
 *  is idle too; a permission or a question waiting is not. */
export const cardIdle = (c: { state: AgentState; waiting: string | null }): boolean => c.state === "idle" || (c.state === "waiting" && c.waiting === "your turn");

/** how long nothing must have happened on the pane before a fresh start */
export const RANGER_QUIET = 10 * 60_000;

/**
 * Which rule makes a fresh conversation due, or null: the transcript past
 * its size, or the daily hour passed since the conversation began.
 */
export function freshDue(o: { now: number; fresh: RangerFresh; sessionAt: number | undefined; bytes: number | undefined }): "size" | "daily" | null {
  if (o.fresh.maxMb !== null && o.bytes !== undefined && o.bytes > o.fresh.maxMb * 1024 * 1024) return "size";
  if (o.fresh.daily !== null && o.sessionAt !== undefined) {
    const mark = lastClock(o.fresh.daily, o.now);
    if (mark !== null && o.sessionAt < mark) return "daily";
  }
  return null;
}

/**
 * Whether the ranger is quiet enough to be moved to a fresh conversation:
 * its card (when there is one) says idle (`cardIdle`), and nothing came out of its pane
 * and nobody typed into it for `quiet`.
 */
export function isQuiet(o: { now: number; card: { state: AgentState; waiting: string | null } | undefined; lastOutput: number | undefined; lastInput: number | undefined; quiet?: number }): boolean {
  const span = o.quiet ?? RANGER_QUIET;
  if (o.card !== undefined && !cardIdle(o.card)) return false;
  if (o.lastOutput !== undefined && o.now - o.lastOutput < span) return false;
  if (o.lastInput !== undefined && o.now - o.lastInput < span) return false;
  return true;
}

/** the longest prompt a wake carries */
export const WAKE_PROMPT_MAX = 2000;

/** how many wakes the ranger can hold at once */
export const WAKES_MAX = 100;

/** a run's id, as the runner makes them */
const RUN_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * A wake as a request asks for it: a prompt and exactly one of `at` (unix
 * ms), `when` (as `parseWhen` reads it), `cron` or `run`. The id comes from
 * the caller, so the server can make it random.
 */
export function readWake(body: unknown, by: RangerWakeBy, id: string, now: number): RangerWake | string {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "send the wake as an object";
  const b = body as Record<string, unknown>;
  const prompt = typeof b["prompt"] === "string" ? b["prompt"].trim() : "";
  if (!prompt) return "a wake needs a prompt";
  if (prompt.length > WAKE_PROMPT_MAX) return `a wake's prompt is at most ${WAKE_PROMPT_MAX} characters`;
  const kinds = ["at", "when", "cron", "run"].filter((k) => b[k] !== undefined && b[k] !== null && b[k] !== "");
  if (kinds.length !== 1) return "a wake has one of at, when, cron or run";
  const base = { id, by, prompt, created: now };
  if (kinds[0] === "cron") {
    const line = b["cron"];
    if (typeof line !== "string") return "cron is a five-field line";
    const c = parseCron(line);
    if ("error" in c) return c.error;
    const next = nextFire(c, now);
    if (next === null) return `${line} never fires`;
    return { ...base, cron: line.trim(), next };
  }
  if (kinds[0] === "run") {
    if (typeof b["run"] !== "string" || !RUN_ID.test(b["run"])) return "run is a run's id";
    return { ...base, run: b["run"] };
  }
  const when = kinds[0] === "at" ? b["at"] : b["when"];
  const ms = typeof when === "number" ? (when > now ? when : { error: "that time has already passed" }) : typeof when === "string" ? parseWhen(when, now) : { error: "at is unix ms, when is a time as typed" };
  if (typeof ms !== "number") return ms.error;
  return { ...base, at: ms, next: ms };
}

/** A wake as read back off disk, or null when it does not check out. */
export function parseWake(v: unknown): RangerWake | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const w = v as Record<string, unknown>;
  if (typeof w["id"] !== "string" || !/^[0-9a-f]{8}$/.test(w["id"])) return null;
  if (w["by"] !== "eric" && w["by"] !== "ranger") return null;
  if (typeof w["prompt"] !== "string" || !w["prompt"] || w["prompt"].length > WAKE_PROMPT_MAX) return null;
  if (typeof w["created"] !== "number") return null;
  const base: RangerWake = { id: w["id"], by: w["by"], prompt: w["prompt"], created: w["created"] };
  const next = typeof w["next"] === "number" ? { next: w["next"] } : {};
  if (isCron(w["cron"])) return { ...base, cron: w["cron"], ...next };
  if (typeof w["at"] === "number") return { ...base, at: w["at"], next: typeof w["next"] === "number" ? w["next"] : w["at"] };
  if (typeof w["run"] === "string" && RUN_ID.test(w["run"])) return { ...base, run: w["run"] };
  return null;
}

/** what a wake says when it reaches the ranger, its kind and id first so
 *  the ranger tells it from an ordinary DM (the brief says what the
 *  prefixes mean) */
export function wakeLine(w: RangerWake, run?: { status: string; repo: string } | null): string {
  const tag = w.by === "eric" && w.cron ? `[cron ${w.id}]` : `[wake ${w.id}]`;
  if (w.run) {
    const what = run ? `run ${w.run} in ${run.repo} ended ${run.status}` : `run ${w.run} is gone (canopy restarted, or it was dismissed)`;
    return `${tag} ${what}. ${w.prompt}`;
  }
  return `${tag} ${w.prompt}`;
}

/** when a cron wake fires after it just did, or null when it never will */
export function cronAfter(line: string, now: number): number | null {
  const c = parseCron(line);
  return "error" in c ? null : nextFire(c, now);
}
