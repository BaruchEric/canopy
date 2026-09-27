import { exec, git } from "./exec";
import { isGitHub, isSelfHosted, parseRemote } from "./remote";
import type { PushAccess } from "./types";

export { isGitHub, isSelfHosted, parseRemote, webUrl, type RemoteRef } from "./remote";

/** Whether one remote is the user's own, which is what decides if the
 *  server fetches it in the background: pushable on GitHub (the owner, or
 *  an org that grants push, asked once and memoized), or self-hosted. The
 *  upstream remote of a fork is someone else's, and left alone, or the
 *  fork's card would carry the upstream's activity as its own. */
export async function ownRemote(url: string, deps: AccessDeps): Promise<boolean> {
  if (isSelfHosted(url)) return true;
  return (await accessFromUrls([url], deps)) === "ok";
}

/** The names of a repo's own remotes, in `git config` order. */
export async function ownRemotes(
  remotes: { name: string; url: string }[],
  deps: AccessDeps,
): Promise<string[]> {
  const own: string[] = [];
  for (const r of remotes) if (await ownRemote(r.url, deps)) own.push(r.name);
  return own;
}

/** Every configured remote, in `git config` order, as name/url pairs. */
export async function listRemotes(
  repoPath: string,
): Promise<{ name: string; url: string }[]> {
  const r = await git(repoPath, [
    "config",
    "--get-regexp",
    String.raw`^remote\..*\.url`,
  ]);
  if (r.code !== 0) return [];
  const out: { name: string; url: string }[] = [];
  for (const line of r.stdout.split("\n")) {
    const sp = line.indexOf(" ");
    if (sp === -1) continue;
    const url = line.slice(sp + 1).trim();
    // remote.<name>.url — the name itself may contain dots
    const key = line.slice(0, sp);
    const name = key.slice("remote.".length, key.lastIndexOf(".url"));
    if (url && name) out.push({ name, url });
  }
  return out;
}

async function remoteUrls(repoPath: string): Promise<string[]> {
  return (await listRemotes(repoPath)).map((r) => r.url);
}

/** The signed-in GitHub account, or null when gh is missing or logged out. */
export async function githubLogin(): Promise<string | null> {
  const r = await exec(["gh", "api", "user", "--jq", ".login"], {
    timeoutMs: 15_000,
  });
  const login = r.stdout.trim();
  return r.code === 0 && login ? login : null;
}

async function ghCanPush(slug: string): Promise<boolean | null> {
  const r = await exec(
    ["gh", "api", `repos/${slug}`, "--jq", ".permissions.push"],
    { timeoutMs: 15_000 },
  );
  if (r.code !== 0) return null;
  const out = r.stdout.trim();
  return out === "true" ? true : out === "false" ? false : null;
}

export interface AccessDeps {
  /** null when the GitHub identity is unavailable — forces "unknown". */
  login: string | null;
  /** Memo keyed "owner/name"; null records a lookup that did not resolve. */
  permission: Map<string, boolean | null>;
}

/** Can this repo be pushed anywhere? Answers from remote URLs alone whenever
 *  one is owned by the user, so the common case costs no network at all. */
export async function pushAccess(
  repoPath: string,
  deps: AccessDeps,
): Promise<PushAccess> {
  return accessFromUrls(await remoteUrls(repoPath), deps);
}

/** The same answer from remote urls already in hand (a scanned repo carries
 *  its own), so a pass over every repo costs no git at all. */
export async function accessFromUrls(
  urls: string[],
  deps: AccessDeps,
): Promise<PushAccess> {
  if (!deps.login) return "unknown";
  const refs = urls.map(parseRemote);
  if (refs.length === 0) return "unknown";

  const mine = deps.login.toLowerCase();
  // A host we cannot interrogate is not evidence of denial.
  let unsure = refs.some((r) => !r || !isGitHub(r.host));

  for (const r of refs) {
    if (r && isGitHub(r.host) && r.owner.toLowerCase() === mine) return "ok";
  }

  // Only now, for the few repos that look like someone else's, ask GitHub —
  // org repos grant push without the owner matching.
  for (const r of refs) {
    if (!r || !isGitHub(r.host)) continue;
    const slug = `${r.owner}/${r.name}`;
    let perm = deps.permission.get(slug);
    if (perm === undefined) {
      perm = await ghCanPush(slug);
      deps.permission.set(slug, perm);
    }
    if (perm === true) return "ok";
    if (perm === null) unsure = true;
  }

  return unsure ? "unknown" : "denied";
}
