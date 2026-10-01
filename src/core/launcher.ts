/** The launcher, Bun-only: a repo's released builds downloaded and unpacked
 *  under the config dir, its pull requests checked out as worktrees and
 *  built, the repo's own checkout built, and any of them launched here, with
 *  a count of launches per build. Releases and pull requests come from
 *  GitHub through `gh`, so its login and rate limits apply. The pure parts
 *  (what to pick, what to run) are in launch.ts. */

import { chmod, copyFile, link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { isGitHub, listRemotes, parseRemote } from "./access";
import { exec, git, KILL_GRACE } from "./exec";
import { parseLocator } from "./host";
import {
  buildKey,
  fillLaunch,
  fmtBytes,
  isSafeAssetName,
  isSafeTag,
  launchTarget,
  parseBuildKey,
  parsePulls,
  parseReleases,
  pickAsset,
  unpackKind,
  type BuildRef,
  type LaunchTarget,
  type Platform,
} from "./launch";
import { userShell } from "./openers";
import { configDir } from "./store";
import {
  JOB_TAIL,
  type Build,
  type BuildChange,
  type Job,
  type JobKind,
  type LaunchSettings,
  type Pull,
  type Release,
  type Repo,
} from "./types";

/** A refusal with the HTTP status the server should answer with. */
export class LauncherError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

/** The repo fields the launcher reads. The CLI builds one of these from a
 *  path; the server hands over the scanned card. */
export type LaunchRepo = Pick<Repo, "id" | "name" | "path" | "host" | "remotes">;

export interface LauncherHooks {
  onJob: (job: Job) => void;
  onJobGone: (id: string) => void;
  /** a repo's builds changed outside a job: a launch, an exit, a removal */
  onBuilds: (repoId: string, what: BuildChange, build: string) => void;
}

/* ---------- this machine, and where builds live ---------- */

export function thisPlatform(): Platform {
  const os = process.platform === "darwin" || process.platform === "linux" || process.platform === "win32" ? process.platform : "other";
  const arch = process.arch === "arm64" || process.arch === "x64" ? process.arch : "other";
  return { os, arch };
}

export const buildsRoot = (): string => join(configDir(), "builds");

const SAFE_SEG = /^[\w.-]{1,100}$/;

/** `owner/name` of the repo's GitHub remote, and the remote's name for a
 *  fetch, or null when no remote is on GitHub. */
export async function githubRemote(repo: LaunchRepo): Promise<{ remote: string; slug: string } | null> {
  const remotes = await listRemotes(repo.path);
  for (const r of remotes) {
    const ref = parseRemote(r.url);
    if (ref && isGitHub(ref.host) && SAFE_SEG.test(ref.owner) && SAFE_SEG.test(ref.name)) {
      return { remote: r.name, slug: `${ref.owner}/${ref.name}` };
    }
  }
  return null;
}

/** Where a repo's builds go: by GitHub slug when it has one, so two clones
 *  of the same project share their installed releases; else by the repo's
 *  name and a hash of its path. */
async function repoDir(repo: LaunchRepo): Promise<string> {
  const gh = await githubRemote(repo);
  if (gh) return join(buildsRoot(), ...gh.slug.split("/"));
  const hash = createHash("sha1").update(repo.path).digest("hex").slice(0, 8);
  return join(buildsRoot(), "_local", `${basename(parseLocator(repo.path).path) || "repo"}-${hash}`);
}

/* ---------- what the repo dir remembers ---------- */

interface BuildRecord {
  at: number;
  asset?: string;
  target?: LaunchTarget;
  head?: string;
}

interface RepoState {
  builds: Record<string, BuildRecord>;
  launches: Record<string, { count: number; last: number }>;
}

const statePath = (dir: string): string => join(dir, "state.json");

async function readState(dir: string): Promise<RepoState> {
  try {
    const raw = JSON.parse(await readFile(statePath(dir), "utf8")) as Partial<RepoState>;
    return {
      builds: raw.builds && typeof raw.builds === "object" ? raw.builds : {},
      launches: raw.launches && typeof raw.launches === "object" ? raw.launches : {},
    };
  } catch {
    return { builds: {}, launches: {} };
  }
}

let stateQueue: Promise<unknown> = Promise.resolve();
/** Read-modify-write, one at a time, written through a rename. */
function withState<T>(dir: string, fn: (s: RepoState) => T): Promise<T> {
  const run = stateQueue.then(async () => {
    await mkdir(dir, { recursive: true });
    const s = await readState(dir);
    const out = fn(s);
    const tmp = `${statePath(dir)}.tmp-${process.pid}`;
    await writeFile(tmp, JSON.stringify(s, null, 2) + "\n");
    await rename(tmp, statePath(dir));
    return out;
  });
  stateQueue = run.catch(() => {});
  return run;
}

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
};

