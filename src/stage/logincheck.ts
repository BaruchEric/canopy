/**
 * What the stage runner says of the stages' claude login in its hello, so
 * canopy knows a dead login before a project spends a stage on it, and the
 * token the runner hands a stage's claude. A `/login` made in the container
 * lapses about 30 days after it was made, used or not, and claude then
 * empties both tokens in the file; nothing else shows it until a stage
 * answers "OAuth session expired". A token from `claude setup-token`, saved
 * beside the login as `LOGIN_TOKEN_FILE`, lasts a year.
 *
 * Both files sit in a folder the stage user writes, and the runner may be
 * root: each is opened without following a link and without blocking, must
 * be a plain file with one name, and is read to a fixed size and no
 * further. Only a state and a time ever leave in a hello, never a token.
 *
 * What is on file says nothing of a token revoked at claude.ai or a copied
 * login whose source refreshed first, so the runner also checks the login
 * with Anthropic (`LoginProber`): one `claude -p` turn, as a stage's claude
 * would sign in, at most once a day while the login on file stays the same.
 * Its result rides in the hello; a token never does. Bun.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { LOGIN_TOKEN_FILE, PROBE_WORDS_MAX, refusesLogin, type LoginProbe, type StageLogin } from "../core/stagewire";

/** a login file past this size is not one */
const LOGIN_MAX = 64 * 1024;
/** a token file past this size is not one */
const TOKEN_MAX = 4096;
/** one token: printable, no space, long enough to be one */
const TOKEN = /^[\x21-\x7e]{20,}$/;

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const filled = (v: unknown): boolean => typeof v === "string" && v.trim() !== "";
/** a time in ms claude wrote, or undefined for none (it writes 0 for a token it dropped) */
const time = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined);
const withUntil = <H extends "login" | "expired">(how: H, until: number | undefined): { how: H; until?: number } => (until === undefined ? { how } : { how, until });

/** The login a `.credentials.json`'s text holds, at `now`; null for no
 *  file. A refresh token still in its time is a login until it lapses. With
 *  none, an access token works until its own time. Anything else on file
 *  is expired, and a file claude could not sign in with at all is none.
 *  Pure. */
export function loginOf(text: string | null, now: number): StageLogin {
  if (text === null) return { how: "none" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { how: "none" };
  }
  const oauth = isRecord(parsed) ? parsed["claudeAiOauth"] : null;
  if (!isRecord(oauth)) return { how: "none" };
  const refreshUntil = time(oauth["refreshTokenExpiresAt"]);
  const accessUntil = time(oauth["expiresAt"]);
  if (filled(oauth["refreshToken"])) {
    return refreshUntil !== undefined && refreshUntil <= now ? { how: "expired", until: refreshUntil } : withUntil("login", refreshUntil);
  }
  if (filled(oauth["accessToken"]) && accessUntil !== undefined && accessUntil > now) return { how: "login", until: accessUntil };
  return withUntil("expired", refreshUntil ?? accessUntil);
}

/** a node fs error's code, or undefined */
const codeOf = (e: unknown): string | undefined => (isRecord(e) && typeof e["code"] === "string" ? e["code"] : undefined);

/** The file's text, null when it is not there, undefined when it is there
 *  but not a plain file of at most `max` bytes that this may read. At most
 *  `max + 1` bytes are ever read, whatever the file grows to after the
 *  stat. */
