import { stat } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { git, onHost } from "./exec";
import { parseLocator } from "./host";
import type {
  CommitDetail,
  CommitFile,
  GitUser,
  LogEntry,
  RemoteTip,
  RepoFile,
  RepoStatus,
} from "./types";

/** Resolve a repo-relative path, refusing anything that escapes the repo.
 *  Guards the `--no-index` diff, which happily reads files outside the repo. */
export function repoRelative(repoPath: string, file: string): string {
  if (file === "" || isAbsolute(file) || file.includes("\0")) {
    throw new Error(`invalid path: ${file}`);
  }
  // The check is lexical, so a remote repo's path serves as well as a local
  // one; only the locator's scheme has to come off first.
  const root = resolve(parseLocator(repoPath).path);
  const full = resolve(root, file);
  if (full !== root && !full.startsWith(root + sep)) {
    throw new Error(`path escapes the repo: ${file}`);
  }
  return full;
}

const ESCAPES: Record<string, number> = {
  a: 7,
  b: 8,
  t: 9,
  n: 10,
  v: 11,
  f: 12,
  r: 13,
  '"': 34,
  "\\": 92,
};

/** Undo git's C-style path quoting. Even with core.quotePath=false git still
 *  wraps paths containing `"`, `\` or control characters in double quotes and
 *  octal-escapes the raw bytes; left as-is those names match no file on disk. */
export function unquotePath(p: string): string {
  if (p.length < 2 || !p.startsWith('"') || !p.endsWith('"')) return p;
  const chars = Array.from(p.slice(1, -1));
  const encoder = new TextEncoder();
  const bytes: number[] = [];
  for (let i = 0; i < chars.length; i++) {
    const ch = chars[i] as string;
    if (ch !== "\\") {
      bytes.push(...encoder.encode(ch));
      continue;
    }
    const next = chars[++i];
    if (next === undefined) break;
    const simple = ESCAPES[next];
    if (simple !== undefined) {
      bytes.push(simple);
      continue;
    }
    if (next >= "0" && next <= "7") {
      const octal = chars
        .slice(i, i + 3)
        .join("")
        .match(/^[0-7]{1,3}/)?.[0];
      if (octal) {
        bytes.push(parseInt(octal, 8));
        i += octal.length - 1;
        continue;
      }
    }
    bytes.push(...encoder.encode(next));
  }
  return new TextDecoder().decode(new Uint8Array(bytes));
}

/** Split into n fields on single spaces; the last field keeps its spaces. */
function splitN(line: string, n: number): string[] {
  const out: string[] = [];
  let rest = line;
  for (let i = 0; i < n - 1; i++) {
    const sp = rest.indexOf(" ");
    if (sp === -1) break;
    out.push(rest.slice(0, sp));
    rest = rest.slice(sp + 1);
  }
  out.push(rest);
  return out;
}

/** Parse `git status --porcelain=v2 --branch` output. */
export function parsePorcelainV2(
  text: string,
): Omit<RepoStatus, "lastCommit" | "user"> {
  let branch = "";
  let upstream: string | null = null;
  let ahead = 0;
  let behind = 0;
  const files: RepoFile[] = [];

  for (const line of text.split("\n")) {
    if (line === "") continue;
    if (line.startsWith("# branch.head ")) {
      branch = line.slice("# branch.head ".length);
    } else if (line.startsWith("# branch.upstream ")) {
      upstream = line.slice("# branch.upstream ".length);
    } else if (line.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(line);
      if (m) {
        ahead = Number(m[1]);
        behind = Number(m[2]);
      }
    } else if (line.startsWith("1 ")) {
      const f = splitN(line, 9);
      const xy = f[1] ?? "..";
      files.push({
        path: unquotePath(f[8] ?? ""),
        index: xy[0] ?? ".",
        worktree: xy[1] ?? ".",
        untracked: false,
        conflicted: false,
      });
    } else if (line.startsWith("2 ")) {
      const f = splitN(line, 10);
      const xy = f[1] ?? "..";
      const [path = "", orig] = (f[9] ?? "").split("\t");
      files.push({
        path: unquotePath(path),
        orig: orig === undefined ? undefined : unquotePath(orig),
        index: xy[0] ?? ".",
        worktree: xy[1] ?? ".",
        untracked: false,
        conflicted: false,
      });
    } else if (line.startsWith("u ")) {
      const f = splitN(line, 11);
      const xy = f[1] ?? "..";
      files.push({
        path: unquotePath(f[10] ?? ""),
        index: xy[0] ?? ".",
        worktree: xy[1] ?? ".",
        untracked: false,
        conflicted: true,
      });
    } else if (line.startsWith("? ")) {
      files.push({
        path: unquotePath(line.slice(2)),
        index: ".",
        worktree: ".",
        untracked: true,
        conflicted: false,
      });
    }
  }
  return { branch, upstream, ahead, behind, files };
}

