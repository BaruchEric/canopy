/**
 * `canopy auth login | logout | status`, and the pairing flow `canopy helper
 * --pair` shares: ask the backend for a pair request, get it approved (in the
 * inbox, or with the first code from the server's log), and keep the token it
 * mints in a 0600 file named for the backend.
 */
import { readFileSync } from "node:fs";
import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { dirname } from "node:path";
import { apiBase, callerHeaders, tokenFile } from "./api";
import { dim, lichen, moss, sky } from "./render";

export const AUTH_USAGE = "usage: canopy auth login [--backend URL] [--code CODE]\n       canopy auth logout [--backend URL]\n       canopy auth status [--backend URL]";

/** how often a login asks whether it was approved, and how long it waits */
const POLL = 2_000;
const WINDOW = 10 * 60_000;

export interface PairOptions {
  base: string;
  /** `cli <host>` or `helper <host>`: the server mints the token kind from the prefix */
  label: string;
  /** the first sign-in code from the server's log, when nobody can approve in a page */
  code?: string;
  poll?: number;
  window?: number;
  say?: (line: string) => void;
}

const post = async (base: string, path: string, body: unknown, token?: string): Promise<{ status: number; body: Record<string, unknown> }> => {
  const res = await fetch(base + path, {
    method: "POST",
    redirect: "manual",
    headers: callerHeaders(base, token, { "content-type": "application/json" }),
    body: JSON.stringify(body),
  });
  if (res.status >= 300 && res.status < 400) throw new Error(`${base} sent a redirect to a sign-in; point --backend at canopy itself`);
  const raw: unknown = await res.json().catch(() => null);
  return { status: res.status, body: typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {} };
};

const message = (r: { status: number; body: Record<string, unknown> }): string =>
  typeof r.body["error"] === "string" ? r.body["error"] : `the backend answered ${r.status}`;

/** Pair, wait for approval, and return the minted token. Throws with a reason
 *  for a refusal, a denied or expired request, or the window running out. */
export async function pairFlow(opts: PairOptions): Promise<string> {
  const say = opts.say ?? (() => {});
  const pair = await post(opts.base, "/api/auth/pair", { label: opts.label });
  const { id, code, secret } = pair.body;
  if (pair.status !== 200 || typeof id !== "string" || typeof secret !== "string") throw new Error(message(pair));
  say(`pair code ${typeof code === "string" ? code : "?"}: approve it in the canopy inbox, or pass the first code from the server log with --code`);
  if (opts.code) {
    const first = await post(opts.base, "/api/auth/first", { id, code: opts.code });
    if (first.status !== 200) throw new Error(message(first));
  }
  const every = opts.poll ?? POLL;
  const until = Date.now() + (opts.window ?? WINDOW);
  for (;;) {
    const got = await post(opts.base, "/api/auth/claim", { id, secret });
    if (got.status === 200 && typeof got.body["token"] === "string") return got.body["token"];
    if (got.status !== 200 || got.body["waiting"] !== true) throw new Error(message(got));
    if (Date.now() >= until) throw new Error("timed out waiting for approval");
    await Bun.sleep(every);
  }
}

/** Write a token with no one else able to read it, even for a moment. */
export async function saveToken(file: string, token: string): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${token}\n`, { mode: 0o600 });
  await chmod(file, 0o600);
}

/** The helper's token from its file, null when there is none yet. */
export function readHelperToken(file: string): string | null {
  try {
    return readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

export const pairLabel = (kind: "cli" | "helper"): string => `${kind} ${hostname().split(".")[0] ?? "this machine"}`;

export interface AuthDeps {
  fail: (msg: string) => never;
}

interface AuthInfo {
  mode: string;
  refused: { count: number };
  you: string;
  youId: string | null;
}

/** `--name value` removed from args, as the index's own `opt` does */
function opt(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  if (i === -1 || i + 1 >= args.length) return undefined;
  return args.splice(i, 2)[1];
}

export async function authCommand(argv: string[], { fail }: AuthDeps): Promise<void> {
  const args = [...argv];
  const base = apiBase(opt(args, "--backend"));
  const code = opt(args, "--code");
  const sub = args[0];
  if (sub !== "login" && sub !== "logout" && sub !== "status") return fail(AUTH_USAGE);
  const info = async (): Promise<AuthInfo> => {
    let res: Response;
    try {
      res = await fetch(`${base}/api/auth`, { redirect: "manual", headers: callerHeaders(base) });
    } catch {
      return fail(`${base} did not answer`);
    }
    if (!res.ok) return fail(`${base} answered ${res.status} to /api/auth`);
    return (await res.json()) as AuthInfo;
  };
  switch (sub) {
    case "login": {
      let token: string;
      try {
        token = await pairFlow({ base, label: pairLabel("cli"), ...(code ? { code } : {}), say: (l) => console.log(`${lichen("canopy auth")} ${l}`) });
      } catch (e) {
        return fail(`sign-in failed: ${e instanceof Error ? e.message : String(e)}`);
      }
      const file = tokenFile(base);
      await saveToken(file, token);
      console.log(`${moss("signed in")} ${dim("→")} ${sky(base)} ${dim(`(token kept in ${file})`)}`);
      return;
    }
    case "status": {
      const a = await info();
      console.log(`${sky(base)}  ${dim("mode")} ${a.mode}  ${dim("you")} ${a.you}  ${dim("refused")} ${a.refused.count}`);
      return;
    }
    case "logout": {
      const file = tokenFile(base);
      const a = await info();
      if (a.youId === null) {
        await rm(file, { force: true });
        console.log(`${dim("no signed-in caller at")} ${sky(base)}${dim("; removed the token file if there was one")}`);
        return;
      }
      let res: { status: number; body: Record<string, unknown> };
      try {
        res = await post(base, "/api/auth/revoke", { id: a.youId });
      } catch (e) {
        return fail(`could not revoke: ${e instanceof Error ? e.message : String(e)}`);
      }
      await rm(file, { force: true });
      if (res.status === 200) console.log(`${moss("signed out")} ${dim("of")} ${sky(base)}`);
      else if (res.status === 403) console.log(`${lichen("removed the token file")}${dim(`; this token cannot revoke itself, so the session stays on the server until a page revokes it`)}`);
      else return fail(`removed the token file, but the server said: ${message(res)}`);
      return;
    }
  }
}
