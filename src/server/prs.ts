/** The PR watch's server half (FR-011): "open PR" on a ready branch run,
 *  one loop that reads every open PR it opened, auto-fix (a failed check or
 *  a trusted review comment starts a fix run on the branch, and canopy
 *  pushes what it commits), auto-merge, the routes, and the `prs` event.
 *  The model and its words are `core/pr.ts`; the git is `core/worktree.ts`.
 *
 *  Records live under `<configDir>/prs/<branch id>.json`. Only the server
 *  holding the flows lock writes them (`adopt`), as with the landing
 *  records. A branch run lands through the queue or opens a PR, never both
 *  (call 1): the landing record carries the PR's number, and the queue
 *  refuses it. */

import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { exec, git, type ExecResult } from "../core/exec";
import { githubSlug } from "../core/github";
import type { ProbeResult } from "../core/health";
import {
  checkKey,
  commentKey,
  exhausted,
  fixPromptForCheck,
  fixPromptForComment,
  fixPromptForConflict,
  MAX_ATTEMPTS,
  mergeMethod,
  nextPoll,
  parseComments,
  parsePrView,
  parseRepoDefault,
  POLL_BUSY,
  prBody,
  prNumberOf,
  PR_FIELDS,
  readyToMerge,
  readyToRebase,
  rebaseKey,
  trusted,
  watchHolds,
} from "../core/pr";
import { configDir } from "../core/store";
import { SWEEP_COMMENT_PREFIX } from "../core/sweep";
import type { LandingRun, PrComment, PrNow, PrState, PrWatch, Run, RunReview, ServerEvent } from "../core/types";
import { isRunActive } from "../core/types";
import { dirtyFiles, pushBranch, pushBranchLease, pushRemote, rebaseOnto, removeRunTree, revOf, showAtHead, subjectsSince } from "../core/worktree";
import { sortRun } from "./landing";

export const prsDir = (): string => join(configDir(), "prs");
/** how often the loop looks for a PR that is due a read */
export const TICK_EVERY = 5_000;
/** how long after a push canopy made the PR is read at the busy pace */
export const FRESH_FOR = 10 * 60_000;
/** merged and closed PRs kept for the list */
export const KEEP_DONE = 20;
/** the file a repo turns auto-merge on with, read from its main checkout's HEAD */
export const REPO_DEFAULT_FILE = ".canopy/prs.json";
/** how often a PR the sweep closed is read, for a reopen */
export const SWEPT_POLL = 24 * 3_600_000;
/** how long a PR the sweep closed is watched for a reopen */
export const SWEPT_FOR = 30 * 24 * 3_600_000;

/** how far from the close the sweep's comment may be posted: `gh pr
 *  close --comment` comments, then closes, seconds apart */
export const SWEEP_CLOSE_SKEW = 5 * 60_000;

/** Who closed a PR, as the watch reads it: the gh login, when GitHub says
 *  it closed, and its newest comments (so a long thread never pages). */