/* ---------- gh ---------- */

async function ghApi(path: string): Promise<unknown> {
  const r = await exec(["gh", "api", path], { timeoutMs: 30_000 });
  if (r.code === 127 || /command not found|No such file/i.test(r.stderr)) {
    throw new LauncherError("gh is not installed; releases and pull requests are read through it", 503);
  }
  if (r.code !== 0) {
    let msg = r.stderr.trim();
    try {
      const body = JSON.parse(r.stdout) as { message?: unknown };
      if (typeof body.message === "string") msg = body.message;
    } catch {
      // gh printed no JSON; its stderr is the message
    }
    throw new LauncherError(msg || `gh api ${path} failed`, msg.includes("Not Found") ? 404 : 502);
  }
  try {
    return JSON.parse(r.stdout) as unknown;
  } catch {
    throw new LauncherError("gh answered with something that is not JSON", 502);
  }
}

let token: Promise<string | null> | null = null;
/** The gh login's token, once; null when gh is missing or logged out. */
function ghToken(): Promise<string | null> {
  if (token === null) {
    token = exec(["gh", "auth", "token"], { timeoutMs: 10_000 }).then((r) =>
      r.code === 0 && r.stdout.trim() ? r.stdout.trim() : null,
    );
  }
  return token;
}

/* ---------- the class ---------- */

interface LiveJob {
  job: Job;
  proc: Bun.Subprocess | null;
  abort: AbortController;
  timer: ReturnType<typeof setTimeout> | null;
}

interface Launched {
  proc: Bun.Subprocess;
  at: number;
  /** the bundle an `open -W` is waiting on; `stopLaunch` quits it by path */
  app?: string;
}

export class Launcher {
  private jobs = new Map<string, LiveJob>();
  /** processes started from a build, by `<repo path>|<build key>` */
  private running = new Map<string, Launched>();
  /** launches awaiting the bounded SIGKILL after their TERM grace period */
  private terminating = new Set<Bun.Subprocess>();

  constructor(private hooks: LauncherHooks) {}

  list(): Job[] {
    return [...this.jobs.values()].map((l) => l.job);
  }

  get(id: string): Job | undefined {
    return this.jobs.get(id)?.job;
  }

  /* ----- reading ----- */

  async releases(repo: LaunchRepo, settings: LaunchSettings): Promise<Release[]> {
    const gh = await githubRemote(repo);
    if (!gh) throw new LauncherError(`${repo.name} has no GitHub remote to read releases from`, 400);
    const body = await ghApi(`repos/${gh.slug}/releases?per_page=30`);
    const platform = thisPlatform();
    return parseReleases(body).map((r) => ({
      ...r,
      pick: pickAsset(
        r.assets.map((a) => a.name),
        platform,
        settings.asset,
      ),
    }));
  }

  async pulls(repo: LaunchRepo): Promise<Pull[]> {
    const gh = await githubRemote(repo);
    if (!gh) throw new LauncherError(`${repo.name} has no GitHub remote to read pull requests from`, 400);
    return parsePulls(await ghApi(`repos/${gh.slug}/pulls?state=open&per_page=50`));
  }