/** Parse `git config --get-regexp '^user\.(name|email)$'` output. Git prints
 *  every matching entry, global before local, and the last one wins. That is
 *  the same precedence a commit would use. */
export function parseUserConfig(text: string): GitUser | null {
  let name = "";
  let email = "";
  for (const line of text.split("\n")) {
    const [key, value = ""] = splitN(line, 2);
    if (key === "user.name") name = value.trim();
    else if (key === "user.email") email = value.trim();
  }
  return name || email ? { name, email } : null;
}

/** The remote-tracking refs the checkout does not contain, newest committer
 *  date first, under every remote or just the ones named. `--no-merged=HEAD`
 *  is what "not contained" means to git; the count leaves room for each
 *  remote's HEAD symref, which the parser skips. A pattern without a glob
 *  matches whole path components, so `origin` never takes in `origin2`. */
export const tipArgs = (remotes?: string[]): string[] => [
  "for-each-ref",
  "--sort=-committerdate",
  "--no-merged=HEAD",
  "--count=8",
  "--format=%(refname:short)%00%(objectname:short)%00%(committerdate:unix)%00%(subject)%00%(symref)",
  ...(remotes ? remotes.map((r) => `refs/remotes/${r}`) : ["refs/remotes"]),
];

/** The first real branch out of `TIP_ARGS` output: `origin/HEAD` is a symref
 *  to the default branch and says nothing of its own. */
export function parseRemoteTip(text: string): RemoteTip | undefined {
  for (const line of text.split("\n")) {
    if (line === "") continue;
    const [ref = "", hash = "", ct = "", subject = "", symref = ""] = line.split("\0");
    if (symref !== "" || !ref || !hash) continue;
    return { ref, hash, subject, at: Number(ct) || 0 };
  }
  return undefined;
}

/** One line per path given, in order: the file's mtime in unix seconds, or
 *  an empty line when it is gone. GNU stat is tried first and BSD stat when
 *  that fails, since the host may be either; a missing file fails both. */
export const MTIME_SCRIPT =
  'cd "$0" && for f; do stat -c %Y -- "$f" 2>/dev/null || stat -f %m -- "$f" 2>/dev/null || echo; done';

/** Read the script's output back into one entry per path asked about. */
export function parseMtimes(text: string, n: number): (number | undefined)[] {
  const lines = text.split("\n");
  return Array.from({ length: n }, (_, i) => {
    const v = lines[i]?.trim() ?? "";
    return /^\d+$/.test(v) ? Number(v) : undefined;
  });
}

/** More changed files than this get no time: a repo with an unignored
 *  node_modules would otherwise stat tens of thousands of files per event. */
const MTIME_CAP = 2000;

