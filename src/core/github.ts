import { isGitHub, parseRemote } from "./access";
import type { PullCount, Repo } from "./types";

/** Every repo the gh login owns, collaborates on or reaches through an org,
 *  with its open pull request count and whether it is archived: one query,
 *  paged by gh. Repos the login
 *  cannot see are not asked about, so a third-party clone gets no count. */
export const PULLS_QUERY = `query($endCursor: String) {
  viewer {
    repositories(first: 100, after: $endCursor,
      affiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER],
      ownerAffiliations: [OWNER, COLLABORATOR, ORGANIZATION_MEMBER]) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner url isArchived pullRequests(states: OPEN) { totalCount } }
    }
  }
}`;

/** The slug GitHub calls `owner/name`, lowercased: what a remote url and a
 *  query answer are joined on. */
export const githubSlug = (url: string): string | null => {
  const ref = parseRemote(url);
  return ref && isGitHub(ref.host) ? `${ref.owner}/${ref.name}`.toLowerCase() : null;
};

/** `gh api graphql --paginate --slurp` answers with one array of pages; a
 *  single page comes as one object. Anything else is an empty map. */
export function parsePullCounts(body: unknown): Map<string, PullCount> {
  const out = new Map<string, PullCount>();
  const pages = Array.isArray(body) ? body : [body];
  for (const page of pages) {
    const data = (page as { data?: { viewer?: { repositories?: { nodes?: unknown } } } } | null)?.data;
    const nodes = data?.viewer?.repositories?.nodes;
    if (!Array.isArray(nodes)) continue;
    for (const node of nodes) {
      if (!node || typeof node !== "object") continue;
      const n = node as { nameWithOwner?: unknown; url?: unknown; isArchived?: unknown; pullRequests?: { totalCount?: unknown } };
      const open = n.pullRequests?.totalCount;
      if (typeof n.nameWithOwner !== "string" || typeof n.url !== "string" || typeof open !== "number") continue;
      out.set(n.nameWithOwner.toLowerCase(), { open, url: `${n.url}/pulls`, ...(n.isArchived === true ? { archived: true as const } : {}) });
    }
  }
  return out;
}

/** The count for a repo is the count of the first GitHub remote the query
 *  knew; a repo with none keeps no count. */
export function pullsFor(repo: Pick<Repo, "remotes">, counts: Map<string, PullCount>): PullCount | undefined {
  for (const url of repo.remotes ?? []) {
    const slug = githubSlug(url);
    const c = slug ? counts.get(slug) : undefined;
    if (c) return c;
  }
  return undefined;
}

/** Every repo with its count set from the map, or unset when the map has
 *  none for it; the objects are only replaced where the count differs. */
export function linkPulls(repos: Repo[], counts: Map<string, PullCount>): Repo[] {
  return repos.map((r) => {
    const pulls = r.forge ? undefined : pullsFor(r, counts);
    if (pulls?.open === r.pulls?.open && pulls?.url === r.pulls?.url && pulls?.archived === r.pulls?.archived) return r;
    if (!pulls) {
      const { pulls: _gone, ...rest } = r;
      return rest;
    }
    return { ...r, pulls };
  });
}
