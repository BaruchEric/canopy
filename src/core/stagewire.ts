/**
 * The wire between canopy and the stage runner: one unix-socket connection
 * per process, one JSON object per line, bytes as base64. Pure and
 * browser-safe (no Buffer: base64 through btoa/atob over byte strings).
 */
/** Whether the stages container's fence holds, as the runner last probed
 *  it: true once its probe target timed out, false once it answered or the
 *  probe failed some other way, "unchecked" while no target is set or the
 *  first probe is still out. A hello from a runner older than the fence
 *  says nothing, which reads as "unchecked". */
export type Fenced = true | false | "unchecked";

export type StageRequest =
  | { t: "hello" }
  | { t: "spawn"; argv: string[]; cwd: string; env: Record<string, string> }
  | { t: "busy"; seed: string }
  /** git in a seed's top folder, as the stage user, for canopy's own reads
   *  and commits there: the runner adds SEED_GIT_FLAGS and builds the env
   *  itself (`gitEnv`) */
  | { t: "git"; seed: string; args: string[]; env: Record<string, string> };
export type StageFrame =
  | { t: "in"; d: string }
  | { t: "eof" }
  | { t: "kill" }
  | { t: "out"; d: string }
  | { t: "err"; d: string }
  | { t: "exit"; code: number | null }
  /** `fenced` is there only on a refusal for the fence: a spawn the runner
   *  would start once its fence is confirmed */
  | { t: "refused"; reason: string; fenced?: false | "unchecked" }
  | { t: "hello"; harnesses: string[]; fenced: Fenced; reason?: string }
  | { t: "busy"; busy: boolean };

export const STAGE_PROGRAMS: readonly string[] = ["claude", "codex", "sh"];
export const STAGE_PASSED_ENV: readonly string[] = ["CANOPY_RUN", "CANOPY_REPO", "CANOPY_BACKEND"];
export const STAGE_BASE_ENV: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
/** the only names a git request's env may carry. Anything else is refused,
 *  never dropped: without GIT_INDEX_FILE, say, `add -A` would write the
 *  seed's real index. */
export const SEED_GIT_ENV: readonly string[] = ["GIT_OPTIONAL_LOCKS", "GIT_AUTHOR_NAME", "GIT_AUTHOR_EMAIL", "GIT_COMMITTER_NAME", "GIT_COMMITTER_EMAIL"];
const CHUNK = 64 * 1024;

export const encodeFrame = (f: StageFrame | StageRequest): string => `${JSON.stringify(f)}\n`;

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrMap = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isStr);

export function parseFrame(line: string): StageFrame | StageRequest | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  const t = o["t"];
  const d = o["d"];
  if (t === "in" || t === "out" || t === "err") return isStr(d) ? { t, d } : null;
  if (t === "eof" || t === "kill") return { t };
  if (t === "hello") {
    if (!("harnesses" in o)) return { t };
    const h = o["harnesses"];
    if (!Array.isArray(h) || !h.every(isStr)) return null;
    const f = o["fenced"];
    const reason = o["reason"];
    return { t, harnesses: h, fenced: f === true || f === false ? f : "unchecked", ...(isStr(reason) ? { reason } : {}) };
  }
  if (t === "busy") {
    const seed = o["seed"];
    const busy = o["busy"];
    if (isStr(seed)) return { t, seed };
    return typeof busy === "boolean" ? { t, busy } : null;
  }
  if (t === "exit") {
    const code = o["code"];
    return code === null || typeof code === "number" ? { t, code } : null;
  }
  if (t === "refused") {
    const reason = o["reason"];
    if (!isStr(reason)) return null;
    const f = o["fenced"];
    return f === false || f === "unchecked" ? { t, reason, fenced: f } : { t, reason };
  }
  if (t === "spawn") {
    const { argv, cwd, env } = o;
    return Array.isArray(argv) && argv.every(isStr) && isStr(cwd) && isStrMap(env) ? { t, argv, cwd, env } : null;
  }
  if (t === "git") {
    const { seed, args, env } = o;
    return isStr(seed) && Array.isArray(args) && args.every(isStr) && isStrMap(env) ? { t, seed, args, env } : null;
  }
  return null;
}

/** argv and env shape only; the cwd's containment is the runner's to judge */
export function requestRefusal(req: StageRequest): string | null {
  if (req.t === "hello") return null;
  if (req.t === "busy") return req.seed.startsWith("/") ? null : "the seed must be an absolute path";
  if (req.t === "git") {
    if (!req.seed.startsWith("/")) return "the seed must be an absolute path";
    const off = Object.keys(req.env).find((k) => !SEED_GIT_ENV.includes(k));
    return off === undefined ? null : `a git request carries only ${SEED_GIT_ENV.join(", ")}, not ${off}`;
  }
  const prog = req.argv[0];
  if (prog === undefined || !STAGE_PROGRAMS.includes(prog)) {
    return `the stage runner starts only ${STAGE_PROGRAMS.join(", ")}, by bare program name`;
  }
  if (!req.cwd.startsWith("/")) return "the cwd must be an absolute path";
  return null;
}

/** The only names a runner may be told to pass on top of
 *  `STAGE_PASSED_ENV` (`CANOPY_STAGE_PASS_ENV`): the coordinator's runner
 *  passes the address it reaches canopy at and its run's token. */
