import { isAbsolute, resolve, sep } from "node:path";
import { git } from "./exec";
import type { GitUser, LogEntry, RepoFile, RepoStatus } from "./types";

/** Resolve a repo-relative path, refusing anything that escapes the repo.
 *  Guards the `--no-index` diff, which happily reads files outside the repo. */
export function repoRelative(repoPath: string, file: string): string {
  if (file === "" || isAbsolute(file) || file.includes("\0")) {
    throw new Error(`invalid path: ${file}`);
  }
  const root = resolve(repoPath);
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

export async function getStatus(repoPath: string): Promise<RepoStatus> {
  const [st, log, cfg] = await Promise.all([
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
  ]);
  if (st.code !== 0) throw new Error(st.stderr.trim() || "git status failed");
  const status = parsePorcelainV2(st.stdout);
  let lastCommit = null;
  if (log.code === 0 && log.stdout.trim()) {
    const [hash = "", subject = "", ct = "0"] = log.stdout.trim().split("\0");
    lastCommit = { hash, subject, at: Number(ct) };
  }
  const user = cfg.code === 0 ? parseUserConfig(cfg.stdout) : null;
  return { ...status, lastCommit, user };
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

/** Diff for one file. Untracked files render as an all-added diff. */
export async function getDiff(
  repoPath: string,
  file: string,
  opts: { staged?: boolean; untracked?: boolean } = {},
): Promise<string> {
  // `file` reaches here straight from a query param — never let it leave the
  // repo. Validate, then hand git the original relative path so the diff
  // header still reads b/<file> rather than an absolute path.
  repoRelative(repoPath, file);
  if (opts.untracked) {
    const r = await git(repoPath, [
      "diff",
      "--no-index",
      "--",
      "/dev/null",
      file,
    ]);
    return r.stdout; // --no-index exits 1 on differences; output is still the diff
  }
  const args = ["diff"];
  if (opts.staged) args.push("--cached");
  args.push("--", file);
  const r = await git(repoPath, args);
  return r.code === 0 ? r.stdout : r.stderr;
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
