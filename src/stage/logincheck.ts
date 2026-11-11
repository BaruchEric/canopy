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
 * Bun.
 */
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { LOGIN_TOKEN_FILE, type StageLogin } from "../core/stagewire";

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