const CLOSED_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  viewer { login }
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      closedAt
      comments(last: 20) { nodes { body createdAt author { login } } }
    }
  }
}`;

/** One PR as the sweep's last look before a close reads it; `gh pr view`
 *  has no merge queue field, so GraphQL. */
const STATE_QUERY = `query($owner: String!, $name: String!, $number: Int!) {
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      state updatedAt isDraft
      autoMergeRequest { enabledAt }
      mergeQueueEntry { id }
    }
  }
}`;

/** `STATE_QUERY`'s answer, or null when it does not read. */
export function prNowOf(body: unknown): PrNow | null {
  const data = isRecord(body) ? body["data"] : undefined;
  const repo = isRecord(data) ? data["repository"] : undefined;
  const pr = isRecord(repo) ? repo["pullRequest"] : undefined;
  if (!isRecord(pr) || typeof pr["state"] !== "string" || typeof pr["updatedAt"] !== "string") return null;
  const updatedAt = Date.parse(pr["updatedAt"]);
  if (Number.isNaN(updatedAt)) return null;
  return { state: pr["state"], updatedAt, draft: pr["isDraft"] === true, autoMerge: pr["autoMergeRequest"] != null, queued: pr["mergeQueueEntry"] != null };
}

/** the words `gh api graphql` takes for a query on one PR */
const prQuery = (query: string, slug: string, number: number): string[] => {
  const [owner = "", name = ""] = slug.split("/");
  return ["api", "graphql", "-f", `query=${query}`, "-f", `owner=${owner}`, "-f", `name=${name}`, "-F", `number=${number}`];
};

/** When the sweep closed the PR, from `CLOSED_QUERY`'s answer: a comment
 *  by the gh login that starts as the sweep's does, posted within
 *  `SWEEP_CLOSE_SKEW` of the close, so a sweep comment from before a
 *  reopen and a later hand close does not count. Null for a close the
 *  sweep did not make; undefined when the answer, or its `closedAt`, does
 *  not read. */
export function sweptAtOf(body: unknown): number | null | undefined {
  const data = isRecord(body) ? body["data"] : undefined;
  if (!isRecord(data)) return undefined;
  const viewer = isRecord(data["viewer"]) ? data["viewer"]["login"] : undefined;
  const repo = data["repository"];
  const pr = isRecord(repo) ? repo["pullRequest"] : undefined;
  const nodes = isRecord(pr) && isRecord(pr["comments"]) ? pr["comments"]["nodes"] : undefined;
  if (typeof viewer !== "string" || !isRecord(pr) || !Array.isArray(nodes)) return undefined;
  // a close GitHub gives no time for cannot be told: asked again, never freed
  const closedAt = typeof pr["closedAt"] === "string" ? Date.parse(pr["closedAt"]) : NaN;
  if (Number.isNaN(closedAt)) return undefined;
  const me = viewer.toLowerCase();
  const ours = nodes.some((c) => {
    if (!isRecord(c) || typeof c["body"] !== "string" || typeof c["createdAt"] !== "string") return false;
    const author = isRecord(c["author"]) ? c["author"]["login"] : undefined;
    const at = Date.parse(c["createdAt"]);
    return c["body"].trimStart().startsWith(SWEEP_COMMENT_PREFIX) && typeof author === "string" && author.toLowerCase() === me && Math.abs(at - closedAt) <= SWEEP_CLOSE_SKEW;
  });
  return ours ? closedAt : null;
}

/** when a watch is read next, from now: once a day while the sweep has it
 *  closed or who closed it is not known yet, else `nextPoll`'s pace (null
 *  for none) */
const pace = (w: PrWatch): number | null => (w.swept !== undefined || w.closeUnread !== undefined ? SWEPT_POLL : nextPoll(w));

export class PrError extends Error {
  constructor(
    message: string,
    readonly status = 409,
  ) {
    super(message);
  }
}

export interface PrDeps {
  broadcast: (ev: ServerEvent) => void;
  /** runs `gh` with these words; `exec(["gh", ...])` unless a test says otherwise */
  gh?: (args: string[], cwd?: string) => Promise<ExecResult>;
  /** a remote's GitHub `owner/name`, or null; read from its url unless a test says otherwise */
  slugOf?: (repoPath: string, remote: string) => Promise<string | null>;
  /** a branch run's landing record, by the branch's id or its latest run's */
  record: (id: string) => LandingRun | undefined;
  /** why the landing queue has this branch (queued, landed), or null */
  queueHold: (id: string) => string | null;
  /** puts the PR's number on the branch's landing record, or takes it off */
  markPr: (id: string, pr: number | null) => void;
  /** a merged PR's branch: its landing record goes */
  forget: (id: string) => Promise<void>;
  /** starts a fix run on the branch with this message; `label` is its note */
  startFix: (rec: LandingRun, prompt: string, label: string) => Promise<Run>;
  /** whether a run is still going, by id */
  runActive: (id: string) => boolean;
  /** whether a run ended with the agent finishing; false for one stopped,
   *  failed, or no longer known (a restart took it) */
  runOk: (id: string) => boolean;
  /** sorts a branch run's worktree by its repo's review rules */
  sort?: (rec: LandingRun, now: number) => Promise<RunReview>;
  /** the `canopy:prs` health check */
  report?: (r: ProbeResult) => void;
  dir?: string;
  now?: () => number;
  tickEvery?: number;
}

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const errText = (err: unknown): string => String(err instanceof Error ? err.message : err);
const lastLine = (r: ExecResult, what: string): string => (r.stderr.trim() || r.stdout.trim()).split("\n").filter(Boolean).pop() ?? `${what} exited ${r.code}`;

const runGh = (args: string[], cwd?: string): Promise<ExecResult> => exec(["gh", ...args], { ...(cwd ? { cwd } : {}), timeoutMs: 60_000 });
/** what stops canopy for a PR whose lease push the remote refused */
const MOVED = "the branch moved on GitHub since canopy pushed; rebase it yourself";

async function remoteSlug(repoPath: string, remote: string): Promise<string | null> {
  const r = await git(repoPath, ["remote", "get-url", remote]);
  return r.code === 0 ? githubSlug(r.stdout.trim()) : null;
}

export class PrHub {
  private watches = new Map<string, PrWatch>();
  /** when each watch is read next, unix ms; a done one has none */
  private due = new Map<string, number>();
  /** every change to a watch runs here, one after another */
  private serial: Promise<void> = Promise.resolve();
  private keeping = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private ticking = false;
  private stopped = false;
  /** until when each PR is read every 30 s after canopy pushed to it, so
   *  CI that GitHub has not queued yet is seen soon; kept in memory only */
  private fresh = new Map<string, number>();
  /** collaborator permissions by `slug login`, asked once per server */
  private perms = new Map<string, string | null>();
  private chains = new Map<string, Promise<void>>();

  constructor(private deps: PrDeps) {}

  private get dir(): string {
    return this.deps.dir ?? prsDir();
  }
  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }
  private gh(args: string[], cwd?: string): Promise<ExecResult> {
    return (this.deps.gh ?? runGh)(args, cwd);
  }

  info(): PrWatch[] {
    return [...this.watches.values()].sort((a, b) => b.openedAt - a.openedAt);
  }

  /** whether this server writes the records: it holds the flows lock */
  get keeps(): boolean {
    return this.keeping;
  }

  /** the watch on a PR, by its slug in any case and its number */
  watchFor(slug: string, number: number): PrWatch | undefined {
    const want = slug.toLowerCase();
    return [...this.watches.values()].find((w) => w.number === number && w.slug.toLowerCase() === want);
  }

  private publish(): void {
    this.deps.broadcast({ type: "prs", prs: this.info() });
  }

  /** Runs one change after every change before it, so a read, a toggle
   *  and a fix's end never work one watch at once. */
  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.serial.then(fn);
    this.serial = p.then(
      () => undefined,
      () => undefined,
    );
    return p;
  }

  /** Resolves once every change asked for so far is done and on disk. */
  async idle(): Promise<void> {
    await this.serial;
    while (this.chains.size > 0) await Promise.all(this.chains.values());
  }

  /* ---------- records ---------- */

  private save(w: PrWatch): void {
    this.watches.set(w.id, w);
    this.persist(w.id);
  }

  private persist(id: string): void {
    if (!this.keeping) return;
    const path = join(this.dir, `${id}.json`);
    const write = async (): Promise<void> => {
      const data = this.watches.get(id);
      if (!data) {
        await rm(path, { force: true });
        return;
      }
      await mkdir(this.dir, { recursive: true });
      const tmp = `${path}.tmp-${process.pid}`;
      await writeFile(tmp, JSON.stringify(data, null, 2));
      await rename(tmp, path);
    };
    const next = (this.chains.get(path) ?? Promise.resolve()).then(write).catch((err) => console.error(`prs: ${errText(err)}`));
    this.chains.set(path, next);
    void next.then(() => {
      if (this.chains.get(path) === next) this.chains.delete(path);
    });
  }

  private drop(id: string): void {
    this.watches.delete(id);
    this.due.delete(id);
    this.persist(id);
  }

  /** Merged and closed PRs past the newest `KEEP_DONE` go; one the sweep
   *  closed stays for its 30 days. */
  private prune(): void {
    const done = this.info().filter((w) => w.state && w.state.status !== "open" && w.swept === undefined && w.closeUnread === undefined);
    for (const w of done.slice(KEEP_DONE)) this.drop(w.id);
  }

  /** Takes the records the last server left, as the holder of the flows
   *  lock, and reads every open PR soon. Writes from now on. */
  async adopt(): Promise<void> {
    this.keeping = true;
    let names: string[] = [];
    try {
      names = await readdir(this.dir);
    } catch {
      // no PR opened yet
    }
    for (const n of names.filter((x) => x.endsWith(".json"))) {
      try {
        const v: unknown = JSON.parse(await readFile(join(this.dir, n), "utf8"));
        if (isRecord(v) && typeof v["id"] === "string" && typeof v["number"] === "number" && !this.watches.has(v["id"])) {
          const w = v as unknown as PrWatch;
          this.watches.set(w.id, w);
        }
      } catch (err) {
        console.error(`prs: ${n} unreadable, left alone: ${errText(err)}`);
      }
    }
    const now = this.now();
    for (const w of this.watches.values()) if (pace(w) !== null) this.due.set(w.id, now);
    this.publish();
  }

  detach(): void {
    this.keeping = false;
  }

  start(): void {
    this.stopped = false;
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.deps.tickEvery ?? TICK_EVERY);
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** Whether a watch still holds the branch `id` (the landing record's id):
   *  its PR not swept and not read as closed or merged. The landing hub
   *  will not drop such a branch. */
  holds(id: string): boolean {
    return watchHolds(this.watches.get(id));
  }

  /** The watched PRs canopy is working on, as `slug#number` (the slug
   *  lowercased): a fix going, canopy's own auto-merge on, or a run on the
   *  branch going. The sweep never offers them. */
  busy(): Set<string> {
    const out = new Set<string>();
    for (const w of this.watches.values()) if (w.fixing || w.autoMerge || this.deps.runActive(w.runId)) out.add(`${w.slug.toLowerCase()}#${w.number}`);
    return out;
  }

  private find(id: string): PrWatch | undefined {
    return this.watches.get(id) ?? [...this.watches.values()].find((w) => w.runId === id);
  }

  /* ---------- open ---------- */

  /** "open PR" on a ready branch run: push its branch, open the PR, and
   *  start watching it. The run leaves the landing queue's ready list. */
  open(id: string, opts: { draft?: boolean } = {}): Promise<PrWatch> {
    return this.queue(async () => {
      const rec = this.deps.record(id);
      if (!rec) throw new PrError("no branch run by that id", 404);
      if (rec.pr !== undefined) throw new PrError(`it opened PR #${rec.pr} already`);
      if (this.deps.runActive(rec.runId)) throw new PrError("the run is still going; open its PR once it ends");
      if (rec.state !== "ready") throw new PrError(`only a ready run opens a PR; this one is ${rec.state}`);
      const held = this.deps.queueHold(rec.id);
      if (held) throw new PrError(`${held}; a run lands or opens a PR, never both`);
      const dirty = await dirtyFiles(rec.dir).catch(() => ["?"]);
      if (dirty.length > 0) throw new PrError("its worktree has changes not committed");
      const remote = await pushRemote(rec.repoPath, rec.target);
      if (!remote) throw new PrError("its repo has no remote to push to");
      const slug = await (this.deps.slugOf ?? remoteSlug)(rec.repoPath, remote);
      if (!slug) throw new PrError(`its remote ${remote} is not on GitHub`);
      const auth = await this.gh(["auth", "status"]);
      if (auth.code !== 0) throw new PrError("gh is not logged in on this machine");
      const head = await revOf(rec.dir, "HEAD");
      if (!head) throw new PrError("its worktree is gone");
      const pushed = await pushBranch(rec.dir, remote, rec.branch);
      if ("rejected" in pushed) throw new PrError(`the push was refused: ${pushed.rejected}`);
      const subjects = await subjectsSince(rec.dir, rec.target);
      const title = subjects[0] ?? rec.note.split("\n")[0] ?? rec.branch;
      const args = ["pr", "create", "-R", slug, "--head", rec.branch, "--base", rec.target, "--title", title, "--body", prBody(rec.note, subjects)];
      if (opts.draft) args.push("--draft");
      const made = await this.gh(args, rec.repoPath);
      const number = made.code === 0 ? prNumberOf(made.stdout) : null;
      if (number === null) throw new PrError(`gh pr create: ${lastLine(made, "gh pr create")}`, 502);
      const now = this.now();
      const w: PrWatch = {
        id: rec.id,
        runId: rec.runId,
        repoId: rec.repoId,
        repoPath: rec.repoPath,
        branch: rec.branch,
        target: rec.target,
        dir: rec.dir,
        note: rec.note,
        slug,
        remote,
        number,
        url: made.stdout.trim().split("\n").pop() ?? "",
        autoFix: false,
        autoMerge: parseRepoDefault(await showAtHead(rec.repoPath, REPO_DEFAULT_FILE)).autoMerge,
        pushed: head,
        attempts: {},
        seenComment: 0,
        openedAt: now,
        updatedAt: now,
      };
      this.save(w);
      this.deps.markPr(rec.id, number);
      this.due.set(w.id, now);
      this.fresh.set(w.id, now + FRESH_FOR);
      this.publish();
      return w;
    });
  }

  /* ---------- toggles and close ---------- */

  /** The footer's toggles. Turning auto-fix on marks the comments already
   *  there as seen: it acts on what arrives while it is on. */
  set(id: string, change: { autoFix?: boolean; autoMerge?: boolean }): Promise<PrWatch> {
    return this.queue(async () => {
      const had = this.find(id);
      if (!had) throw new PrError("no PR by that id", 404);
      let w: PrWatch = { ...had, updatedAt: this.now() };
      if (change.autoMerge !== undefined) w.autoMerge = change.autoMerge;
      if (change.autoFix !== undefined && change.autoFix !== had.autoFix) {
        w.autoFix = change.autoFix;
        if (change.autoFix) {
          const { gaveUp: _g, ...rest } = w;
          w = { ...rest, attempts: {} };
          const comments = await this.comments(w).catch(() => []);
          w.seenComment = Math.max(w.seenComment, ...comments.map((c) => c.id));
        }
      }
      this.save(w);
      if (pace(w) !== null) this.due.set(w.id, this.now());
      this.publish();
      void this.tick();
      return w;
    });
  }

  /** Changing course: the PR closes and its remote branch goes, and the run
   *  waits as ready to land here again. */
  close(id: string): Promise<void> {
    return this.queue(async () => {
      const w = this.find(id);
      if (!w) throw new PrError("no PR by that id", 404);
      if (w.fixing && this.deps.runActive(w.fixing.run)) throw new PrError("a fix is going; stop it first");
      if (w.state?.status !== "merged") {
        const r = await this.gh(["pr", "close", String(w.number), "-R", w.slug]);
        if (r.code !== 0 && w.state?.status !== "closed") throw new PrError(`gh pr close: ${lastLine(r, "gh pr close")}`, 502);
        await git(w.repoPath, ["push", w.remote, "--delete", w.branch]);
      }
      this.drop(w.id);
      this.deps.markPr(w.id, null);
      this.publish();
    });
  }

  /** The sweep's close: the PR closes with `comment`, and its remote
   *  branch, worktree and local branch stay, as does the landing record's
   *  `pr`, so the branch does not slip back into the landing queue. The
   *  watch stays too, marked `swept` and read once a day for a reopen. */
  sweepClose(id: string, comment: string): Promise<void> {
    return this.queue(async () => {
      const w = this.find(id);
      if (!w) throw new PrError("no PR by that id", 404);
      if (w.fixing && this.deps.runActive(w.fixing.run)) throw new PrError("a fix is going; stop it first");
      if (w.autoMerge) throw new PrError("canopy's auto-merge is on for it");
      if (this.deps.runActive(w.runId)) throw new PrError("a run on its branch is still going");
      const r = await this.gh(["pr", "close", String(w.number), "-R", w.slug, "--comment", comment]);
      if (r.code !== 0) throw new PrError(`gh pr close: ${lastLine(r, "gh pr close")}`, 502);
      const now = this.now();
      this.save({ ...w, ...(w.state ? { state: { ...w.state, status: "closed" as const } } : {}), swept: now, updatedAt: now });
      this.due.set(w.id, now + SWEPT_POLL);
      this.fresh.delete(w.id);
      this.publish();
    });
  }

  /** The sweep's close of a PR the gh login authored: a watched one goes
   *  through `sweepClose`; any other is closed with `comment`, and its
   *  branch stays. Throws with gh's last line. */
  async closeAuthored(slug: string, number: number, comment: string): Promise<void> {
    const w = this.watchFor(slug, number);
    if (w) return this.sweepClose(w.id, comment);
    const r = await this.gh(["pr", "close", String(number), "-R", slug, "--comment", comment]);
    if (r.code !== 0) throw new PrError(`gh pr close: ${lastLine(r, "gh pr close")}`, 502);
  }

  /** One PR as GitHub has it, for the sweep's look just before a close:
   *  its state (`OPEN`, `CLOSED`, `MERGED`), last activity, draft,
   *  auto-merge and merge queue, through one GraphQL query. Throws gh's
   *  last line when gh could not say. */
  async readState(slug: string, number: number): Promise<PrNow> {
    const r = await this.gh(prQuery(STATE_QUERY, slug, number));
    if (r.code !== 0) throw new PrError(`gh api graphql: ${lastLine(r, "gh api graphql")}`, 502);
    let now: PrNow | null = null;
    try {
      now = prNowOf(JSON.parse(r.stdout));
    } catch {
      // said below
    }
    if (!now) throw new PrError("gh api graphql: its answer did not read", 502);
    return now;
  }

  /** A PR found closed with no `swept`: whether the sweep closed it, here
   *  or on another backend, by its comment (`sweptAtOf`). Found, the watch
   *  is marked `swept` from the close and the landing record keeps `pr`;
   *  not found, the run may land here again; an answer gh cannot give
   *  leaves `pr` on the record and the watch to try again in a day. */
  private async whoClosed(w: PrWatch): Promise<PrWatch> {
    const { closeUnread: since, ...rest } = w;
    const r = await this.gh(prQuery(CLOSED_QUERY, w.slug, w.number));
    let at: number | null | undefined;
    try {
      at = r.code === 0 ? sweptAtOf(JSON.parse(r.stdout)) : undefined;
    } catch {
      // read again tomorrow
    }
    if (at === undefined) return { ...rest, closeUnread: since ?? this.now(), error: `reading who closed PR #${w.number}: ${r.code === 0 ? "the answer did not read" : lastLine(r, "gh api graphql")}` };
    if (at === null) {
      this.deps.markPr(w.id, null);
      return rest;
    }
    return { ...rest, swept: at };
  }

  /** A branch the landing queue dropped: its watch goes with it. */
  forgetBranch(id: string): void {
    if (!this.watches.has(id)) return;
    this.drop(id);
    this.publish();
  }

  /* ---------- runs ---------- */

  /** A run changed: a watch follows its branch's latest run, and a fix
   *  that ended is read at once. */
  onRun(run: Run): void {
    const id = run.branch?.origin;
    const w = id ? this.watches.get(id) : undefined;
    if (!w) return;
    if (w.runId !== run.id) {
      this.save({ ...w, runId: run.id });
      this.publish();
    }
    if (w.fixing?.run === run.id && !isRunActive(run)) {
      this.due.set(w.id, this.now());
      void this.tick();
    }
  }

  /* ---------- the loop ---------- */

  /** Reads every watch that is due, one at a time; a tick while one runs
   *  does nothing. */
  async tick(): Promise<void> {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      const now = this.now();
      const ids = [...this.due].filter(([, at]) => at <= now).map(([id]) => id);
      let ok = 0;
      let failed: string | null = null;
      for (const id of ids) {
        if (this.stopped) break;
        const why = await this.queue(() => this.poll(id));
        if (why) failed = why;
        else ok++;
      }
      if (ids.length > 0) this.deps.report?.(ok === 0 && failed ? { state: "down", why: failed } : { state: "ok" });
    } finally {
      this.ticking = false;
    }
  }

  /** One read of a PR and what follows from it: a fix's end, merged or
   *  closed, auto-fix, auto-merge. Returns gh's error when the read failed. */
  private async poll(id: string): Promise<string | null> {
    const had = this.watches.get(id);
    if (!had) {
      this.due.delete(id);
      return null;
    }
    // swept, or closed by no one known, for 30 days, and its last read
    // failed (a repo deleted or out of reach): it goes before another
    // read, so such a watch is not kept forever. The remote branch stays
    // and the landing record keeps its PR, as with the 30-day drop below.
    const since = had.swept ?? had.closeUnread;
    if (since !== undefined && had.error !== undefined && this.now() - since >= SWEPT_FOR) {
      this.drop(id);
      this.publish();
      return null;
    }
    const r = await this.gh(["pr", "view", String(had.number), "-R", had.slug, "--json", PR_FIELDS]);
    let w: PrWatch;
    try {
      if (r.code !== 0) throw new Error(lastLine(r, "gh pr view"));
      const { error: _e, ...rest } = had;
      w = { ...rest, state: parsePrView(JSON.parse(r.stdout)), polledAt: this.now() };
      // reopened (or merged) since it closed: a watch like any other
      if (w.state?.status !== "closed") {
        const { swept: _s, closeUnread: _c, ...open } = w;
        w = open;
      }
    } catch (err) {
      const why = `reading PR #${had.number}: ${errText(err)}`;
      this.save({ ...had, error: why, polledAt: this.now() });
      this.due.set(id, this.now() + (pace(had) ?? 0));
      this.publish();
      return why;
    }
    // swept and still closed after 30 days: the watch goes, with the remote
    // branch where it is and the landing record keeping its PR
    if (w.swept !== undefined && w.state?.status === "closed" && this.now() - w.swept >= SWEPT_FOR) {
      this.drop(id);
      this.publish();
      return null;
    }
    if (w.state?.status === "merged") {
      // merged on GitHub while a run works the branch: its worktree stays until it ends
      if ([w.fixing?.run, w.runId].some((r) => r !== undefined && this.deps.runActive(r))) {
        this.save({ ...w, updatedAt: this.now() });
        this.due.set(id, this.now() + POLL_BUSY);
        this.publish();
        return null;
      }
      // nothing is pushed to a merged PR; what the fix committed is kept below
      const { fixing: _f, ...rest } = w;
      await this.merged(rest);
      return null;
    }
    if (w.fixing && !this.deps.runActive(w.fixing.run)) w = await this.finishFix(w);
    // closed on GitHub: the run may land here again, unless the sweep
    // closed it (here or on another backend), which keeps the PR on the record
    if (w.state?.status === "closed" && w.swept === undefined && (had.state?.status !== "closed" || w.closeUnread !== undefined)) w = await this.whoClosed(w);
    if (w.state?.status === "open") {
      // behind or conflicting on the head canopy pushed: rebased first, so
      // the comment loop and the merge see the pushed head on a later read
      if (w.autoFix && !w.fixing && w.gaveUp === undefined && w.state && readyToRebase(w.state, w).ok) w = await this.rebase(w);
      if (w.autoFix && !w.fixing) w = await this.autoFix(w);
      if (w.autoMerge && !w.fixing && w.state && readyToMerge(w.state, w).ok) {
        w = await this.screen(w, w.state);
        if (w.state && readyToMerge(w.state, w).ok) w = await this.merge(w, w.state);
        if (w.state?.status === "merged") return null;
      }
    }
    w.updatedAt = this.now();
    this.save(w);
    if (w.pushed !== had.pushed) this.fresh.set(id, this.now() + FRESH_FOR);
    let next = pace(w);
    if (next !== null && w.swept === undefined && w.closeUnread === undefined && (this.fresh.get(id) ?? 0) > this.now()) next = Math.min(next, POLL_BUSY);
    if (next === null) this.due.delete(id);
    else this.due.set(id, this.now() + next);
    this.prune();
    this.publish();
    return null;
  }

  /** A fix run ended: what it committed is pushed to the PR, but only when
   *  the agent finished. A run stopped, failed or cut off by a restart
   *  pushes nothing and pauses auto-fix for Eric. One that left changes
   *  uncommitted, or nothing new, counts as a failed attempt (its attempt
   *  was counted when it started), and a comment's is tried again. */
  private async finishFix(w: PrWatch): Promise<PrWatch> {
    const { fixing, error: _e, ...done } = w;
    if (!fixing) return w;
    const failed = (error: string): PrWatch => {
      // a comment's failed fix: read it again, so its next attempt starts
      const id = fixing.key.startsWith("comment:") ? Number(fixing.key.slice("comment:".length)) : NaN;
      return { ...done, error, ...(Number.isFinite(id) ? { seenComment: Math.min(done.seenComment, id - 1) } : {}) };
    };
    if (!this.deps.runOk(fixing.run)) {
      return { ...done, error: "the fix run did not finish; nothing was pushed", gaveUp: "a fix run did not finish, so nothing was pushed; turn auto-fix on again to go on" };
    }
    const dirty = await dirtyFiles(w.dir).catch(() => ["?"]);
    if (dirty.length > 0) return failed("the fix left changes not committed; nothing was pushed");
    const head = await revOf(w.dir, "HEAD");
    if (!head || head === w.pushed) return failed("the fix ended with nothing new to push");
    // a conflict fix rebased the branch, so its push goes with the lease
    const pushed = fixing.key.startsWith("rebase:") ? await pushBranchLease(w.dir, w.remote, w.branch, w.pushed) : await pushBranch(w.dir, w.remote, w.branch);
    if ("rejected" in pushed) return failed(`the push was refused: ${pushed.rejected}`);
    return { ...done, pushed: head };
  }

  /** The PR fell behind its target, or conflicts with it, on the head
   *  canopy pushed: the target is fetched, the branch rebased in its
   *  worktree and pushed again with a lease on that head. A conflict
   *  becomes a fix run with the files named, `MAX_ATTEMPTS` per base
   *  commit; a lease the remote refuses, or a rebase that errors, stops
   *  auto-fix for the PR with why. */
  private async rebase(w: PrWatch): Promise<PrWatch> {
    const onto = `${w.remote}/${w.target}`;
    const fetched = await git(w.dir, ["fetch", w.remote, w.target], 60_000);
    if (fetched.code !== 0) return { ...w, error: `fetching ${w.target}: ${lastLine(fetched, "git fetch")}` };
    const base = await revOf(w.dir, onto);
    if (!base) return { ...w, error: `fetching ${w.target}: ${onto} is not a commit` };
    const key = rebaseKey(base);
    if (exhausted(w, key)) return { ...w, gaveUp: `could not rebase onto ${w.target} after ${MAX_ATTEMPTS} tries` };
    const { error: _e, ...rest } = w;
    this.save({ ...rest, rebasing: { from: w.pushed } });
    this.publish();
    const r = await rebaseOnto(w.dir, onto);
    if ("conflict" in r) return this.startFix(rest, key, fixPromptForConflict(w, r.conflict));
    if ("error" in r) return { ...rest, error: r.error, gaveUp: `could not rebase onto ${w.target}: ${r.error}` };
    const head = await revOf(w.dir, "HEAD");
    if (!head) return { ...rest, error: "the rebased worktree has no HEAD" };
    const pushed = await pushBranchLease(w.dir, w.remote, w.branch, w.pushed);
    if ("rejected" in pushed) return { ...rest, error: MOVED, gaveUp: MOVED };
    return { ...rest, pushed: head };
  }

  /** Starts a fix run for a key, counting the attempt. */
  private async startFix(w: PrWatch, key: string, prompt: string): Promise<PrWatch> {
    const rec = this.deps.record(w.id);
    if (!rec) return { ...w, error: "its branch run's record is gone" };
    const attempts = { ...w.attempts, [key]: (w.attempts[key] ?? 0) + 1 };
    const what = key.startsWith("check:") ? `${key.slice("check:".length)} failed` : key.startsWith("rebase:") ? `rebase onto ${w.target}` : "a review comment";
    try {
      const run = await this.deps.startFix(rec, prompt, `fix PR #${w.number}: ${what} (${attempts[key]}/${MAX_ATTEMPTS})`);
      return { ...w, attempts, runId: run.id, fixing: { run: run.id, key } };
    } catch (err) {
      return { ...w, attempts, error: `could not start a fix: ${errText(err)}` };
    }
  }

  /** Auto-fix on the head canopy pushed: the first failed check with
   *  attempts left, else the next review comment from someone with write
   *  access. A failed check with none left stops auto-fix for the PR. */
  private async autoFix(w: PrWatch): Promise<PrWatch> {
    const s = w.state;
    if (!s || s.head !== w.pushed || w.gaveUp) return w;
    const failed = s.checks.filter((c) => c.state === "fail");
    const next = failed.find((c) => !exhausted(w, checkKey(c.name)));
    if (next) {
      const log = next.actionsRun ? await this.gh(["run", "view", next.actionsRun, "-R", w.slug, "--log-failed"]) : null;
      return this.startFix(w, checkKey(next.name), fixPromptForCheck(w, next, log?.code === 0 ? log.stdout : ""));
    }
    if (failed.length > 0) return { ...w, gaveUp: `${failed.map((c) => c.name).join(", ")} still failing after ${failed.length === 1 ? "its" : "their"} fixes` };
    let comments: PrComment[];
    try {
      comments = (await this.comments(w)).filter((c) => c.id > w.seenComment).sort((a, b) => a.id - b.id);
    } catch (err) {
      return { ...w, error: `reading comments: ${errText(err)}` };
    }
    let cur = w;
    for (const c of comments) {
      let perm: string | null;
      try {
        perm = await this.permission(w.slug, c.author);
      } catch (err) {
        // gh could not say: this comment and the ones after it wait for the next read
        return { ...cur, error: errText(err) };
      }
      if (!trusted(perm)) {
        cur = { ...cur, seenComment: c.id, untrusted: [...(cur.untrusted ?? []).filter((x) => x.id !== c.id), c].slice(-20) };
        continue;
      }
      const key = commentKey(c.id);
      cur = { ...cur, seenComment: c.id };
      if (exhausted(cur, key)) return { ...cur, gaveUp: `a review comment by ${c.author} is still not addressed after ${MAX_ATTEMPTS} fixes` };
      return this.startFix(cur, key, fixPromptForComment(cur, c));
    }
    return cur;
  }

  private async comments(w: PrWatch): Promise<PrComment[]> {
    const r = await this.gh(["api", `repos/${w.slug}/pulls/${w.number}/comments?per_page=100`]);
    if (r.code !== 0) throw new Error(lastLine(r, "gh api"));
    return parseComments(JSON.parse(r.stdout));
  }

  /** A login's permission on the repo, kept once GitHub answers; null for
   *  no access (a 404, as for a bot or a deleted user). Throws when gh
   *  could not say, so a rate limit or an outage never marks anyone. */
  private async permission(slug: string, login: string): Promise<string | null> {
    const key = `${slug} ${login}`;
    if (this.perms.has(key)) return this.perms.get(key) ?? null;
    const r = await this.gh(["api", `repos/${slug}/collaborators/${encodeURIComponent(login)}/permission`]);
    let perm: string | null = null;
    if (r.code === 0) {
      try {
        const v: unknown = JSON.parse(r.stdout);
        if (isRecord(v) && typeof v["permission"] === "string") perm = v["permission"];
      } catch {
        // not an answer: not trusted
      }
    } else if (!/HTTP 404|Not Found/i.test(r.stderr)) {
      throw new Error(`checking ${login}'s access: ${lastLine(r, "gh api")}`);
    }
    this.perms.set(key, perm);
    return perm;
  }

  /** Auto-merge's last look before it merges: the head's files sorted by
   *  the repo's review rules, as a land would. A head that needs Eric's
   *  approval is held for him, and so is one that cannot be sorted. */
  private async screen(w: PrWatch, s: PrState): Promise<PrWatch> {
    const hold = (why: string): PrWatch => ({ ...w, approve: { head: s.head, why } });
    const rec = this.deps.record(w.id);
    if (!rec) return hold("its branch run's record is gone, so its files cannot be sorted");
    try {
      const review = await (this.deps.sort ?? sortRun)(rec, this.now());
      if (review.head !== s.head) return hold("its worktree is not at the PR's head");
      if (review.verdict !== "approve") return w;
      const files = review.files.filter((f) => f.sensitive).map((f) => f.path);
      return hold(files.length > 0 ? files.join(", ") : (review.why ?? "its review rules"));
    } catch (err) {
      return hold(`its files could not be sorted: ${errText(err)}`);
    }
  }

  /** Merges on the head just read, with the repo's own method; the head
   *  check makes GitHub refuse it if anything was pushed since. */
  private async merge(w: PrWatch, s: PrState): Promise<PrWatch> {
    const settings = await this.gh(["repo", "view", w.slug, "--json", "squashMergeAllowed,mergeCommitAllowed,rebaseMergeAllowed"]);
    let parsed: unknown = null;
    try {
      parsed = settings.code === 0 ? JSON.parse(settings.stdout) : null;
    } catch {
      // the default method
    }
    const method = mergeMethod(parsed);
    const r = await this.gh(["pr", "merge", String(w.number), "-R", w.slug, "--match-head-commit", s.head, `--${method}`]);
    if (r.code !== 0) return { ...w, error: `merging: ${lastLine(r, "gh pr merge")}` };
    // exit 0 may only mean GitHub queued it (a merge queue, or its own
    // auto-merge): clean up once a read says merged
    const after = await this.gh(["pr", "view", String(w.number), "-R", w.slug, "--json", PR_FIELDS]);
    let read: PrState | null = null;
    try {
      read = after.code === 0 ? parsePrView(JSON.parse(after.stdout)) : null;
    } catch {
      // read again on the next poll
    }
    if (read?.status !== "merged") return { ...w, ...(read ? { state: read } : {}), queued: s.head };
    const merged: PrWatch = { ...w, state: read };
    await this.merged(merged);
    return merged;
  }

  /** A merged PR: its remote branch goes, its worktree and local branch go
   *  unless they hold work the PR never got (a fix that ended after the
   *  merge), the main checkout fetches, and the landing record goes. A kept
   *  worktree is then an orphan the landing section offers. The watch stays
   *  for the list. */
  private async merged(w: PrWatch): Promise<void> {
    await git(w.repoPath, ["push", w.remote, "--delete", w.branch]);
    const ahead = await git(w.repoPath, ["rev-list", "--count", `${w.pushed}..refs/heads/${w.branch}`]);
    const dirty = await dirtyFiles(w.dir).catch(() => []);
    const keep = (ahead.code === 0 && Number(ahead.stdout.trim()) > 0) || dirty.length > 0;
    if (!keep) await removeRunTree(w.repoPath, w.dir, w.branch);
    await git(w.repoPath, ["fetch", "--quiet", w.remote], 120_000);
    await this.deps.forget(w.id).catch((err) => console.error(`prs: forgetting ${w.branch}: ${errText(err)}`));
    const { fixing: _f, ...rest } = w;
    const kept = keep ? { error: `merged; ${w.branch} has work the PR never got, so it and ${w.dir} were kept` } : {};
    this.save({ ...rest, ...kept, updatedAt: this.now() });
    this.due.delete(w.id);
    this.prune();
    this.publish();
  }

  /* ---------- routes ---------- */

  async handle(req: Request, url: URL): Promise<Response | null> {
    const path = url.pathname;
    if (!path.startsWith("/api/prs")) return null;
    try {
      if (path === "/api/prs" && req.method === "GET") return json(this.info());
      if (req.method !== "POST") return json({ error: "not found" }, 404);
      const body: unknown = await req.json().catch(() => null);
      if (!isRecord(body)) return json({ error: "malformed body" }, 400);
      const run = body["run"];
      if (typeof run !== "string") return json({ error: "run is required" }, 400);
      if (path === "/api/prs/open") {
        const draft = body["draft"];
        if (draft !== undefined && typeof draft !== "boolean") return json({ error: "draft must be true or false" }, 400);
        return json(await this.open(run, { draft: draft === true }), 201);
      }
      if (path === "/api/prs/set") {
        const change: { autoFix?: boolean; autoMerge?: boolean } = {};
        for (const k of ["autoFix", "autoMerge"] as const) {
          const v = body[k];
          if (v === undefined) continue;
          if (typeof v !== "boolean") return json({ error: `${k} must be true or false` }, 400);
          change[k] = v;
        }
        return json(await this.set(run, change));
      }
      if (path === "/api/prs/close") {
        await this.close(run);
        return json({ ok: true });
      }
      return json({ error: "not found" }, 404);
    } catch (err) {
      const status = (err as { status?: unknown } | null)?.status;
      return json({ error: errText(err) }, typeof status === "number" ? status : 500);
    }
  }
}
