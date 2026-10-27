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

/** Applied entries name environment keys; their stamps are not secret values. */
export function secretValues(env: Readonly<Record<string, string | undefined>>, applied?: Readonly<Record<string, Readonly<Record<string, string>>>>): Secret[] {
  const names = new Set<string>(PRIVATE_ENV);
  for (const name of Object.keys(env)) if (name.startsWith("CANOPY_")) names.add(name);
  for (const sink of Object.values(applied ?? {})) for (const name of Object.keys(sink)) names.add(name);
  return [...names].flatMap((name) => {
    const value = env[name];
    return value !== undefined && value.length >= REDACT_MIN ? [{ name, value }] : [];
  }).sort(longestFirst);
}

/** Scan only original input: generated markers never enter the matcher. */
export function redactLine(line: string, secrets: readonly Secret[]): { line: string; count: number } {
  const candidates = secrets.filter((s) => s.value.length >= REDACT_MIN).sort(longestFirst);
  const token = new RegExp(TOKEN_PATTERN.source, "y");
  const pieces: string[] = [];
  let count = 0;
  let start = 0;
  for (let i = 0; i < line.length;) {
    const secret = candidates.find((s) => line.startsWith(s.value, i));
    token.lastIndex = i;
    const unknownToken = secret ? null : token.exec(line)?.[0];
    const value = secret?.value ?? unknownToken;
    if (!value) {
      i++;
      continue;
    }
    pieces.push(line.slice(start, i), redactedWord(secret?.name ?? "token"));
    count++;
    i += value.length;
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
