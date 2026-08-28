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

/** Forges that serve the same owner/name path over https as over ssh. An ssh
 *  remote on any other host tells us nothing about what its web address is. */
const WEB_FORGES =
  /(^|\.)(?:github\.com|gitlab\.com|bitbucket\.org|codeberg\.org|git\.sr\.ht)$/i;

/** The remote as a page you can open, or null when we cannot tell.
 *  An https remote keeps its own host, so a self-hosted forge works; ssh and
 *  scp remotes only map for the forges above. A link to a host that answers
 *  git but not http is worse than no link at all. */
export function webUrl(url: string): string | null {
  const clean = url.trim();
  const ref = parseRemote(clean);
  if (!ref) return null;
  if (/^https?:\/\//i.test(clean)) {
    let u: URL;
    try {
      u = new URL(clean);
    } catch {
      return null;
    }
    // Credentials belong in the remote, never in a link the UI renders.
    u.username = "";
    u.password = "";
    u.search = "";
    u.hash = "";
    u.protocol = "https:";
    u.pathname = u.pathname.replace(/\.git$/, "").replace(/\/+$/, "");
    return u.toString().replace(/\/$/, "");
  }
  if (!WEB_FORGES.test(ref.host)) return null;
  return `https://${ref.host}/${ref.owner}/${ref.name}`;
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
