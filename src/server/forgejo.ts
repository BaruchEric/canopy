/** Forgejo's issues API over fetch: the reads a poll and a hook make on a
 *  forgejo rule. The paths, the readers of each answer and the words
 *  written back are `core/forgejoissues.ts`, pure. Gitea speaks the same
 *  API. The token is the rule's own or the forge source's (server/index.ts
 *  picks it); a call is made only with one. */

import { forgejoCommentsPath, forgejoIssuePath, forgejoIssuesPath, parseIssueComments, parseIssueList, parseIssueView, type ForgejoIssue } from "../core/forgejoissues";
import { oldestIssues } from "../core/issue";
import { POLL_ISSUES } from "../core/trigger";

/** fetch's shape, so a test can answer in its place */
export type Fetch = (url: string, init: RequestInit) => Promise<Response>;

const TIMEOUT_MS = 20_000;

const errText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/** One GET with the token, answered as JSON (null when the body is not).
 *  A refusal names the token, any other failure the server. */
async function get(api: string, url: string, token: string, fetchFn: Fetch): Promise<unknown> {
  let res: Response;
  try {
    res = await fetchFn(url, { headers: { Accept: "application/json", Authorization: `token ${token}` }, signal: AbortSignal.timeout(TIMEOUT_MS) });
  } catch (err) {
    throw new Error(`cannot reach ${api}: ${errText(err)}`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(`${api} rejected the token`);
  if (!res.ok) throw new Error(`${api} answered ${res.status}`);
  return res.json().catch(() => null);
}

/** The repo's open issues carrying one of `labels`, oldest first and at
 *  most `POLL_ISSUES`: one list call per label, merged by number. */
export async function forgejoListIssues(api: string, slug: string, labels: readonly string[], token: string, fetchFn: Fetch = fetch): Promise<ForgejoIssue[]> {
  const lists: ForgejoIssue[][] = [];
  for (const label of labels) lists.push(parseIssueList(await get(api, forgejoIssuesPath(api, slug, label), token, fetchFn), label));
  return oldestIssues(lists, POLL_ISSUES);
}

/** One issue in full: the issue, then its comments, oldest first. */
export async function forgejoReadIssue(api: string, slug: string, number: number, token: string, fetchFn: Fetch = fetch): Promise<ForgejoIssue> {
  const issue = parseIssueView(await get(api, forgejoIssuePath(api, slug, number), token, fetchFn));
  if (!issue) throw new Error(`#${number} is not an issue`);
  const comments = parseIssueComments(await get(api, forgejoCommentsPath(api, slug, number), token, fetchFn));
  return { ...issue, comments };
}
