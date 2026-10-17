/**
 * How the CLI addresses a canopy backend and proves who is calling: the
 * backend's origin, the token file kept per host and port, and the
 * X-Canopy-Token header every call carries.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { configDir } from "../core/store";

/** The `--backend` value, else $CANOPY_API, else the local backend, without trailing slashes. */
export function apiBase(given?: string): string {
  return (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
}

/** `--token` for the whole run, set once by main() so no command threads it by hand. */
let flagToken: string | undefined;

export function setTokenFlag(token: string | undefined): void {
  flagToken = token;
}

/** Where `canopy auth login` keeps the token for a backend: one file per host and port. */
export function tokenFile(base: string): string {
  const u = new URL(base);
  const port = u.port || (u.protocol === "https:" ? "443" : "80");
  return join(configDir(), `token-${u.hostname}-${port}`);
}

/** The backend this command was pointed at (`--backend`), set once by main(). */
let homeBase: string | undefined;

export function setHomeBase(given: string | undefined): void {
  homeBase = given;
}

const sameOrigin = (a: string, b: string): boolean => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

/** The backend's own token file first for any base; the flag and $CANOPY_TOKEN
 *  only for the home base, so a peer or a fallback address never gets a token
 *  that was meant for another backend. */
export function callerToken(base: string, flag?: string): string | null {
  const home = sameOrigin(base, apiBase(homeBase));
  const given = (flag ?? (home ? flagToken : undefined))?.trim();
  if (given) return given;
  try {
    const filed = readFileSync(tokenFile(base), "utf8").trim();
    if (filed) return filed;
  } catch {
    // no file, or an unreadable one: the environment is next
  }
  return (home ? process.env["CANOPY_TOKEN"]?.trim() : "") || null;
}

/** `extra` plus the caller's token, when there is one. */
export function callerHeaders(base: string, flag?: string, extra?: ConstructorParameters<typeof Headers>[0]): Headers {
  const headers = new Headers(extra);
  const token = callerToken(base, flag);
  if (token) headers.set("x-canopy-token", token);
  return headers;
}