  /** Every build the repo has here, installed releases first, then pull
   *  requests, then the checkout itself when a line says how to run it. */
  async builds(repo: LaunchRepo, settings: LaunchSettings): Promise<Build[]> {
    const dir = await repoDir(repo);
    const state = await readState(dir);
    const out: Build[] = [];
    const stats = (key: string) => {
      const l = state.launches[key];
      return { launches: l?.count ?? 0, lastLaunch: l?.last ?? null };
    };
    for (const [key, rec] of Object.entries(state.builds)) {
      const ref = parseBuildKey(key);
      if (!ref || ref.kind === "local") continue;
      const where = ref.kind === "release" ? join(dir, "release", ref.tag) : join(dir, "pr", String(ref.number));
      if (!(await exists(where))) continue;
      out.push({
        key,
        kind: ref.kind,
        label: ref.kind === "release" ? ref.tag : `PR #${ref.number}`,
        dir: where,
        what: ref.kind === "release" ? releaseLine(where, rec, settings) : settings.run || null,
        at: rec.at,
        ...stats(key),
        running: this.running.has(runKey(repo, key)),
        ...(rec.head ? { head: rec.head } : {}),
      });
    }
    out.sort((a, b) => (a.kind === b.kind ? b.at - a.at : a.kind === "release" ? -1 : 1));
    if ((settings.run || settings.build) && !repo.host) {
      out.push({
        key: "local",
        kind: "local",
        label: "this checkout",
        dir: repo.path,
        what: settings.run || null,
        at: state.builds["local"]?.at ?? 0,
        ...stats("local"),
        running: this.running.has(runKey(repo, "local")),
      });
    }
    return out;
  }

  /* ----- jobs: install and build ----- */

  /** Downloads one release's asset for this machine and unpacks it. */
  async install(repo: LaunchRepo, tag: string, asset: string | null, settings: LaunchSettings): Promise<Job> {
    if (!isSafeTag(tag)) throw new LauncherError(`not a tag canopy can install: ${tag}`, 400);
    const gh = await githubRemote(repo);
    if (!gh) throw new LauncherError(`${repo.name} has no GitHub remote to install releases from`, 400);
    const key = buildKey({ kind: "release", tag });
    this.refuseBusy(repo, key);
    const rel = parseReleases([await ghApi(`repos/${gh.slug}/releases/tags/${encodeURIComponent(tag)}`)])[0];
    if (!rel) throw new LauncherError(`no release tagged ${tag}`, 404);
    const name = asset ?? pickAsset(rel.assets.map((a) => a.name), thisPlatform(), settings.asset);
    const chosen = rel.assets.find((a) => a.name === name);
    if (!name || !chosen) {
      throw new LauncherError(
        name ? `${tag} has no asset named ${name}` : `${tag} has no asset for this machine; set an asset glob in the launch settings`,
        400,
      );
    }
    if (!isSafeAssetName(chosen.name)) throw new LauncherError(`odd asset name: ${chosen.name}`, 400);
    const base = await repoDir(repo);
    const releaseRoot = join(base, "release");
    const dir = join(releaseRoot, tag);
    const live = this.open(repo, "install", key, `install ${tag}`);
    void this.guard(live, async () => {
      const stage = join(releaseRoot, `.${tag}.install-${live.job.id}`);
      const backup = join(releaseRoot, `.${tag}.previous-${live.job.id}`);
      let hadPrevious = false;
      let swapped = false;
      try {
        await mkdir(releaseRoot, { recursive: true });
        await rm(stage, { recursive: true, force: true });
        await mkdir(stage, { recursive: true });
        this.say(live, `downloading ${chosen.name}${chosen.size ? ` (${fmtBytes(chosen.size)})` : ""}`);
        const file = join(stage, chosen.name);
        await this.download(live, chosen.url, chosen.apiUrl, file, chosen.size);
        const target = await unpack(stage, chosen.name, (l) => this.say(live, l), live.abort.signal);
        this.say(live, target ? `ready: ${target.name}` : "unpacked, but nothing in it looks launchable");
        live.abort.signal.throwIfAborted();

        if (await exists(dir)) {
          await rm(backup, { recursive: true, force: true });
          await rename(dir, backup);
          hadPrevious = true;
        }
        try {
          await rename(stage, dir);
          swapped = true;
        } catch (err) {
          if (hadPrevious) await rename(backup, dir).catch(() => {});
          throw err;
        }

        try {
          live.abort.signal.throwIfAborted();
          await withState(base, (s) => {
            s.builds[key] = { at: Date.now(), asset: chosen.name, ...(target ? { target } : {}) };
          });
        } catch (err) {
          await rm(dir, { recursive: true, force: true });
          if (hadPrevious) await rename(backup, dir).catch(() => {});
          throw err;
        }
        if (hadPrevious) await rm(backup, { recursive: true, force: true }).catch(() => {});
      } finally {
        await rm(stage, { recursive: true, force: true });
        // If a failure happened after the swap and rollback above could not
        // run, leave the prior directory available for recovery.
        if (!swapped && hadPrevious && (await exists(backup)) && !(await exists(dir))) {
          await rename(backup, dir).catch(() => {});
        }
      }
    });
    return live.job;
  }