async function fileMtimes(
  repoPath: string,
  paths: string[],
): Promise<(number | undefined)[]> {
  const { host, path: root } = parseLocator(repoPath);
  const want = paths.slice(0, MTIME_CAP);
  let times: (number | undefined)[];
  if (host === null) {
    times = await Promise.all(
      want.map(async (p) => {
        try {
          return Math.floor((await stat(join(root, p))).mtimeMs / 1000);
        } catch {
          return undefined;
        }
      }),
    );
  } else {
    const r = await onHost(host, ["sh", "-c", MTIME_SCRIPT, root, ...want]);
    times = r.code === 0 ? parseMtimes(r.stdout, want.length) : [];
  }
  return paths.map((_, i) => times[i]);
}

export interface StatusOptions {
  /** the remotes whose branches can be the tip: every remote when absent,
   *  none when empty (the caller has not decided which are the user's) */
  tipRemotes?: string[];
}

export async function getStatus(repoPath: string, opts: StatusOptions = {}): Promise<RepoStatus> {
  const [st, log, cfg, tips] = await Promise.all([
    // -uall lists untracked files individually; without it a new directory
    // arrives as a single "dir/" entry that no per-file diff can render.
    git(repoPath, [
      "-c",
      "core.quotePath=false",
      "status",
      "--porcelain=v2",
      "--branch",
      "-uall",
    ]),
    git(repoPath, ["log", "-1", "--pretty=%h%x00%s%x00%ct"]),
    // exits 1 when nothing matches, which just means no identity
    git(repoPath, ["config", "--get-regexp", "^user\\.(name|email)$"]),
    // fails on an unborn HEAD, which just means no tip
    opts.tipRemotes?.length === 0
      ? Promise.resolve({ code: 1, stdout: "", stderr: "" })
      : git(repoPath, tipArgs(opts.tipRemotes)),
  ]);
  if (st.code !== 0) throw new Error(st.stderr.trim() || "git status failed");
  const status = parsePorcelainV2(st.stdout);
  if (status.files.length > 0) {
    const times = await fileMtimes(
      repoPath,
      status.files.map((f) => f.path),
    );
    status.files = status.files.map((f, i) => {
      const t = times[i];
      return t === undefined ? f : { ...f, mtime: t };
    });
  }
  let lastCommit = null;
  if (log.code === 0 && log.stdout.trim()) {
    const [hash = "", subject = "", ct = "0"] = log.stdout.trim().split("\0");
    lastCommit = { hash, subject, at: Number(ct) };
  }
  const user = cfg.code === 0 ? parseUserConfig(cfg.stdout) : null;
  const tip = tips.code === 0 ? parseRemoteTip(tips.stdout) : undefined;
  return { ...status, lastCommit, user, ...(tip ? { tip } : {}) };
}

/** A fetch may sit on a dead host or a credential lookup; a minute is long
 *  enough for a real one over a slow link and short enough that four stuck
 *  ones do not stall a whole refresh. */
const FETCH_TIMEOUT = 60_000;

/** Every remote-tracking ref with its hash, one string; the same before and
 *  after a fetch means the fetch brought nothing. */
export async function remoteRefs(repoPath: string): Promise<string> {
  const r = await git(repoPath, ["for-each-ref", "--format=%(objectname) %(refname)", "refs/remotes"]);
  return r.code === 0 ? r.stdout : "";
}

/** Fetch every remote, or just the ones named, pruning branches gone from
 *  them. Never prompts: a remote that wants a password fails instead of
 *  holding the process. The answer is whether any remote-tracking ref moved. */
export async function fetchRepo(repoPath: string, remotes?: string[]): Promise<{ changed: boolean; error?: string }> {
  if (remotes?.length === 0) return { changed: false };
  const before = await remoteRefs(repoPath);
  const which = remotes ? ["--multiple", ...remotes] : ["--all"];
  const r = await git(repoPath, ["fetch", ...which, "--prune", "--quiet"], FETCH_TIMEOUT, {
    GIT_TERMINAL_PROMPT: "0",
  });
  const after = await remoteRefs(repoPath);
  const changed = before !== after;
  return r.code === 0 ? { changed } : { changed, error: r.stderr.trim() || `git fetch exited ${r.code}` };
}

