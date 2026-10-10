// Browser-safe words for which canopy is running: the CLI's --version, the
// server's /api/about and the settings' about section all read these, and the
// UI compares the build it was bundled from against the server's.
import type { BuildInfo } from "./types";

/** The seven hex digits git shows for a commit. */
export function shortCommit(commit: string | null): string | null {
  return commit ? commit.slice(0, 7) : null;
}

/** `0.1.0 (4b6ba30, 2026-09-26)`, `0.1.0 (4b6ba30+dirty, …)`, or bare `0.1.0`. */
export function versionLine(b: BuildInfo): string {
  const short = shortCommit(b.commit);
  if (!short) return b.version;
  const at = b.committedAt ? `, ${b.committedAt.slice(0, 10)}` : "";
  return `${b.version} (${short}${b.dirty ? "+dirty" : ""}${at})`;
}

/** A build from what git said about the checkout, with CANOPY_COMMIT and
 *  CANOPY_COMMITTED (what the docker build passes, having no .git) winning
 *  over it; a commit that is not hex is ignored rather than shown. */
export function buildFrom(
  version: string,
  env: Record<string, string | undefined>,
  head: { commit: string | null; committedAt: string | null; dirty: boolean } | null,
): BuildInfo {
  const given = env["CANOPY_COMMIT"]?.trim().toLowerCase();
  if (given && /^[0-9a-f]{7,40}$/.test(given)) {
    return { version, commit: given, committedAt: env["CANOPY_COMMITTED"]?.trim() || null, dirty: false };
  }
  return { version, commit: head?.commit ?? null, committedAt: head?.committedAt ?? null, dirty: head?.dirty ?? false };
}

/** Whether the page and the server come from the same build: the same commit
 *  when both know theirs (a prefix match, since either may be short), else
 *  the same version. Uncommitted edits are not told apart, since the commit
 *  does not say what they were, and a dev checkout would never match. */
export function sameBuild(a: BuildInfo, b: BuildInfo): boolean {
  if (a.commit && b.commit) return a.commit.startsWith(b.commit) || b.commit.startsWith(a.commit);
  return a.version === b.version;
}

/** Whether a backend came back as another build than the one it was when
 *  the page loaded: a redeploy or a restart on new code while the page
 *  stayed open, which a reload brings in. Measured against what the
 *  backend first said rather than the page's own bundle, since a server
 *  started from a checkout committed after its last build always differs
 *  from its bundle and a reload would not change that. */
export const buildMoved = (first: BuildInfo | null, now: BuildInfo | null): boolean =>
  first !== null && now !== null && !sameBuild(first, now);
