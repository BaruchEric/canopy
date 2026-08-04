import { exec, git } from "./exec";
import type { PushAccess } from "./types";

export interface RemoteRef {
  host: string;
  owner: string;
  name: string;
}

/** Owner and repo out of the URL shapes git remotes actually take. */
export function parseRemote(url: string): RemoteRef | null {
  const clean = url.trim().replace(/\.git$/, "");
  // A scheme has to be handled first: the scp pattern below would otherwise
  // swallow "ssh://git" as its user part and read the port as the owner.
  if (clean.includes("://")) {
    const m =
      /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]+@)?([^:/\s]+)(?::\d+)?\/(.+)$/i.exec(
        clean,
      );
    if (m?.[1] && m[2]) {
      const parts = m[2].split("/").filter(Boolean);
      const name = parts.at(-1);
      const owner = parts.at(-2);
      if (owner && name) return { host: m[1], owner, name };
    }
    return null;
  }
  // scp-like — git@github.com:owner/name
  const scp = /^[^@\s]+@([^:\s]+):([^/\s]+)\/(.+)$/.exec(clean);
  if (scp?.[1] && scp[2] && scp[3]) {
    return { host: scp[1], owner: scp[2], name: scp[3] };
  }
  return null;
}

export const isGitHub = (host: string): boolean =>
  /(^|\.)github\.com$/i.test(host);

async function remoteUrls(repoPath: string): Promise<string[]> {
  const r = await git(repoPath, [
    "config",
    "--get-regexp",
    String.raw`^remote\..*\.url`,
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .map((line) => line.slice(line.indexOf(" ") + 1).trim())
    .filter(Boolean);
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
  if (!deps.login) return "unknown";
  const refs = (await remoteUrls(repoPath)).map(parseRemote);
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
