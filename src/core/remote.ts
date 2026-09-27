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

/** A remote on no public forge: the user's own server (a Forgejo on the
 *  LAN, a NAS) or a path on this machine. Nobody else pushes there, so
 *  activity on it is the user's and worth fetching. */
export const isSelfHosted = (url: string): boolean => {
  const ref = parseRemote(url);
  return ref === null || !WEB_FORGES.test(ref.host);
};

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