export async function getLog(repoPath: string, n = 20): Promise<LogEntry[]> {
  const r = await git(repoPath, [
    "log",
    `-${n}`,
    "--pretty=%h%x00%s%x00%an%x00%ar",
  ]);
  if (r.code !== 0) return [];
  return r.stdout
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [hash = "", subject = "", author = "", when = ""] =
        line.split("\0");
      return { hash, subject, author, when };
    });
}

/** A hash as the UI sends it back: abbreviated or full, nothing else. Anything
 *  looser could reach git's argv as an option (`--output=...`). */
export function isHash(s: string): boolean {
  return /^[0-9a-f]{4,40}$/i.test(s);
}

/** Split the fields of git's `-z` output. Git ends every field with NUL,
 *  so the split leaves one empty tail, which is dropped. */
function zFields(text: string): string[] {
  const parts = text.split("\0");
  if (parts[parts.length - 1] === "") parts.pop();
  return parts;
}

interface Numstat {
  path: string;
  orig?: string;
  added: number | null;
  deleted: number | null;
}

/** Parse `git show --numstat -z`. A line is `added\tdeleted\tpath` with `-`
 *  for both counts on a binary file. A rename has an empty path and carries
 *  the old and new paths as the next two fields. */
export function parseNumstatZ(text: string): Numstat[] {
  const fields = zFields(text);
  const out: Numstat[] = [];
  const count = (s: string): number | null => (s === "-" ? null : Number(s));
  for (let i = 0; i < fields.length; i++) {
    const [a = "", d = "", path = ""] = (fields[i] ?? "").split("\t");
    if (path !== "") {
      out.push({ path, added: count(a), deleted: count(d) });
      continue;
    }
    const orig = fields[++i] ?? "";
    const dest = fields[++i] ?? "";
    out.push({ path: dest, orig, added: count(a), deleted: count(d) });
  }
  return out;
}

interface NameStatus {
  status: string;
  path: string;
  orig?: string;
}

/** Parse `git show --name-status -z`. A status letter, then the path; a
 *  rename or copy carries a similarity score (`R075`) and two paths. */
export function parseNameStatusZ(text: string): NameStatus[] {
  const fields = zFields(text);
  const out: NameStatus[] = [];
  for (let i = 0; i < fields.length; i++) {
    const code = fields[i] ?? "";
    const status = code[0] ?? "X";
    if (status === "R" || status === "C") {
      const orig = fields[++i] ?? "";
      const path = fields[++i] ?? "";
      out.push({ status, path, orig });
    } else {
      out.push({ status, path: fields[++i] ?? "" });
    }
  }
  return out;
}

/** Join the two listings on path. Both come from the same diff so they name
 *  the same files in the same order; a path only numstat knows keeps a
 *  status of X rather than being dropped, so the file count stays honest. */
export function commitFiles(
  numstat: Numstat[],
  names: NameStatus[],
): CommitFile[] {
  const status = new Map(names.map((n) => [n.path, n]));
  return numstat.map((n) => {
    const s = status.get(n.path);
    const file: CommitFile = {
      path: n.path,
      status: s?.status ?? "X",
      added: n.added,
      deleted: n.deleted,
    };
    const orig = n.orig ?? s?.orig;
    if (orig !== undefined) file.orig = orig;
    return file;
  });
}

// Merges show their diff against the first parent, which is what the branch
// saw land; the default for `git show` on a merge is a combined diff that
// lists nothing for a clean merge.
const SHOW = ["show", "--format=", "--diff-merges=first-parent", "-M"];

export class UnknownCommitError extends Error {}

/** Everything the drill shows for one commit: the message in full, who and
 *  when, and each file with its line counts. */
