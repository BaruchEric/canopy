/** What never reaches a run's transcript. Pure and browser-safe; a secret
 *  split across separate lines is outside this line-based redactor's scope. */
import { PRIVATE_ENV } from "./envnames";

export interface Secret {
  name: string;
  value: string;
}

/** Empty values are ignored; even one-character secrets are removed. */
export const REDACT_MIN = 1;
export const TOKEN_PATTERN = /cnp_[a-z]+_[A-Za-z0-9_-]{43}/g;
export const redactedWord = (name: string): string => `<redacted:${name}>`;

const longestFirst = (a: Secret, b: Secret): number => b.value.length - a.value.length || a.name.localeCompare(b.name);

/** CANOPY_ names whose values are settings rather than secrets: switches
 *  (a digit, a mode word, a port range) and the folders and sockets a
 *  backend runs from. Each value is matched anywhere in a line, so counted
 *  as a secret each took its text out of every transcript: CANOPY_TMUX=1 on
 *  the compose canopy service made every "1" read `<redacted:CANOPY_TMUX>`,
 *  CANOPY_CALLERS=enforce took that word out, the dev task's
 *  CANOPY_AGENT_SCAN=0 took every 0, and CANOPY_CONFIG_DIR=/config cut
 *  `src/config.ts` to `src<redacted:CANOPY_CONFIG_DIR>.ts`. A folder is
 *  not a credential, and the transcripts stay in the 0700 config dir. URLs
 *  stay redacted, since one can carry a token, and so do the names a run is
 *  given (CANOPY_RUN, CANOPY_REPO, CANOPY_TOKEN). CANOPY_LOOPBACK_AUTH is
 *  "1" under a name that reads as a credential. */
export const PLAIN_SETTINGS: ReadonlySet<string> = new Set([
  // switches
  "CANOPY_LOOPBACK_AUTH",
  "CANOPY_TMUX",
  "CANOPY_CALLERS",
  "CANOPY_AGENT_SCAN",
  "CANOPY_NO_DESKTOP",
  "CANOPY_INCUBATOR_AUTOSTART",
  "CANOPY_INCUBATOR_UNISOLATED",
  "CANOPY_PREVIEW_PORTS",
  // folders and sockets
  "CANOPY_CONFIG_DIR",
  "CANOPY_HOST_HOME",
  "CANOPY_COORD_ROOT",
  "CANOPY_STAGE_ROOT",
  "CANOPY_FENCE_ROOT",
  "CANOPY_RESTART_DIR",
  "CANOPY_FIREBASE_PATH",
  "CANOPY_SECRETS_SOCKET",
  "CANOPY_STAGE_SOCKET",
  "CANOPY_COORD_SOCKET",
]);

/** Applied entries name environment keys; their stamps are not secret values. */
export function secretValues(env: Readonly<Record<string, string | undefined>>, applied?: Readonly<Record<string, Readonly<Record<string, string>>>>): Secret[] {
  const names = new Set<string>(PRIVATE_ENV);
  for (const name of Object.keys(env)) if (name.startsWith("CANOPY_") && !PLAIN_SETTINGS.has(name)) names.add(name);
  for (const sink of Object.values(applied ?? {})) for (const name of Object.keys(sink)) names.add(name);
  return [...names].flatMap((name) => {
    const value = env[name];
    return value !== undefined && value.length >= REDACT_MIN ? [{ name, value }] : [];
  }).sort(longestFirst);
}

/** Protect whole token spans on original input, including literal overlaps.
 *  Generated replacement markers never enter either matcher. */
export function redactLine(line: string, secrets: readonly Secret[]): { line: string; count: number } {
  const candidates = secrets.filter((s) => s.value.length >= REDACT_MIN).sort(longestFirst);
  const tokens = [...line.matchAll(new RegExp(TOKEN_PATTERN.source, "g"))].map((match) => ({
    start: match.index, end: match.index + match[0].length,
  }));
  const pieces: string[] = [];
  let tokenIndex = 0;
  let count = 0;
  let start = 0;
  for (let i = 0; i < line.length;) {
    const secret = candidates.find((s) => line.startsWith(s.value, i));
    const token = tokens[tokenIndex];
    let end: number;
    let name: string;
    if (token && token.start === i && (!secret || secret.value.length < token.end - token.start)) {
      end = token.end;
      name = "token";
    } else if (secret) {
      end = i + secret.value.length;
      name = secret.name;
    } else {
      i++;
      continue;
    }
    pieces.push(line.slice(start, i), redactedWord(name));
    count++;
    // A literal beginning before a token may consume only its prefix. Extend
    // that removal to the token's end so its random suffix cannot survive.
    let overlap = tokens[tokenIndex];
    while (overlap && overlap.start < end) {
      if (overlap.end > end) {
        end = overlap.end;
        pieces.push(redactedWord("token"));
        count++;
      }
      tokenIndex++;
      overlap = tokens[tokenIndex];
    }
    i = end;
    start = i;
  }
  pieces.push(line.slice(start));
  return { line: pieces.join(""), count };
}

export function redactArgv(argv: readonly string[], secrets: readonly Secret[]): string[] {
  let config = false;
  return argv.map((arg) => {
    if (config) {
      config = false;
      return redactedWord("mcp-config");
    }
    if (arg.startsWith("--mcp-config=")) return redactLine("--mcp-config=", secrets).line + redactedWord("mcp-config");
    config = arg === "--mcp-config";
    return redactLine(arg, secrets).line;
  });
}