  /** Checks a pull request out as a worktree (or refreshes it) and runs the
   *  build line there; or runs the build line in the checkout itself. */
  async build(repo: LaunchRepo, ref: BuildRef, settings: LaunchSettings): Promise<Job> {
    if (repo.host) throw new LauncherError(`builds run on this machine only; ${repo.name} is on ${repo.host}`, 400);
    if (ref.kind === "release") throw new LauncherError("a release is installed, not built", 400);
    const key = buildKey(ref);
    this.refuseBusy(repo, key);
    if (ref.kind === "local" && !settings.build) {
      throw new LauncherError("set a build line in the launch settings first", 400);
    }
    const base = await repoDir(repo);
    const title = ref.kind === "pr" ? `build PR #${ref.number}` : "build this checkout";
    const gh = ref.kind === "pr" ? await githubRemote(repo) : null;
    if (ref.kind === "pr" && !gh) throw new LauncherError(`${repo.name} has no GitHub remote to fetch a pull request from`, 400);
    const live = this.open(repo, "build", key, title);
    void this.guard(live, async () => {
      let dir = repo.path;
      let head: string | undefined;
      if (ref.kind === "pr" && gh) {
        dir = join(base, "pr", String(ref.number));
        this.say(live, `$ git fetch ${gh.remote} pull/${ref.number}/head`);
        const f = await git(repo.path, ["fetch", gh.remote, `pull/${ref.number}/head`], 120_000);
        this.say(live, (f.stderr + f.stdout).trim());
        if (f.code !== 0) throw new Error(`fetch failed (${f.code})`);
        const rev = await git(repo.path, ["rev-parse", "FETCH_HEAD"]);
        if (rev.code !== 0) throw new Error("could not resolve FETCH_HEAD");
        head = rev.stdout.trim();
        if (await exists(join(dir, ".git"))) {
          this.say(live, `$ git checkout --detach ${head.slice(0, 10)} (in the worktree)`);
          const co = await git(dir, ["checkout", "--detach", head]);
          if (co.code !== 0) throw new Error(co.stderr.trim() || "checkout failed");
        } else {
          await rm(dir, { recursive: true, force: true });
          await mkdir(join(base, "pr"), { recursive: true });
          await git(repo.path, ["worktree", "prune"]);
          this.say(live, `$ git worktree add --detach ${dir} ${head.slice(0, 10)}`);
          const wt = await git(repo.path, ["worktree", "add", "--detach", dir, head], 120_000);
          if (wt.code !== 0) throw new Error(wt.stderr.trim() || "worktree add failed");
        }
      }
      if (settings.build) {
        this.say(live, `$ ${settings.build}`);
        const code = await this.shell(live, settings.build, dir);
        if (code !== 0) throw new Error(`build exited ${code}`);
      } else {
        this.say(live, "no build line set; the checkout is ready as fetched");
      }
      await withState(base, (s) => {
        s.builds[key] = { at: Date.now(), ...(head ? { head } : {}) };
      });
    });
    return live.job;
  }

  stop(id: string): Job {
    const live = this.jobs.get(id);
    if (!live) throw new LauncherError("no such job", 404);
    if (live.job.status === "working") {
      live.job.status = "stopped";
      live.abort.abort();
      live.proc?.kill();
      this.end(live);
    }
    return live.job;
  }

  dismiss(id: string): void {
    const live = this.jobs.get(id);
    if (!live) return;
    if (live.job.status === "working") this.stop(id);
    this.jobs.delete(id);
    this.hooks.onJobGone(id);
  }

  /* ----- launching ----- */