export async function getCommit(
  repoPath: string,
  hash: string,
): Promise<CommitDetail> {
  if (!isHash(hash)) throw new Error(`invalid commit hash: ${hash}`);
  const [head, numstat, names] = await Promise.all([
    git(repoPath, [
      "show",
      "--no-patch",
      "--pretty=%H%x00%h%x00%s%x00%b%x00%an%x00%ae%x00%ct%x00%P",
      hash,
    ]),
    git(repoPath, [...SHOW, "--numstat", "-z", hash]),
    git(repoPath, [...SHOW, "--name-status", "-z", hash]),
  ]);
  if (head.code !== 0) {
    const why = head.stderr.trim();
    // Git says "unknown revision" for a hash it has never seen; anything
    // else (an unreadable repo, say) is a different failure and keeps its text.
    if (!why || /unknown revision|bad object|bad revision/i.test(why)) {
      throw new UnknownCommitError(`no commit ${hash} in this repo`);
    }
    throw new Error(why);
  }
  const [
    full = "",
    short = "",
    subject = "",
    body = "",
    author = "",
    email = "",
    ct = "0",
    parents = "",
  ] = head.stdout.split("\0");
  return {
    hash: full,
    short,
    subject,
    body: body.trim(),
    author,
    email,
    at: Number(ct),
    parents: parents.trim().split(" ").filter(Boolean),
    files: commitFiles(
      parseNumstatZ(numstat.stdout),
      parseNameStatusZ(names.stdout),
    ),
  };
}

/** Which diff of a file to show: the working tree against the index or HEAD,
 *  a file git does not track yet, or what one commit did to it. */
export type DiffTarget =
  | { kind: "worktree"; staged: boolean }
  | { kind: "untracked" }
  | {
      kind: "commit";
      hash: string;
      /** the path before a rename, so git can pair the two sides */
      orig?: string;
    };

/** Diff for one file. Untracked files render as an all-added diff. */
export async function getDiff(
  repoPath: string,
  file: string,
  target: DiffTarget,
): Promise<string> {
  // `file` reaches here straight from a query param — never let it leave the
  // repo. Validate, then hand git the original relative path so the diff
  // header still reads b/<file> rather than an absolute path.
  repoRelative(repoPath, file);
  switch (target.kind) {
    case "untracked": {
      const r = await git(repoPath, [
        "diff",
        "--no-index",
        "--",
        "/dev/null",
        file,
      ]);
      return r.stdout; // --no-index exits 1 on differences; output is still the diff
    }
    case "worktree": {
      const args = ["diff"];
      if (target.staged) args.push("--cached");
      args.push("--", file);
      const r = await git(repoPath, args);
      return r.code === 0 ? r.stdout : r.stderr;
    }
    case "commit": {
      if (!isHash(target.hash)) {
        throw new Error(`invalid commit hash: ${target.hash}`);
      }
      const paths = [file];
      if (target.orig !== undefined) {
        repoRelative(repoPath, target.orig);
        paths.push(target.orig);
      }
      const r = await git(repoPath, [...SHOW, target.hash, "--", ...paths]);
      return r.code === 0 ? r.stdout : r.stderr;
    }
    default: {
      const _exhaustive: never = target;
      return _exhaustive;
    }
  }
}

export async function stageFile(
  repoPath: string,
  file: string,
  unstage: boolean,
): Promise<void> {
  repoRelative(repoPath, file);
  if (!unstage) {
    const r = await git(repoPath, ["add", "--", file]);
    if (r.code !== 0) throw new Error(r.stderr.trim() || "git stage failed");
    return;
  }
  let r = await git(repoPath, ["restore", "--staged", "--", file]);
  // Before the first commit there is no HEAD to restore from; dropping the
  // file from the index is the equivalent operation on an unborn branch.
  if (r.code !== 0 && /resolve 'HEAD'|unknown revision/i.test(r.stderr)) {
    r = await git(repoPath, ["rm", "--cached", "--", file]);
  }
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git unstage failed");
}

