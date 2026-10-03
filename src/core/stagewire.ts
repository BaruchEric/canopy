/**
 * The wire between canopy and the stage runner: one unix-socket connection
 * per process, one JSON object per line, bytes as base64. Pure and
 * browser-safe (no Buffer: base64 through btoa/atob over byte strings).
 */
export type StageRequest =
  | { t: "hello" }
  | { t: "spawn"; argv: string[]; cwd: string; env: Record<string, string> }
  | { t: "busy"; seed: string };
export type StageFrame =
  | { t: "in"; d: string }
  | { t: "eof" }
  | { t: "kill" }
  | { t: "out"; d: string }
  | { t: "err"; d: string }
  | { t: "exit"; code: number | null }
  | { t: "refused"; reason: string }
  | { t: "hello"; harnesses: string[] }
  | { t: "busy"; busy: boolean };

export const STAGE_PROGRAMS: readonly string[] = ["claude", "codex", "sh"];
export const STAGE_PASSED_ENV: readonly string[] = ["CANOPY_RUN", "CANOPY_REPO", "CANOPY_BACKEND"];
export const STAGE_BASE_ENV: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
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
    return Array.isArray(h) && h.every(isStr) ? { t, harnesses: h } : null;
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
    return isStr(reason) ? { t, reason } : null;
  }
  if (t === "spawn") {
    const { argv, cwd, env } = o;
    return Array.isArray(argv) && argv.every(isStr) && isStr(cwd) && isStrMap(env) ? { t, argv, cwd, env } : null;
  }
  return null;
}

/** argv and env shape only; the cwd's containment is the runner's to judge */
export function requestRefusal(req: StageRequest): string | null {
  if (req.t === "hello") return null;
  if (req.t === "busy") return req.seed.startsWith("/") ? null : "the seed must be an absolute path";
  const prog = req.argv[0];
  if (prog === undefined || !STAGE_PROGRAMS.includes(prog)) {
    return `the stage runner starts only ${STAGE_PROGRAMS.join(", ")}, by bare program name`;
  }
  if (!req.cwd.startsWith("/")) return "the cwd must be an absolute path";
  return null;
}

export function childEnv(own: Record<string, string | undefined>, asked: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of STAGE_BASE_ENV) {
    const v = own[k];
    if (v !== undefined) out[k] = v;
  }
  for (const k of STAGE_PASSED_ENV) {
    const v = Object.hasOwn(asked, k) ? asked[k] : undefined;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const toB64 = (bytes: Uint8Array): string => {
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