  /** Starts the build; a process canopy can follow is kept, and counted. */
  async launch(repo: LaunchRepo, key: string, settings: LaunchSettings): Promise<Build> {
    const ref = parseBuildKey(key);
    if (!ref) throw new LauncherError(`not a build: ${key}`, 400);
    const build = (await this.builds(repo, settings)).find((b) => b.key === key);
    if (!build) throw new LauncherError(`${repo.name} has no build ${key}`, 404);
    if (build.running) throw new LauncherError(`${build.label} is already running`, 409);
    const base = await repoDir(repo);
    const rec = (await readState(base)).builds[key];
    const logs = join(base, "logs");
    await mkdir(logs, { recursive: true });
    const log = join(logs, `${key.replace(/[^\w.-]/g, "_")}.log`);
    const shell = userShell();
    const rk = runKey(repo, key);
    const track = (proc: Bun.Subprocess, app?: string) => {
      this.running.set(rk, { proc, at: Date.now(), ...(app ? { app } : {}) });
      void proc.exited.then(() => {
        if (this.running.get(rk)?.proc === proc) {
          this.running.delete(rk);
          this.hooks.onBuilds(repo.id, "exited", key);
        }
      });
    };
    const spawn = (cmd: string[], cwd: string) => {
      const proc = Bun.spawn(cmd, {
        cwd,
        detached: true,
        stdin: "ignore",
        stdout: Bun.file(log),
        stderr: Bun.file(log),
        env: { ...process.env, CANOPY_BUILD: key, CANOPY_REPO: repo.path },
      });
      track(proc);
    };
    if (ref.kind === "release") {
      const file = rec?.target ? join(build.dir, rec.target.name) : rec?.asset ? join(build.dir, rec.asset) : null;
      if (!file) throw new LauncherError(`nothing in ${build.label} looks launchable`, 400);
      if (settings.launch) {
        spawn([shell, "-l", "-c", fillLaunch(settings.launch, file)], build.dir);
      } else if (rec?.target?.kind === "bin") {
        spawn([file], build.dir);
      } else if (rec?.target?.kind === "app") {
        // `open -W` stays until the app quits, which is what makes the app
        // show as running; the app itself is a child of launchd, not of
        // this process, so stopping it goes by its executable's path
        // the live env, as every spawn here: without one Bun hands the
        // child the env this process started with, whatever canopy has
        // taken out of it since (an old deploy's answer token, an outer
        // canopy shell's names)
        const proc = Bun.spawn(["open", "-n", "-W", file], { stdin: "ignore", stdout: Bun.file(log), stderr: Bun.file(log), env: { ...process.env } });
        track(proc, file);
      } else {
        // something only `open` knows what to do with: a package, a jar
        const r = await exec(["open", file], { timeoutMs: 15_000 });
        if (r.code !== 0) throw new LauncherError(r.stderr.trim() || `could not open ${basename(file)}`, 500);
      }
    } else {
      if (!settings.run) throw new LauncherError("set a run line in the launch settings first", 400);
      spawn([shell, "-l", "-c", settings.run], build.dir);
    }
    await withState(base, (s) => {
      const l = s.launches[key] ?? { count: 0, last: 0 };
      s.launches[key] = { count: l.count + 1, last: Date.now() };
    });
    this.hooks.onBuilds(repo.id, "launched", key);
    const after = (await this.builds(repo, settings)).find((b) => b.key === key);
    return after ?? build;
  }

  /** Ends a process a launch started, when canopy still holds it. An app
   *  bundle is quit through its executable's path, which is unique under
   *  the builds dir; the `open -W` waiting on it then ends by itself. */
  stopLaunch(repo: LaunchRepo, key: string): boolean {
    const live = this.running.get(runKey(repo, key));
    if (!live) return false;
    if (live.app) {
      // not anchored: a script-backed app runs as `/bin/sh <exe>`
      const exe = join(live.app, "Contents", "MacOS") + "/";
      void exec(["pkill", "-f", exe.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")], { timeoutMs: 5_000 }).then((r) => {
        // found and signalled: the `open -W` ends when the app does. Found
        // nothing: it never started or is gone already, so drop the wait
        if (r.code !== 0 && this.running.get(runKey(repo, key)) === live) live.proc.kill();
      });
    } else {
      this.stopProcessGroup(live.proc);
    }
    return true;
  }

