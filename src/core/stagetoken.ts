/**
 * The pure parts of `bun run stage-token` (scripts/stage-token.ts): one
 * command that mints a `claude setup-token` token and saves it as a stage
 * runner's `LOGIN_TOKEN_FILE` on a backend's host, so nobody copies a token
 * or types a path. `TokenFilter` reads the token out of what claude prints
 * and keeps it off the screen, `parseTokenArgs` says which host and which
 * logins, and `saveCommand` is what runs on the host with the token on its
 * stdin. Nothing here spawns or reads a file.
 */
import { COORD_LOGIN, LOGIN_TOKEN_FILE, STAGES_LOGIN, type LoginSite } from "./stagewire";

/** what the screen shows where claude printed the token */
export const TOKEN_MASK = "(the token: saved for you, not shown)";

/** how every Anthropic key starts; a run of key characters after it is looked at whole */
const START = "sk-ant-";
const RUN = /^sk-ant-[A-Za-z0-9_-]*/;
/** a setup-token token, whole */
const WHOLE = /^sk-ant-oat01-[A-Za-z0-9_-]{40,}$/;

/** how many of `text`'s last characters could be the start of `START`, cut short by the chunk's end */
function cutPrefix(text: string): number {
  for (let n = Math.min(START.length - 1, text.length); n > 0; n -= 1) {
    if (START.startsWith(text.slice(text.length - n))) return n;
  }
  return 0;
}

/** Reads a setup-token token out of a terminal's output as it streams, and
 *  gives back the text to show with the token replaced by `TOKEN_MASK`,
 *  padded with spaces to the token's own width. A
 *  token cut by a chunk's end is held until its last character has come, so
 *  no part of one reaches the screen. claude colors the token and never
 *  breaks it while the terminal is wide enough (`MINT_COLS`), so a token is
 *  one unbroken run of key characters. */
export class TokenFilter {
  private held = "";
  private found: string | null = null;

  /** the last whole token seen, or null */
  token(): string | null {
    return this.found;
  }

  push(chunk: string): string {
    let text = this.held + chunk;
    this.held = "";
    let out = "";
    for (;;) {
      const at = text.indexOf(START);
      if (at < 0) {
        const keep = cutPrefix(text);
        this.held = text.slice(text.length - keep);
        return out + text.slice(0, text.length - keep);
      }
      out += text.slice(0, at);
      const rest = text.slice(at);
      const run = RUN.exec(rest)?.[0] ?? START;
      if (run.length === rest.length) {
        // the run may go on in the next chunk
        this.held = rest;
        return out;
      }
      out += this.take(run);
      text = rest.slice(run.length);
    }
  }

  /** the stream is over: what was held, shown or masked */
  end(): string {
    const last = this.held;
    this.held = "";
    return last.startsWith(START) ? this.take(last) : last;
  }

  private take(run: string): string {
    if (!WHOLE.test(run)) return run;
    this.found = run;
    // as wide as the token: claude redraws its screen in place without
    // clearing a line, so a shorter mask leaves the old line's end showing
    return TOKEN_MASK.padEnd(run.length);
  }
}

/** the terminal claude gets is at least this wide, so it prints a token (about 110 characters) on one line */
export const MINT_COLS = 140;

export type StageLoginName = "stages" | "coord";
export const LOGIN_SITES: Readonly<Record<StageLoginName, LoginSite>> = { stages: STAGES_LOGIN, coord: COORD_LOGIN };
/** the health check that says a saved token was read */
export const LOGIN_CHECK: Readonly<Record<StageLoginName, string>> = { stages: "stages' claude login", coord: "coordinator's claude login" };

/** The backends by name and how ssh reaches each: `scripts/redeploy.sh`'s
 *  own list, read from the same two variables so one setting moves both. */
export function deployTargets(env: Record<string, string | undefined>): Record<string, string> {
  const list = env["CANOPY_DEPLOY_TARGETS"] || `mini=${env["CANOPY_DEPLOY_MINI"] || "macmini-2018"} desoto=eric@desoto-canopy`;
  const out: Record<string, string> = {};
  for (const pair of list.split(/\s+/)) {
    const eq = pair.indexOf("=");
    if (eq > 0 && eq < pair.length - 1) out[pair.slice(0, eq)] = pair.slice(eq + 1);
  }
  return out;
}

export const TOKEN_USAGE = "usage: bun run stage-token [mini | desoto | here] [stages | coord | all]";

export type TokenPlan =
  | {
      ok: true;
      /** the backend's name, or "here" for this machine */
      backend: string;
      /** where ssh goes, or null to save on this machine */
      dest: string | null;
      logins: StageLoginName[];
    }
  | { ok: false; error: string };

/** Which host and which logins a run is for. With no backend named it is
 *  the mini from a Mac, as for a redeploy, and this machine anywhere else
 *  (a backend's own host). With no login named it is the stages'. */
export function parseTokenArgs(args: readonly string[], env: Record<string, string | undefined>, platform: string): TokenPlan {
  const targets = deployTargets(env);
  let backend: string | null = null;
  let which: StageLoginName | "all" | null = null;
  for (const a of args) {
    if (a === "stages" || a === "coord" || a === "all") {
      if (which !== null) return { ok: false, error: `two logins named, ${which} and ${a}. ${TOKEN_USAGE}` };
      which = a;
    } else if (a === "here" || Object.hasOwn(targets, a)) {
      if (backend !== null) return { ok: false, error: `two backends named, ${backend} and ${a}. ${TOKEN_USAGE}` };
      backend = a;
    } else {
      return { ok: false, error: `${a} is not a backend (${[...Object.keys(targets), "here"].join(", ")}) or a login (stages, coord, all). ${TOKEN_USAGE}` };
    }
  }
  backend ??= platform === "darwin" && Object.hasOwn(targets, "mini") ? "mini" : "here";
  const logins: StageLoginName[] = which === "all" ? ["stages", "coord"] : [which ?? "stages"];
  return { ok: true, backend, dest: backend === "here" ? null : (targets[backend] ?? null), logins };
}

/** a login's folder as the host's shell reads it */
const hostFolder = (site: LoginSite): string => site.folder.replace(/^~\//, "$HOME/");

/** The shell line that says whether a login's folder is on the host: run
 *  before a token is minted, so none is made for a host that has no place
 *  for it. */
export function folderCheck(site: LoginSite): string {
  return `test -d "${hostFolder(site)}" && test -w "${hostFolder(site)}"`;
}

/** The shell lines that save the token on their stdin as the login's
 *  `LOGIN_TOKEN_FILE`: written whole beside it under a private mask, then
 *  moved into place, so the runner never reads half a token. The folder
 *  must be there already (compose mounts it); a host without it is not a
 *  backend's. Prints nothing of the token. */
export function saveCommand(site: LoginSite): string {
  const d = hostFolder(site);
  return [
    "set -eu",
    `d="${d}"`,
    `[ -d "$d" ] || { echo "no $d on this host" >&2; exit 3; }`,
    "umask 077",
    `cat > "$d/.${LOGIN_TOKEN_FILE}.new"`,
    `[ -s "$d/.${LOGIN_TOKEN_FILE}.new" ] || { rm -f "$d/.${LOGIN_TOKEN_FILE}.new"; echo "no token came through" >&2; exit 4; }`,
    `mv -f "$d/.${LOGIN_TOKEN_FILE}.new" "$d/${LOGIN_TOKEN_FILE}"`,
  ].join("; ");
}

/** a token never rides in an error's words */
export function withoutTokens(text: string): string {
  return text.replace(/sk-ant-[A-Za-z0-9_-]+/g, TOKEN_MASK);
}
