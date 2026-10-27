/** Forgejo issues, the pure part: the API paths a rule's poll and its
 *  write-back call, the readers for what those calls answer, and the words
 *  canopy writes on an issue. Browser-safe; server/forgejo.ts makes the
 *  requests. Gitea speaks the same API. */

import type { IssueView } from "./issue";
import { POLL_ISSUES } from "./trigger";

/** One issue as the API gives it, with the comments read separately. */
export interface ForgejoIssue extends IssueView {
  /** when the issue was opened, ISO 8601, which orders a poll oldest first */
  createdAt: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** `owner/name`, each part encoded as a path segment */
const repoPath = (api: string, slug: string): string => `${api.replace(/\/+$/, "")}/api/v1/repos/${slug.split("/").map(encodeURIComponent).join("/")}`;

/** The open issues carrying `label`, oldest first, one page of `POLL_ISSUES`.
 *  `type=issues` leaves pull requests out server-side; `parseIssueList`
 *  drops any that come anyway. */
export function forgejoIssuesPath(api: string, slug: string, label: string): string {
  const q = new URLSearchParams({ labels: label, state: "open", type: "issues", sort: "oldest", limit: String(POLL_ISSUES), page: "1" });
  return `${repoPath(api, slug)}/issues?${q.toString()}`;
}

/** one issue: read for its detail, patched to close it */
export const forgejoIssuePath = (api: string, slug: string, number: number): string => `${repoPath(api, slug)}/issues/${number}`;

/** an issue's comments: read for the note, posted to for the write-back */
export const forgejoCommentsPath = (api: string, slug: string, number: number): string => `${forgejoIssuePath(api, slug, number)}/comments`;

/** The issues the list call answered that are open and carry `label` (the
 *  server discards a label it does not know, and then lists every issue),
 *  pull requests left out. Not a list throws, so the poll reports it. */
export function parseIssueList(body: unknown, label: string): ForgejoIssue[] {
  if (!Array.isArray(body)) throw new Error("the forge did not answer with a list of issues");
  const want = label.toLowerCase();
  const out: ForgejoIssue[] = [];
  for (const item of body) {
    if (!isRecord(item) || str(item["state"]) !== "open") continue;
    const issue = parseIssueView(item);
    if (issue && issue.labels.some((l) => l.toLowerCase() === want)) out.push(issue);
  }
  return out;
}

/** One issue as the API gives it, or null for a pull request (the API puts
 *  one under `pull_request`, null on an issue) or anything without a number
 *  and a title. Comments are empty until `parseIssueComments` fills them. */
export function parseIssueView(body: unknown): ForgejoIssue | null {
  if (!isRecord(body) || typeof body["number"] !== "number" || typeof body["title"] !== "string" || body["pull_request"]) return null;
  const labels = Array.isArray(body["labels"]) ? body["labels"].map((l) => (isRecord(l) ? str(l["name"]) : "")).filter(Boolean) : [];
  return { number: body["number"], title: body["title"], body: str(body["body"]), url: str(body["html_url"]), labels, comments: [], createdAt: str(body["created_at"]) };
}

/** An issue's comments as the API lists them, oldest first. Not a list
 *  throws, so the detail read reports it rather than making a bare note. */
export function parseIssueComments(body: unknown): { author: string; body: string }[] {
  if (!Array.isArray(body)) throw new Error("the forge did not answer with a list of comments");
  return body.filter(isRecord).map((c) => {
    const user = isRecord(c["user"]) ? c["user"] : {};
    return { author: str(user["login"]) || str(user["username"]) || "someone", body: str(c["body"]) };
  });
}

/** the comment on the issue once its PR is open */
export const openedComment = (pr: number, branch: string): string => `Opened #${pr} from ${branch}.`;

/** the comment that closes the issue once its PR merged */
export const fixedComment = (pr: number): string => `Fixed by #${pr}.`;

/** the body that closes an issue: `PATCH .../issues/{n}` */
export const closedBody = (): { state: "closed" } => ({ state: "closed" });