  /** Removes an installed release or a pull request's worktree. */
  async remove(repo: LaunchRepo, key: string): Promise<void> {
    const ref = parseBuildKey(key);
    if (!ref) throw new LauncherError(`not a build: ${key}`, 400);
    if (ref.kind === "local") throw new LauncherError("the checkout itself is not canopy's to remove", 400);
    this.refuseBusy(repo, key);
    this.stopLaunch(repo, key);
    const base = await repoDir(repo);
    if (ref.kind === "pr") {
      const dir = join(base, "pr", String(ref.number));
      const r = await git(repo.path, ["worktree", "remove", "--force", dir], 60_000);
      if (r.code !== 0) await rm(dir, { recursive: true, force: true });
      await git(repo.path, ["worktree", "prune"]);
    } else {
      await rm(join(base, "release", ref.tag), { recursive: true, force: true });
    }
    await withState(base, (s) => {
      delete s.builds[key];
      delete s.launches[key];
    });
    this.hooks.onBuilds(repo.id, "removed", key);
  }

  /** Ends every launched process; the server calls this on stop. */
  shutdown(): void {
    for (const l of this.jobs.values()) if (l.job.status === "working") this.stop(l.job.id);
    for (const r of this.running.values()) {
      // `open -W` waits on an app launched by Launch Services; killing its
      // waiter is the existing shutdown behavior, while shell launches own
      // their children through a process group.
      if (r.app) r.proc.kill();
      else this.stopProcessGroup(r.proc);
    }
    this.running.clear();
  }

  /* ----- the plumbing ----- */

  private refuseBusy(repo: LaunchRepo, key: string): void {
    for (const l of this.jobs.values()) {
      if (l.job.repoId === repo.id && l.job.build === key && l.job.status === "working") {
        throw new LauncherError(`${l.job.title} is already going`, 409);
      }
    }
  }

  /** Stop a shell's group, then escalate if a child ignores TERM. The
   * subprocess object remains the owner of the delayed kill even after the
   * shell itself exits; a different tracked process with a reused pid cancels
   * the escalation. */
  private stopProcessGroup(proc: Bun.Subprocess): void {
    if (this.terminating.has(proc)) return;
    this.terminating.add(proc);
    signalProcessGroup(proc, "SIGTERM");
    setTimeout(() => {
      if (!this.terminating.delete(proc)) return;
      const reused = [...this.running.values()].some((r) => r.proc !== proc && r.proc.pid === proc.pid);
      if (!reused) signalProcessGroup(proc, "SIGKILL");
    }, KILL_GRACE);
  }

  private open(repo: LaunchRepo, kind: JobKind, build: string, title: string): LiveJob {
    const job: Job = {
      id: crypto.randomUUID().slice(0, 8),
      repoId: repo.id,
      kind,
      build,
      title,
      status: "working",
      startedAt: Date.now(),
      lines: [],
    };
    const live: LiveJob = { job, proc: null, abort: new AbortController(), timer: null };
    this.jobs.set(job.id, live);
    this.hooks.onJob(job);
    return live;
  }

  private async guard(live: LiveJob, work: () => Promise<void>): Promise<void> {
    try {
      await work();
      if (live.job.status === "working") live.job.status = "done";
    } catch (err) {
      if (live.job.status === "working") {
        live.job.status = "failed";
        live.job.error = String(err instanceof Error ? err.message : err);
        this.say(live, `✗ ${live.job.error}`);
      }
    }
    this.end(live);
  }

  private end(live: LiveJob): void {
    live.job.endedAt = Date.now();
    if (live.timer) clearTimeout(live.timer);
    live.timer = null;
    this.hooks.onJob(live.job);
    if (live.job.status === "done") this.hooks.onBuilds(live.job.repoId, live.job.kind === "install" ? "installed" : "built", live.job.build);
  }

  /** A line of output, kept to the tail, broadcast a little later so a
   *  chatty build does not send one event per line. */
  private say(live: LiveJob, text: string): void {
    for (const line of text.split("\n")) {
      if (line.trim() === "") continue;
      live.job.lines.push(line);
    }
    if (live.job.lines.length > JOB_TAIL) live.job.lines.splice(0, live.job.lines.length - JOB_TAIL);
    this.schedule(live);
  }