export const STAGE_EXTRA_ENV: readonly string[] = ["CANOPY_API", "CANOPY_TOKEN"];

/** The extra names in a runner's `CANOPY_STAGE_PASS_ENV`, comma separated,
 *  or why the runner must not start: any name outside `STAGE_EXTRA_ENV` is
 *  refused rather than dropped, so a typo cannot widen a child's env.
 *  Unset or empty is no extra name. */
export function passEnvNames(raw: string | undefined): { names: string[] } | { refused: string } {
  const names: string[] = [];
  for (const part of (raw ?? "").split(",")) {
    const name = part.trim();
    if (!name) continue;
    if (!STAGE_EXTRA_ENV.includes(name)) {
      return { refused: `CANOPY_STAGE_PASS_ENV names ${name}, but a runner passes only ${STAGE_EXTRA_ENV.join(" and ")} on top of its own names` };
    }
    if (!names.includes(name)) names.push(name);
  }
  return { names };
}

/** The children's proxy env from a runner's `CANOPY_STAGE_PROXY`, or why
 *  the runner must not start. The coordinator's runner sets it to the
 *  egress proxy on its bridge's gateway (src/egress/), the one way out its
 *  fence leaves. It goes to the children alone: the runner's own fetch
 *  follows HTTP_PROXY, so the proxy names in the container's env would send
 *  its fence probe through the proxy, which answers, and the fence would
 *  read as down. The value must be http://<IPv4 address>:<port>: the
 *  coordinator has no DNS, and a value this cannot read would leave a child
 *  dialing out unproxied, so it is refused rather than dropped. NO_PROXY is
 *  the proxy's own host (where canopy listens too) and loopback. claude's
 *  nonessential traffic and updater are off, since behind the proxy they
 *  would only be refused. Unset or empty is no proxy and nothing added. */
export function proxyEnv(raw: string | undefined): { env: Record<string, string> } | { refused: string } {
  const v = (raw ?? "").trim();
  if (!v) return { env: {} };
  const refused = { refused: `CANOPY_STAGE_PROXY must be http://<IPv4 address>:<port>, not ${v}` };
  const m = /^http:\/\/(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3}):(\d{1,5})\/?$/.exec(v);
  if (!m) return refused;
  const [, ...parts] = m;
  const nums = parts.map(Number);
  const port = nums.pop() ?? 0;
  if (nums.some((n) => n > 255) || port < 1 || port > 65535) return refused;
  const host = nums.join(".");
  const url = `http://${host}:${port}`;
  const no = `${host},127.0.0.1,localhost`;
  return {
    env: {
      HTTPS_PROXY: url,
      https_proxy: url,
      HTTP_PROXY: url,
      http_proxy: url,
      NO_PROXY: no,
      no_proxy: no,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    },
  };
}

/** A spawn's env: the runner's own base, then `STAGE_PASSED_ENV` and any
 *  `extra` names (from `passEnvNames`) out of what canopy sent, then the
 *  runner's `net` (from `proxyEnv`), last so nothing canopy sent sets it. */
export function childEnv(
  own: Record<string, string | undefined>,
  asked: Record<string, string>,
  extra: readonly string[] = [],
  net: Record<string, string> = {},
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of STAGE_BASE_ENV) {
    const v = own[k];
    if (v !== undefined) out[k] = v;
  }
  for (const k of [...STAGE_PASSED_ENV, ...extra]) {
    const v = Object.hasOwn(asked, k) ? asked[k] : undefined;
    if (v !== undefined) out[k] = v;
  }
  return Object.assign(out, net);
}

/** A git request's env: the runner's PATH and locale, no home, no global or
 *  system config (so nothing a stage left in the home steers canopy's git),
 *  a ceiling at the stage root, no prompt, and git's own names from the
 *  request. */
export function gitEnv(own: Record<string, string | undefined>, asked: Record<string, string>, root: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of ["PATH", "LANG", "LC_ALL"]) {
    const v = own[k];
    if (v !== undefined) out[k] = v;
  }
  Object.assign(out, {
    HOME: "/nonexistent",
    XDG_CONFIG_HOME: "/nonexistent",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: root,
    GIT_TERMINAL_PROMPT: "0",
  });
  for (const k of SEED_GIT_ENV) {
    const v = Object.hasOwn(asked, k) ? asked[k] : undefined;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const toB64 =(bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s);
};
export const fromB64 = (d: string): Uint8Array => Uint8Array.from(atob(d), (c) => c.charCodeAt(0));

export function chunkB64(bytes: Uint8Array, max = CHUNK): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += max) out.push(toB64(bytes.subarray(i, i + max)));
  return out;
}

export const STAGE_AWAY = "the stage runner is not answering";
/** what the Runner throws for a stage while the runner is away: a flow
 *  parks on it instead of failing */
export class StageAwayError extends Error {
  /** the runner's absence by default; with no runner set up, the env words */
  constructor(message: string = STAGE_AWAY) {
    super(message);
    this.name = "StageAwayError";
  }
}

export const lineSplitter = (): ((chunk: string) => string[]) => {
  let tail = "";
  return (chunk) => {
    const parts = (tail + chunk).split("\n");
    tail = parts.pop() ?? "";
    return parts.filter((p) => p.length > 0);
  };
};