async function readPlain(file: string, max: number): Promise<string | null | undefined> {
  let fh;
  try {
    fh = await open(file, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
  } catch (e) {
    return codeOf(e) === "ENOENT" ? null : undefined;
  }
  try {
    const st = await fh.stat();
    if (!st.isFile() || st.nlink !== 1 || st.size > max) return undefined;
    const buf = Buffer.alloc(max + 1);
    let got = 0;
    while (got < buf.length) {
      const { bytesRead } = await fh.read(buf, got, buf.length - got, got);
      if (bytesRead === 0) break;
      got += bytesRead;
    }
    return got > max ? undefined : buf.subarray(0, got).toString("utf8");
  } catch {
    return undefined;
  } finally {
    await fh.close();
  }
}

/** the runner's claude config folder: `CLAUDE_CONFIG_DIR`, else HOME's `.claude`; "" for neither */
const configDir = (env: Record<string, string | undefined>): string => env["CLAUDE_CONFIG_DIR"] || (env["HOME"] ? join(env["HOME"], ".claude") : "");

/** The runner's own claude token: `LOGIN_TOKEN_FILE` in its claude config
 *  folder, when that holds one line of one token. Null for no folder, no
 *  file, or anything else in it. The runner hands it to a stage's claude
 *  (`loginEnv`); it never goes into a frame. */
export async function stageToken(env: Record<string, string | undefined>): Promise<string | null> {
  const dir = configDir(env);
  if (!dir) return null;
  const text = await readPlain(join(dir, LOGIN_TOKEN_FILE), TOKEN_MAX);
  const token = (text ?? "").trim();
  return TOKEN.test(token) ? token : null;
}

/** The stages' claude login as the runner's hello says it: its own token
 *  (`stageToken`) when it holds one, else what `.credentials.json` in the
 *  same folder holds. Undefined, which the hello leaves out, when there is
 *  nothing to go on: no folder named, a file in a shape this will not read,
 *  or no file on a Mac, where claude keeps its login in the Keychain. */
export async function claudeLogin(env: Record<string, string | undefined>, now: number = Date.now(), platform: string = process.platform): Promise<StageLogin | undefined> {
  if ((await stageToken(env)) !== null) return { how: "token" };
  const dir = configDir(env);
  if (!dir) return undefined;
  const text = await readPlain(join(dir, ".credentials.json"), LOGIN_MAX);
  if (text === undefined) return undefined;
  if (text === null && platform !== "linux") return undefined;
  return loginOf(text, now);
}

/** The check's command line after `claude`: one turn of the cheapest model,
 *  with the stages' own user settings (as a stage reads them) and no MCP
 *  server, asking for one word back. */
export const PROBE_ARGS: readonly string[] = ["-p", "--model", "haiku", "--max-turns", "1", "--setting-sources", "user", "--strict-mcp-config", "Reply with the one word ok."];
/** a check that took the login holds this long while the login stays the same */
export const PROBE_EVERY = 24 * 3600_000;
/** a refused check, or one that could not run, is tried again after this:
 *  a refused turn spends nothing, and a fix that keeps the same login (an
 *  account put right) is seen within the hour */
export const PROBE_AGAIN = 3600_000;
/** how long the check's claude may take */
export const PROBE_MS = 120_000;

/** a token, or anything shaped like one, in claude's words */
const TOKENISH = /sk-ant-[A-Za-z0-9_-]+/g;

/** What one check's claude said, as the hello carries it: exit 0 is a turn
 *  that came back; claude's words for a refused login are a refusal; any
 *  other end could not say either way. Words are one line, with anything
 *  shaped like a token taken out, and cut short. Pure. */
export function probeResult(r: { code: number | null; out: string; err: string; timedOut?: boolean }, at: number): LoginProbe {
  if (r.timedOut) return { said: "unrun", at, words: `claude -p did not answer within ${Math.round(PROBE_MS / 1000)} s` };
  if (r.code === 0) return { said: "ok", at };
  const words = `${r.err}\n${r.out}`.replace(TOKENISH, "(a token)").replace(/\s+/g, " ").trim().slice(0, PROBE_WORDS_MAX);
  if (refusesLogin(words)) return { said: "refused", at, words };
  return { said: "unrun", at, words: words || `claude -p ended with exit ${r.code ?? "unknown"} and said nothing` };
}

/** Which login a check is of, so a new one is checked at once and an old
 *  check never speaks for it: a token by a hash of it (kept in the runner,
 *  never sent), a `/login` by when it lapses (a new one lapses on a new
 *  day; a refresh keeps the day). Null when there is nothing to check: a
 *  login on file that is dead or missing already says so, and a runner
 *  that cannot tell says nothing. Pure. */
export function loginKey(login: StageLogin | undefined, token: string | null): string | null {
  if (login?.how === "token") return `token:${token ? createHash("sha256").update(token).digest("hex").slice(0, 16) : ""}`;
  if (login?.how === "login") return `login:${login.until ?? ""}`;
  return null;
}

/** The runner's check of its login with Anthropic: `observe`, called at
 *  each hello with the login on file now, answers the last check of that
 *  login and starts a new one when it is due, one at a time. `run` makes
 *  one check, or answers null when it may not run now (the fence is not
 *  confirmed), which keeps nothing and is asked again at the next hello. */
export class LoginProber {
  private last: { key: string; probe: LoginProbe } | null = null;
  private running: Promise<void> | null = null;

  constructor(
    private readonly run: () => Promise<LoginProbe | null>,
    private readonly now: () => number = Date.now,
  ) {}

  observe(key: string | null): LoginProbe | undefined {
    if (key === null) return undefined;
    const last = this.last?.key === key ? this.last.probe : undefined;
    const wait = last?.said === "ok" ? PROBE_EVERY : PROBE_AGAIN;
    if (!this.running && (last === undefined || this.now() - last.at >= wait)) {
      this.running = this.run()
        .then((probe) => {
          if (probe) this.last = { key, probe };
        })
        .catch(() => {
          // a check that threw is no word; the next hello asks again
        })
        .finally(() => {
          this.running = null;
        });
    }
    return last;
  }

  /** the check under way, if any, settled; tests */
  async settled(): Promise<void> {
    await this.running;
  }
}
