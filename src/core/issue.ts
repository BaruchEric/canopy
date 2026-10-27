/** Starting a branch run from a GitHub issue: a note that opens with `#123`
 *  or an issue's URL becomes the issue itself, fenced as data, with the
 *  rest of the note after it. Browser-safe (the run sheet parses the ref
 *  for its chip); gh is handed in by the server. */

import { fence } from "./pr";

/** A ref that opens a note: the issue's number, the repo a URL named (null
 *  for a bare `#123`, which means this repo's), and the words after it. */
export interface IssueRef {
  number: number;
  /** `owner/name` from a URL */
  slug: string | null;
  rest: string;
}

/** One issue as `gh issue view --json number,title,body,url,labels,comments` gives it. */
export interface IssueView {
  number: number;
  title: string;
  body: string;
  url: string;
  labels: string[];
  comments: { author: string; body: string }[];
}

/** what a gh call answers; the server passes exec's result through */
export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
export type GhRun = (args: string[]) => Promise<GhResult>;

/** what may follow a ref: the note's end, a blank, or punctuation */
const END = String.raw`(?=$|[\s:,;)]|\.(?:$|\s))`;
const BARE = new RegExp(String.raw`^#(\d{1,9})${END}`);
const URL_REF = new RegExp(String.raw`^(?:https?:\/\/)?(?:www\.)?github\.com\/([\w.-]{1,100})\/([\w.-]{1,100})\/issues\/(\d{1,9})(?:[/?#][^\s:,;)]*)?${END}`, "i");

/** The issue a note opens with, or null. Only a ref at the very start counts,
 *  so a chat that merely mentions `#12` further on is never rewritten. */
export function parseIssueRef(note: string): IssueRef | null {
  const text = note.trimStart();
  const bare = BARE.exec(text);
  const url = bare ? null : URL_REF.exec(text);
  const m = bare ?? url;
  if (!m) return null;
  const number = Number(bare ? bare[1] : url?.[3]);
  if (!Number.isSafeInteger(number) || number < 1) return null;
  const rest = text.slice(m[0].length).replace(/^[\s:,.;)-]+/, "").trim();
  return { number, slug: url ? `${url[1]}/${url[2]}` : null, rest };
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** gh's JSON for one issue, or null when it is not one. */
export function parseIssueView(json: unknown): IssueView | null {
  if (!isRecord(json) || typeof json["number"] !== "number" || typeof json["title"] !== "string") return null;
  const labels = Array.isArray(json["labels"]) ? json["labels"].map((l) => (isRecord(l) ? str(l["name"]) : "")).filter(Boolean) : [];
  const comments = Array.isArray(json["comments"])
    ? json["comments"].filter(isRecord).map((c) => ({ author: isRecord(c["author"]) ? str(c["author"]["login"]) || "someone" : "someone", body: str(c["body"]) }))
    : [];
  return { number: json["number"], title: json["title"], body: str(json["body"]), url: str(json["url"]), labels, comments };
}

/** how many comments a note carries, the latest ones */
export const ISSUE_COMMENTS = 10;
const cap = (text: string, n: number): string => (text.length > n ? `${text.slice(0, n)}\n[cut at ${n} characters]` : text);

/** The run's note for an issue. It opens with "GitHub issue #n: title"
 *  since the first words name the branch (workBranchName); the body and the latest
 *  comments go in a fence, as anyone who can file an issue chooses their
 *  words; the user's own words follow it. */
export function issueNote(issue: IssueView, rest: string): string {
  const title = issue.title.replace(/\s+/g, " ").trim();
  const shown = issue.comments.slice(-ISSUE_COMMENTS);
  const left = issue.comments.length - shown.length;
  const lines = [
    `title: ${title}`,
    ...(issue.url ? [`link: ${issue.url}`] : []),
    ...(issue.labels.length ? [`labels: ${issue.labels.join(", ")}`] : []),
    "",
    cap(issue.body.trim() || "(no description)", 20_000),
    ...(left > 0 ? ["", `(${left} earlier comment${left === 1 ? "" : "s"} left out)`] : []),
    ...shown.flatMap((c) => ["", `comment by ${c.author}:`, cap(c.body.trim(), 4_000)]),
  ];
  const head = `GitHub issue #${issue.number}: ${title}\nWork from this issue. ${fence("The issue", lines.join("\n"))}`;
  return rest ? `${head}\n\n${rest}` : head;
}

/** last line of what gh said, the words the run sheet shows on a failure */
const lastLine = (r: GhResult): string => (r.stderr.trim() || r.stdout.trim()).split("\n").filter(Boolean).pop() ?? `gh exited ${r.code}`;

/** Reads the issue a ref names from the repo `slug` (its GitHub remote). A
 *  URL naming another repo is refused: the run works on this one. */
export async function fetchIssue(ref: IssueRef, slug: string, gh: GhRun): Promise<{ issue: IssueView } | { error: string }> {
  if (ref.slug && ref.slug.toLowerCase() !== slug.toLowerCase()) {
    return { error: `issue #${ref.number} is in ${ref.slug}, and this repo's GitHub remote is ${slug}` };
  }
  let r: GhResult;
  try {
    r = await gh(["issue", "view", String(ref.number), "-R", slug, "--json", "number,title,body,url,labels,comments"]);
  } catch (err) {
    return { error: `gh did not run: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (r.code !== 0) return { error: lastLine(r) };
  let parsed: unknown;
  try {
    parsed = JSON.parse(r.stdout);
  } catch {
    return { error: `gh's answer for issue #${ref.number} is not JSON` };
  }
  const issue = parseIssueView(parsed);
  return issue ? { issue } : { error: `gh's answer for issue #${ref.number} is not an issue` };
}

/** the issue a note was swapped for, when one was */
export interface IssueFrom {
  number: number;
  title: string;
  url: string;
  slug: string;
}

/** The note a branch run starts with: the issue's when the note opens with
 *  a ref and the repo has a GitHub remote, else the note as typed (a
 *  Forgejo or QNAP repo has no issue canopy can read). */
export async function resolveIssueNote(note: string, deps: { slug: () => Promise<string | null>; gh: GhRun }): Promise<{ note: string; issue?: IssueFrom } | { error: string }> {
  const ref = parseIssueRef(note);
  if (!ref) return { note };
  const slug = await deps.slug();
  if (!slug) return { note };
  const got = await fetchIssue(ref, slug, deps.gh);
  return "error" in got
    ? got
    : { note: issueNote(got.issue, ref.rest), issue: { number: got.issue.number, title: got.issue.title, url: got.issue.url, slug } };
}