export async function commit(
  repoPath: string,
  message: string,
  opts: { stageAll?: boolean } = {},
): Promise<string> {
  if (opts.stageAll) {
    const a = await git(repoPath, ["add", "-A"]);
    if (a.code !== 0) throw new Error(a.stderr.trim() || "git add failed");
  }
  const r = await git(repoPath, ["commit", "-m", message]);
  if (r.code !== 0) {
    throw new Error((r.stdout + r.stderr).trim() || "git commit failed");
  }
  return r.stdout.trim();
}

/** Whether the remote refused *us*, as opposed to rejecting the ref. Only this
 *  warrants trying a different remote: a non-fast-forward means we are behind,
 *  and retrying elsewhere would push a stale branch somewhere new. Deliberately
 *  narrow — a server-side unpack failure is a broken remote, not a wrong one. */
export function isAccessDenied(stderr: string): boolean {
  // 403 only where git frames it as a status, so a bare "403" elsewhere in
  // push output (hook chatter, diff stats) cannot trigger a retry.
  return /permission.+denied|(?:error|status)[^\n]{0,12}\b403\b|authentication failed|not authorized|access denied|repository not found/i.test(
    stderr,
  );
}

/** Push targets, most-preferred first: whatever the branch tracks, then every
 *  other remote. Forks commonly track a read-only upstream while the writable
 *  copy sits on a differently named remote. */
async function pushTargets(
  repoPath: string,
  branch: string,
): Promise<{ tracked: string; ordered: string[] }> {
  const listed = await git(repoPath, ["remote"]);
  const remotes =
    listed.code === 0
      ? listed.stdout
          .split("\n")
          .map((s) => s.trim())
          .filter(Boolean)
      : [];
  const cfg = await git(repoPath, [
    "config",
    "--get",
    `branch.${branch}.remote`,
  ]);
  const tracked = cfg.code === 0 ? cfg.stdout.trim() : "";
  const ordered = remotes.includes(tracked)
    ? [tracked, ...remotes.filter((r) => r !== tracked)]
    : remotes;
  return { tracked, ordered };
}

export async function push(repoPath: string): Promise<string> {
  const head = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = head.stdout.trim();
  if (!branch || branch === "HEAD") {
    throw new Error("detached HEAD — check out a branch first");
  }
  const { tracked, ordered } = await pushTargets(repoPath, branch);
  if (ordered.length === 0) throw new Error("no remote configured");

  let lastErr = "";
  for (const remote of ordered) {
    // Adopt a remote as upstream only when the branch has none. If it already
    // tracks something we cannot push to, quietly repointing it would hide
    // how far behind that upstream we are.
    const args =
      remote === tracked
        ? ["push"]
        : tracked
          ? ["push", remote, `HEAD:${branch}`]
          : ["push", "-u", remote, `HEAD:${branch}`];
    const r = await git(repoPath, args, 120_000);
    if (r.code === 0) {
      const out = (r.stdout + r.stderr).trim();
      return remote === tracked ? out : `pushed to ${remote}\n${out}`;
    }
    lastErr = r.stderr.trim() || "git push failed";
    if (!isAccessDenied(lastErr)) break;
  }
  // Every remote refused us. Say so plainly: the fallback cannot help a clone
  // whose only remote belongs to someone else.
  if (isAccessDenied(lastErr)) {
    const tried =
      ordered.length === 1
        ? `its only remote (${ordered[0]})`
        : `all ${ordered.length} remotes (${ordered.join(", ")})`;
    throw new Error(
      `${lastErr}\n\nNo remote accepted this push — tried ${tried}. ` +
        `Fork the repo, then add your copy as a remote to push this branch.`,
    );
  }
  throw new Error(lastErr);
}

export async function pull(repoPath: string): Promise<string> {
  const r = await git(repoPath, ["pull", "--ff-only"], 120_000);
  if (r.code !== 0) throw new Error(r.stderr.trim() || "git pull failed");
  return r.stdout.trim();
}