  private schedule(live: LiveJob): void {
    if (live.timer) return;
    live.timer = setTimeout(() => {
      live.timer = null;
      if (live.job.status === "working") this.hooks.onJob(live.job);
    }, 150);
  }

  private async shell(live: LiveJob, line: string, cwd: string): Promise<number> {
    const proc = Bun.spawn([userShell(), "-l", "-c", line], {
      cwd,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, CANOPY_BUILD: live.job.build },
    });
    live.proc = proc;
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const dec = new TextDecoder();
      let buf = "";
      for await (const chunk of stream) {
        buf += dec.decode(chunk, { stream: true });
        let nl = buf.indexOf("\n");
        while (nl !== -1) {
          this.say(live, buf.slice(0, nl).replace(/\r$/, ""));
          buf = buf.slice(nl + 1);
          nl = buf.indexOf("\n");
        }
      }
      if (buf.trim()) this.say(live, buf);
    };
    const [, , code] = await Promise.all([read(proc.stdout), read(proc.stderr), proc.exited]);
    live.proc = null;
    return code;
  }

  private async download(live: LiveJob, url: string, apiUrl: string, file: string, size: number): Promise<void> {
    const tok = await ghToken();
    // The API address answers private repos too, given the token, and sends
    // a redirect to storage that must not see that token.
    let res: Response;
    if (tok && apiUrl) {
      const first = await fetch(apiUrl, {
        headers: { Accept: "application/octet-stream", Authorization: `Bearer ${tok}` },
        redirect: "manual",
        signal: live.abort.signal,
      });
      const to = first.headers.get("location");
      res = first.status >= 300 && first.status < 400 && to ? await fetch(to, { signal: live.abort.signal }) : first;
    } else {
      res = await fetch(url, { signal: live.abort.signal });
    }
    if (!res.ok || !res.body) throw new Error(`download failed: ${res.status} ${res.statusText}`);
    const total = Number(res.headers.get("content-length")) || size || 0;
    const tmp = `${file}.part`;
    const sink = Bun.file(tmp).writer();
    let done = 0;
    let lastSaid = 0;
    live.job.progress = { done, total };
    try {
      for await (const chunk of res.body) {
        sink.write(chunk);
        done += chunk.byteLength;
        live.job.progress = { done, total };
        if (done - lastSaid > 8 * 1024 * 1024) {
          lastSaid = done;
          this.schedule(live);
        }
      }
      await sink.end();
    } catch (err) {
      try {
        await sink.end();
      } catch {
        // the sink is already closed; the part file goes either way
      }
      await rm(tmp, { force: true });
      throw err;
    }
    await rename(tmp, file);
    this.say(live, `downloaded ${fmtBytes(done)}`);
  }
}

const runKey = (repo: LaunchRepo, key: string): string => `${repo.path}|${key}`;

/** Signal a launch and everything its shell started. Detached POSIX children
 *  are session leaders, so their pid is also the process-group id. */
function signalProcessGroup(proc: Bun.Subprocess, signal: "SIGTERM" | "SIGKILL"): void {
  if (process.platform !== "win32") {
    try {
      process.kill(-proc.pid, signal);
      return;
    } catch {
      // The group may have exited between the lookup and the signal.
    }
  }
  try {
    proc.kill(signal);
  } catch {
    // already gone
  }
}

/** What launching a release runs, as one line for the list. */
function releaseLine(dir: string, rec: BuildRecord, settings: LaunchSettings): string | null {
  const file = rec.target ? join(dir, rec.target.name) : rec.asset ? join(dir, rec.asset) : null;
  if (!file) return null;
  if (settings.launch) return fillLaunch(settings.launch, file);
  if (rec.target?.kind === "bin") return file;
  return `open${rec.target?.kind === "app" ? " -n" : ""} ${basename(file)}`;
}

/** Opens the download up in place: a disk image's apps copied out, an
 *  archive extracted, a bare binary made executable. Returns what to run.
 *  Exported for the tests, which feed it a stub app in each wrapping. */
