/**
 * Where a renovate or extend seed comes from (spec amendment 6, rulings 1,
 * 2, 3 and 7): an extend's target resolved to one of the user's own GitHub
 * repos, a renovate upstream's license as GitHub reads it, and the rebuild
 * that swaps the notes-only seed scout worked in for a clone of the source.
 * The clone is made in canopy's own process under `.canopy-making`, which no
 * stage reads; the old seed is read only through its bundle and `readSeed`.
 * Bun; every outside call goes through injected deps.
 */
import { appendFile, lstat, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { exec as realExec, type ExecOptions, type ExecResult } from "./exec";
import { commitSeed, dropAgentSettings, dropUpstreamNotes, MAKING_DIR, readSeed, writeSeed } from "./seed";
import { bundleSeed } from "./seedmirror";
import { inQuietSeed } from "./seedgit";
import { NOTE_FILES, extendBranch, githubRepo, githubUrl, isSeedRepoId, urlWithoutSecret, type GithubRepo } from "./sprout";
import { LAUNCH_SOURCE, type Repo, type SproutWork } from "./types";

/** an extend target as canopy resolved it */
export interface ExtendTarget {
  repoId: string;
  /** the https remote canopy clones and pushes through, no userinfo */
  remote: string;
  owner: string;
  name: string;
}

export interface RebuildSpec {
  kind: "renovate" | "extend";
  seedPath: string;
  id: string;
  slug: string;
  /** the https url cloned: the upstream, or the extend target's remote */
  from: string;
  /** an extend's target repo id */
  target?: string;
}

export interface SeedSource {
  /** the user's own repo an extend pick names; throws with the park reason */
  extendTarget(target: string): Promise<ExtendTarget>;
  /** the SPDX id GitHub names for a github.com repo, or null for none or
   *  NOASSERTION; throws for a url off github.com or a failed read */
  upstreamLicense(url: string): Promise<string | null>;
  /** the seed rebuilt from the source in place, and what it was built from */
  rebuild(spec: RebuildSpec): Promise<SproutWork>;
}

export interface SeedSourceDeps {
  exec?: (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>;
  /** the scan's repos now */
  repos: () => readonly Repo[];
  /** canopy's name in its own commits */
  self: string;
  /** the seed as a bundle in `file`; `bundleSeed` unless a test says */
  bundle?: (seedPath: string, file: string) => Promise<{ head: string }>;
  /** where a url is cloned from; the url itself unless a test maps it to a fixture */
  cloneUrl?: (url: string) => string;
  /** runs `f` while the seed is quiet; `inQuietSeed` unless a test says */
  quiet?: <T>(seedPath: string, f: () => Promise<T>) => Promise<T>;
  /** hears of a seed canopy changed (the server syncs its mirror) */
  committed?: (seedPath: string) => void;
  /** GitHub owners besides the gh login whose repos an extend may target
   *  (canopy's config, `extendOwners`); none unless a test says */
  owners?: () => readonly string[] | Promise<readonly string[]>;
  now?: () => number;
}

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const firstLine = (s: string): string => s.trim().split("\n")[0] ?? "";
const tail = (r: ExecResult): string => firstLine(r.stderr || r.stdout).replace(/(https?:\/\/)[^@/\s]+@/gi, "$1").slice(0, 300);

/** where a seed is rebuilt: beside where makeSeed builds one, its own name */
export const reworkPath = (seedPath: string, id: string): string => join(dirname(dirname(seedPath)), MAKING_DIR, `${basename(seedPath)}.${id}.rework`);

/** what an extend seed keeps out of git: every note of canopy's is a plain file there */
export const EXTEND_EXCLUDE = "\n# canopy's incubator notes, never on the branch\n/.canopy/\n";

export function seedSource(deps: SeedSourceDeps): SeedSource {
  const run = deps.exec ?? realExec;
  const quiet = deps.quiet ?? inQuietSeed;
  const bundle = deps.bundle ?? ((seedPath: string, file: string) => bundleSeed(seedPath, file));
  const now = deps.now ?? Date.now;

  /** `gh api repos/<owner>/<name>`, parsed */
  const repoMeta = async (r: GithubRepo): Promise<Record<string, unknown>> => {
    const got = await run(["gh", "api", `repos/${r.owner}/${r.name}`], { timeoutMs: 30_000 });
    if (got.code !== 0) throw new Error(`gh cannot read github.com/${r.owner}/${r.name}: ${tail(got)}`);
    let meta: unknown;
    try {
      meta = JSON.parse(got.stdout);
    } catch {
      meta = null;
    }
    if (!isObj(meta)) throw new Error(`gh answered github.com/${r.owner}/${r.name} with something that is not a repo`);
    return meta;
  };

  /** the gh login's own name on GitHub */
  const ghLogin = async (): Promise<string> => {
    const got = await run(["gh", "api", "user"], { timeoutMs: 30_000 });
    if (got.code !== 0) throw new Error(`gh cannot say who it is logged in as: ${tail(got)}`);
    let user: unknown;
    try {
      user = JSON.parse(got.stdout);
    } catch {
      user = null;
    }
    const login = isObj(user) ? user["login"] : null;
    if (typeof login !== "string" || !login) throw new Error("gh answered with no login");
    return login;
  };

  /** the one repo `target` names: its id, else a folder name exactly one repo has */
  const findRepo = (target: string): Repo => {
    const repos = deps.repos();
    const byId = repos.find((r) => r.id === target);
    if (byId) return byId;
    const named = repos.filter((r) => basename(r.id) === target);
    if (named.length === 1 && named[0]) return named[0];
    if (named.length > 1) throw new Error(`${target} names ${named.length} repos (${named.map((r) => r.id).join(", ")}); an extend names one by its id`);
    throw new Error(`no repo in the workspace is ${target}`);
  };

  return {
    async extendTarget(target) {
      const t = target.trim();
      if (!t) throw new Error("an extend pick names no repo");
      const repo = findRepo(t);
      const id = repo.id;
      if (repo.source !== LAUNCH_SOURCE || repo.host || repo.forge) throw new Error(`${id} is not a repo on this machine's own workspace`);
      if (id === "." || isSeedRepoId(id)) throw new Error(`${id} is not one of your projects`);
      if (id.split("/").some((part) => part.startsWith("."))) throw new Error(`${id} is under a dot folder`);
      const origin = await run(["git", ...NO_HOOKS, "-C", repo.path, "remote", "get-url", "origin"], { timeoutMs: 30_000, env: { GIT_TERMINAL_PROMPT: "0" } });
      if (origin.code !== 0) throw new Error(`${id} has no origin remote, so there is nowhere to push its branch`);
      const gh = githubRepo(origin.stdout.trim());
      if (!gh) throw new Error(`${id}'s origin is not a github.com repo`);
      const meta = await repoMeta(gh);
      if (meta["archived"] === true) throw new Error(`github.com/${gh.owner}/${gh.name} is archived`);
      const perms = meta["permissions"];
      if (!isObj(perms) || perms["push"] !== true) throw new Error(`the gh login cannot push to github.com/${gh.owner}/${gh.name}, so it is not yours to extend`);
      // where GitHub says the repo is now (a rename or a transfer redirects), by its own words
      const ownerLogin = isObj(meta["owner"]) ? meta["owner"]["login"] : null;
      const now = typeof ownerLogin === "string" && typeof meta["name"] === "string" ? githubRepo(`https://github.com/${ownerLogin}/${meta["name"]}`) : null;
      if (!now) throw new Error(`gh answered github.com/${gh.owner}/${gh.name} with no owner and name`);
      // push rights are not ownership: an employer's repo the token can push is not the user's to extend
      const login = await ghLogin();
      const allowed = new Set([login, ...(await (deps.owners?.() ?? []))].map((o) => o.toLowerCase()));
      if (!allowed.has(now.owner.toLowerCase())) {
        throw new Error(`github.com/${now.owner}/${now.name} belongs to ${now.owner}, not the gh login ${login}; add ${now.owner} to extendOwners in canopy's config to extend its repos`);
      }
      return { repoId: id, remote: githubUrl(now), owner: now.owner, name: now.name };
    },

    async upstreamLicense(url) {
      const gh = githubRepo(url);
      if (!gh || !url.startsWith("https://")) throw new Error(`a renovate upstream must be a github.com repo, not ${urlWithoutSecret(url)}`);
      const license = (await repoMeta(gh))["license"];
      const spdx = isObj(license) ? license["spdx_id"] : null;
      return typeof spdx === "string" && spdx.trim() && spdx !== "NOASSERTION" ? spdx.trim() : null;
    },

    async rebuild(spec) {
      const work = reworkPath(spec.seedPath, spec.id);
      const old = `${work}.old`;
      // what a rebuild a restart cut short left behind
      await rm(work, { recursive: true, force: true });
      await rm(old, { recursive: true, force: true });
      await mkdir(dirname(work), { recursive: true });
      const opts = { timeoutMs: 600_000, env: { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" } };
      const git = async (what: string, args: string[]): Promise<string> => {
        const r = await run(["git", ...NO_HOOKS, "-C", work, ...args], opts);
        if (r.code !== 0) throw new Error(`git ${what}: ${tail(r)}`);
        return r.stdout.trim();
      };
      const scratch = await mkdtemp(join(tmpdir(), "canopy-rework-"));
      try {
        const source = deps.cloneUrl ? deps.cloneUrl(spec.from) : spec.from;
        const cloned = await run(["git", ...NO_HOOKS, "clone", "--quiet", "--", source, work], opts);
        if (cloned.code !== 0) throw new Error(`git clone of ${urlWithoutSecret(spec.from)} failed: ${tail(cloned).split(source).join(urlWithoutSecret(spec.from))}`);
        const base = await git("rev-parse", ["rev-parse", "--verify", "HEAD^{commit}"]);
        const branch = extendBranch(spec.slug);
        if (spec.kind === "extend") {
          const tracked = await git("ls-files", ["--literal-pathspecs", "ls-files", "--", ...NOTE_FILES]);
          if (tracked) throw new Error(`the target already tracks ${firstLine(tracked)}, where canopy keeps its notes`);
          const was = await git("symbolic-ref", ["symbolic-ref", "--short", "HEAD"]);
          await git("checkout", ["checkout", "-q", "-b", branch]);
          await git("branch", ["branch", "-q", "-D", was]);
          // no origin: a stage's push has nowhere to go (amendment 2, ruling 12)
          await git("remote", ["remote", "remove", "origin"]);
          await mkdir(join(work, ".git", "info"), { recursive: true });
          await appendFile(join(work, ".git", "info", "exclude"), EXTEND_EXCLUDE);
        } else {
          await git("remote", ["remote", "rename", "origin", "upstream"]);
          await git("remote", ["remote", "set-url", "upstream", urlWithoutSecret(spec.from)]);
          await dropAgentSettings(work, deps.self);
          await dropUpstreamNotes(work, deps.self);
        }
        // the notes-only seed's history, from its bundle, never its path
        const file = join(scratch, "seed.bundle");
        const { head } = await bundle(spec.seedPath, file);
        await git("fetch", ["fetch", "-q", "--no-tags", "--", file, `${head}:refs/heads/incubator/notes`]);
        const notes: string[] = [];
        for (const rel of NOTE_FILES) {
          const text = await readSeed(spec.seedPath, rel);
          if (text === null) continue;
          await writeSeed(work, rel, text);
          notes.push(rel);
        }
        if (spec.kind === "renovate") await commitSeed(work, notes, "seed: the incubator's notes", deps.self);
        await quiet(spec.seedPath, async () => {
          // a rename onto what is there would fail or nest, so the seed steps aside first
          await rename(spec.seedPath, old);
          try {
            await rename(work, spec.seedPath);
          } catch (e) {
            await rename(old, spec.seedPath);
            throw e;
          }
        });
        await rm(old, { recursive: true, force: true });
        deps.committed?.(spec.seedPath);
        const at = now();
        if (spec.kind === "renovate") return { kind: "renovate", from: urlWithoutSecret(spec.from), base, at };
        return { kind: "extend", from: spec.from, base, target: spec.target ?? "", remote: spec.from, branch, at };
      } catch (e) {
        // the old seed stands as it was; nothing half-made is left
        if (await lstat(work).catch(() => null)) await rm(work, { recursive: true, force: true });
        throw e;
      } finally {
        await rm(scratch, { recursive: true, force: true });
      }
    },
  };
}
