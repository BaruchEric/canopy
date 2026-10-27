/** Forgejo's issues API over fetch: the reads a poll and a hook make on a
 *  forgejo rule, and the writes the hub makes back (a comment, a close).
 *  The paths, the readers of each answer and the words written back are
 *  `core/forgejoissues.ts`, pure. Gitea speaks the same API. The token is
 *  the rule's own or the forge source's (server/index.ts picks it); a call
 *  is made only with one. */

import { closedBody, FORGE_PAGE, forgejoCommentsPath, forgejoIssuePath, forgejoIssuesPath, parseIssueComments, parseIssueList, parseIssueView, type ForgejoIssue } from "../core/forgejoissues";
import { LIST_ISSUES, oldestIssues } from "../core/issue";

/** fetch's shape, so a test can answer in its place */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One call with the token, its body sent as JSON when it has one, answered
 *  as JSON (null when the answer is not). A refusal names the token, any
 *  other failure the server. */
async function call(api: string, url: string, token: string, method: "GET" | "POST" | "PATCH", body: unknown, fetchFn: Fetch): Promise<unknown> {
  const headers: Record<string, string> = { Accept: "application/json", Authorization: `token ${token}` };
  if (body !== undefined) headers["Content-Type"] = "application/json";
  let res: Response;
  try {
    res = await fetchFn(url, { method, headers, ...(body !== undefined ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`cannot reach ${api}: ${errText(err)}`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${api} rejected the token`);
  if (!res.ok) throw new Error(`${api} answered ${res.status}`);
  return res.json().catch(() => null);
}

const get = (api: string, url: string, token: string, fetchFn: Fetch): Promise<unknown> => call(api, url, token, "GET", undefined, fetchFn);

/** The repo's open issues carrying one of `labels`, oldest first and at
 *  most `LIST_ISSUES`: per label, one page after another until a short
 *  page or that many, merged by number. The listing reaches past the
 *  poll's `POLL_ISSUES` so the hub can drop the issues it knows first. */
export async function forgejoListIssues(api: string, slug: string, labels: readonly string[], token: string, fetchFn: Fetch = fetch): Promise<ForgejoIssue[]> {
  const lists: ForgejoIssue[][] = [];
  for (const label of labels) {
    const found: ForgejoIssue[] = [];
    for (let page = 1; found.length < LIST_ISSUES; page++) {
      const got = await get(api, forgejoIssuesPath(api, slug, label, page), token, fetchFn);
      const count = Array.isArray(got) ? got.length : 0;
      found.push(...parseIssueList(got, label));
      if (count < FORGE_PAGE) break;
    }
    lists.push(found);
  }
  return oldestIssues(lists, LIST_ISSUES);
}

/** One issue in full: the issue, then its comments, oldest first. */
export async function forgejoReadIssue(api: string, slug: string, number: number, token: string, fetchFn: Fetch = fetch): Promise<ForgejoIssue> {
  const issue = parseIssueView(await get(api, forgejoIssuePath(api, slug, number), token, fetchFn));
  if (!issue) throw new Error(`#${number} is not an issue`);
  const comments = parseIssueComments(await get(api, forgejoCommentsPath(api, slug, number), token, fetchFn));
  return { ...issue, comments };
}

/** Comments on an issue, as the token's user. */
export async function forgejoComment(api: string, slug: string, number: number, token: string, body: string, fetchFn: Fetch = fetch): Promise<void> {
  await call(api, forgejoCommentsPath(api, slug, number), token, "POST", { body }, fetchFn);
}

/** Closes an issue; its timeline names the token's user as who closed it. */
export async function forgejoClose(api: string, slug: string, number: number, token: string, fetchFn: Fetch = fetch): Promise<void> {
  await call(api, forgejoIssuePath(api, slug, number), token, "PATCH", closedBody(), fetchFn);
}