export async function unpack(
  dir: string,
  asset: string,
  say: (line: string) => void,
  signal: AbortSignal = new AbortController().signal,
): Promise<LaunchTarget | null> {
  const file = join(dir, asset);
  const kind = unpackKind(asset);
  const run = async (cmd: string[], what: string) => {
    if (signal.aborted) throw new Error("stopped");
    const r = await exec(cmd, { timeoutMs: 600_000 });
    if (r.code !== 0) throw new Error(`${what} failed: ${r.stderr.trim() || r.code}`);
    return r;
  };
  if (kind === "dmg") {
    say("mounting the disk image");
    // The image is attached through a hard link without its .dmg extension.
    // This is canopy's own download being unpacked, not a disk image the
    // user opened, and the helpers that offer to install whatever a fresh
    // mount holds (Vorssaint's disk image installer, for one) see the mount
    // even with -nobrowse and go by the .dmg name of the image behind it.
    const image = join(dir, `${basename(asset, extname(asset))}.image`);
    await rm(image, { force: true });
    await link(file, image).catch(() => copyFile(file, image));
    const mount = await mkdtemp(join(tmpdir(), "canopy-dmg-"));
    try {
      // -noverify: the checksum pass reads the whole image a second time, and
      // this one just came down over https
      const attach = (extra: string[]) =>
        run(["hdiutil", "attach", "-nobrowse", "-readonly", "-noverify", "-noautoopen", ...extra, "-mountpoint", mount, image], "hdiutil attach");
      try {
        await attach([]);
      } catch (e) {
        // a raw image, no UDIF wrapper: hdiutil tells one apart by its
        // extension alone, so without one it has to be told
        if (!/not recognized/.test(String(e))) throw e;
        await attach(["-imagekey", "diskimage-class=CRawDiskImage"]);
      }
      const names = (await readdir(mount)).filter((n) => /\.(app|pkg)$/i.test(n));
      if (names.length === 0) throw new Error("the disk image holds no .app or .pkg");
      for (const n of names) {
        say(`copying ${n}`);
        await run(["cp", "-R", join(mount, n), join(dir, n)], "copy");
      }
    } finally {
      // a detach of what never mounted just fails, quietly
      await exec(["hdiutil", "detach", mount, "-force"], { timeoutMs: 60_000 });
      await rm(mount, { recursive: true, force: true });
      await rm(image, { force: true });
    }
    await rm(file, { force: true });
  } else if (kind === "zip") {
    say("unzipping");
    await run(
      process.platform === "darwin" ? ["ditto", "-x", "-k", file, dir] : ["unzip", "-q", "-o", file, "-d", dir],
      "unzip",
    );
    await rm(file, { force: true });
  } else if (kind === "tar") {
    say("extracting");
    await run(["tar", "-xf", file, "-C", dir], "tar");
    await rm(file, { force: true });
  }
  // what Finder's zips carry beside the payload
  await rm(join(dir, "__MACOSX"), { recursive: true, force: true });
  await flattenOne(dir);
  // files, and app bundles, which are folders: a plain folder is never the
  // thing to run, and a name-only pick would take one for a binary
  const entries: string[] = [];
  for (const n of await readdir(dir)) {
    if (n.startsWith(".") || n.endsWith(".part")) continue;
    const st = await stat(join(dir, n)).catch(() => null);
    if (st && (!st.isDirectory() || /\.app$/i.test(n))) entries.push(n);
  }
  const target = launchTarget(entries, asset);
  if (target?.kind === "bin") await chmod(join(dir, target.name), 0o755).catch(() => {});
  return target;
}

/** An archive that unpacks to one folder gets that folder's contents lifted
 *  up, so `tool-1.0/tool` is found as `tool`. */
async function flattenOne(dir: string): Promise<void> {
  const entries = (await readdir(dir)).filter((n) => !n.startsWith("."));
  if (entries.length !== 1 || entries[0] === undefined) return;
  const only = join(dir, entries[0]);
  const st = await stat(only).catch(() => null);
  if (!st?.isDirectory() || only.toLowerCase().endsWith(".app")) return;
  for (const n of await readdir(only)) await rename(join(only, n), join(dir, n));
  await rm(only, { recursive: true, force: true });
}
