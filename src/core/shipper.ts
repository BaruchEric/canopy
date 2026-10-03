/**
 * The incubator's deploy, carried out by canopy and not by an agent (spec
 * amendment 2): the private GitHub repo, the push, the Vercel link and
 * deploy, and a smoke GET of the production url. Bun-only; every outside
 * call goes through injected deps so the tests drive it with fakes.
 */
import {
  deployReady,
  deploymentUrl,
  frameworkOf,
  isVercelAppUrl,
  productionUrl,
  repoCandidates,
  servesFile,
  smokeRefusal,
  strangeAliases,
  vercelArgs,
  vercelConfigRefusal,
  vercelProject,
  withCanopyIgnored,
} from "./deploy";
import { lstat, mkdtemp, readdir, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec, type ExecOptions, type ExecResult } from "./exec";
import { firebaseConfigRefusal, firebaseEnv, firebaseFiles, firebaseResult, sdkConfigOf } from "./firebase";
import { readSeed, writeSeed } from "./seed";
import { bundleSeed } from "./seedmirror";
import { NOTE_FILES, branchPushRefusal, extendBranch, githubRepo } from "./sprout";
import type { HostId } from "./types";

export interface Shipper {
  /** null when the host can be deployed to from here, else the park reason */
  ready(host: HostId): string | null;
  /** a new private repo under the gh login, "owner/name" */
  createRepo(slug: string, description: string): Promise<string>;
  /** a Vercel project of its own, made under a name the account did not
   *  have, with the framework the seed's package.json makes clear */
  project(slug: string, seedPath: string): Promise<string>;
  /** a bundle of the seed in a scratch folder canopy owns, and its HEAD
   *  commit; `done` removes it. One ship makes one, so the push and the
   *  deploy send the same commit. */
  bundle(seedPath: string): Promise<ShipBundle>;
  /** the bundle's HEAD pushed to main from a fresh bare clone of it, hooks
   *  off; a seed path is bundled first */
  push(from: ShipSource, repo: string): Promise<void>;
  /** the bundle's HEAD, from a fresh clone of it, linked and deployed to
   *  production with the project pinned; the public production url. A seed
   *  path is bundled first. */
  deploy(from: ShipSource, project: string): Promise<string>;
  /** an extend's hand-off: the bundle's HEAD, which must be the tip of
   *  `new/<slug>`, grow from `base` and leave canopy's notes alone, pushed
   *  to that branch on the target's own github.com remote and nowhere
   *  else, never forced; the branch's GitHub url */
  pushBranch(from: ShipSource, to: BranchPush): Promise<string>;
  /** the Firebase project `id` made under FIREBASE_TOKEN's account; one
   *  that already exists and the login reaches counts as made */
  firebaseProject(id: string): Promise<void>;
  /** the project's default Firestore database at FIREBASE_LOCATION; one already there counts */
  firebaseDatabase(project: string): Promise<void>;
  /** the project's web app named `name`, made unless one is there; its app id */
  firebaseApp(project: string, name: string): Promise<string>;
  /** the web app's config set on the Vercel project as public env */
  firebaseEnv(project: string, app: string, vercelProject: string): Promise<void>;
  /** firebase.json's Firestore rules and indexes, deployed from a fresh
   *  clone of the bundle, refused when firebase.json holds more */
  firebaseDeploy(from: ShipSource, project: string): Promise<void>;
}

/** where an extend's branch goes */
export interface BranchPush {
  /** the target's https remote canopy recorded at the rebuild */
  remote: string;
  /** the target's remote as canopy resolved it just now; a push goes only
   *  where the two agree */
  want: string;
  slug: string;
  /** the commit the branch was made from */
  base: string;
}

/** a seed as one ship sends it */
export interface ShipBundle {
  file: string;
  head: string;
  done(): Promise<void>;
}
/** a bundle made once for the whole ship, or a seed path to bundle now */
export type ShipSource = ShipBundle | string;

export interface ShipConfig {
  vercelToken: string | null;
  /** a Vercel team slug; null is the token's own account */
  vercelScope: string | null;
  backend: string;
  /** a `firebase login:ci` token; null deploys nothing to Firebase */
  firebaseToken?: string | null;
  /** where a new project's Firestore lives; nam5 unless FIREBASE_LOCATION says */
  firebaseLocation?: string;
  /** the PATH the firebase CLI runs with (the image keeps it and its node
   *  under their own prefix); the server's own PATH when null */
  firebasePath?: string | null;
}

export const shipConfig = (env: Record<string, string | undefined>, backend: string): ShipConfig => ({
  vercelToken: env["VERCEL_TOKEN"]?.trim() || null,
  vercelScope: env["VERCEL_SCOPE"]?.trim() || null,
  backend,
  firebaseToken: env["FIREBASE_TOKEN"]?.trim() || null,
  firebaseLocation: env["FIREBASE_LOCATION"]?.trim() || "nam5",
  firebasePath: env["CANOPY_FIREBASE_PATH"]?.trim() || null,
});

/** a Firestore location id as Google names them: nam5, eur3, us-central1 */
export const isLocationId = (s: string): boolean => /^[a-z][a-z0-9-]{1,39}$/.test(s);

export interface ShipDeps {
  exec: (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>;
  fetch: typeof fetch;
  /** a command's path, looked up on `path` when given */
  which: (bin: string, path?: string) => string | null;
  /** where "owner/name" is pushed; GitHub's https url unless a test says */
  remote?: (repo: string) => string;
  /** where an extend's checked remote is pushed; the remote itself unless a test maps it to a fixture */
  branchRemote?: (remote: string) => string;
  /** the seed as a bundle in `file`, and its HEAD commit; `bundleSeed`
   *  unless a test says */
  bundle?: (seedPath: string, file: string) => Promise<{ head: string }>;
}

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const tail = (r: ExecResult, secret: string | null = null): string => {
  const text = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return secret ? text.split(secret).join("***") : text;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** the first symlink under `dir` (its .git aside) that leads outside it, by its path in `dir`, or null */
async function linkOut(dir: string): Promise<string | null> {
  const top = await realpath(dir);
  const walk = async (rel: string): Promise<string | null> => {
    for (const name of await readdir(join(dir, rel))) {
      const r = rel ? `${rel}/${name}` : name;
      if (r === ".git") continue;
      const st = await lstat(join(dir, r));
      if (st.isSymbolicLink()) {
        const to = await realpath(join(dir, r)).catch(() => null);
        if (to === null || (to !== top && !to.startsWith(`${top}/`))) return r;
      } else if (st.isDirectory()) {
        const found = await walk(r);
        if (found) return found;
      }
    }
    return null;
  };
  return walk("");
}

export function shipper(cfg: ShipConfig, deps: ShipDeps = { exec: realExec, fetch, which: (b, p) => Bun.which(b, p ? { PATH: p } : undefined) }): Shipper {
  const bundle = deps.bundle ?? ((seedPath: string, file: string) => bundleSeed(seedPath, file));
  const scope = cfg.vercelScope ? `slug=${encodeURIComponent(cfg.vercelScope)}` : "";
  const api = (path: string, init: { method?: string; body?: string } = {}): Promise<Response> =>
    deps.fetch(`https://api.vercel.com${path}${scope ? `${path.includes("?") ? "&" : "?"}${scope}` : ""}`, {
      ...init,
      headers: { authorization: `Bearer ${cfg.vercelToken ?? ""}`, ...(init.body ? { "content-type": "application/json" } : {}) },
      signal: AbortSignal.timeout(30_000),
    });
  const needToken = (): string => {
    if (!cfg.vercelToken) throw new Error(`add VERCEL_TOKEN to ${cfg.backend}'s .env`);
    return cfg.vercelToken;
  };
  /** A GET of a deployed page. Redirects are followed by hand and only
   *  within its host, over https, at most 5, so an app cannot make this
   *  backend fetch another address; one that leaves is `away`. */
  const get = async (start: string, wantBody = false): Promise<{ status: number; body: string } | { away: string | null }> => {
    const host = new URL(start).host;
    let at = start;
    for (let hop = 0; ; hop++) {
      const res = await deps.fetch(at, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
      if (res.status >= 300 && res.status < 400) {
        const loc = res.headers.get("location");
        let next: URL | null = null;
        try {
          next = loc ? new URL(loc, at) : null;
        } catch {
          next = null;
        }
        if (!next || next.host !== host || next.protocol !== "https:") return { away: next?.host ?? null };
        if (hop >= 5) throw new Error(`${start} redirects in a loop`);
        at = next.href;
        continue;
      }
      const body = wantBody ? (await res.text().catch(() => "")).slice(0, 64 * 1024) : "";
      return { status: res.status, body };
    }
  };
  const firebaseToken = cfg.firebaseToken ?? null;
  const location = cfg.firebaseLocation ?? "nam5";
  const firebasePath = (): string => cfg.firebasePath ?? process.env["PATH"] ?? "/usr/bin:/bin";
  /** One firebase CLI call, with the token in its env alone and an env of
   *  its own: PATH, and a scratch home and config dir removed after, so it
   *  never reads a login left on disk nor writes one. Its --json result. */
  const firebase = async (args: string[], cwd?: string, timeoutMs = 120_000): Promise<unknown> => {
    if (!firebaseToken) throw new Error(`add FIREBASE_TOKEN to ${cfg.backend}'s .env`);
    const path = firebasePath();
    const bin = deps.which("firebase", path);
    if (!bin) throw new Error(`the firebase CLI is not installed on ${cfg.backend}`);
    const home = await mkdtemp(join(tmpdir(), "canopy-firebase-"));
    try {
      const r = await deps.exec([bin, ...args, "--non-interactive", "--json"], {
        cwd: cwd ?? home,
        timeoutMs,
        base: { PATH: path },
        env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), XDG_CACHE_HOME: join(home, ".cache"), NO_UPDATE_NOTIFIER: "1", FIREBASE_TOKEN: firebaseToken },
      });
      const parsed = firebaseResult(r.stdout);
      if (r.code !== 0 || !parsed.ok) {
        const why = parsed.ok ? tail(r, firebaseToken) : parsed.error.split(firebaseToken).join("***");
        throw new Error(`firebase ${args[0] ?? ""}: ${why || tail(r, firebaseToken)}`);
      }
      return parsed.result;
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
  /** the project's web apps as `apps:list WEB` names them */
  const webApps = async (project: string): Promise<{ appId: string; displayName: string }[]> => {
    const listed = await firebase(["apps:list", "WEB", "--project", project]);
    if (!Array.isArray(listed)) return [];
    return listed.flatMap((a: unknown) => (isObj(a) && typeof a["appId"] === "string" ? [{ appId: a["appId"], displayName: typeof a["displayName"] === "string" ? a["displayName"] : "" }] : []));
  };
  const exists = (err: unknown): boolean => /already exists|ALREADY_EXISTS/i.test(String(err));

  const self: Shipper = {
    ready: (host) => {
      const why = deployReady(host, {
        vercelToken: cfg.vercelToken !== null,
        vercelCli: deps.which("vercel") !== null,
        firebaseToken: firebaseToken !== null,
        firebaseCli: deps.which("firebase", firebasePath()) !== null,
        backend: cfg.backend,
      });
      if (why || host !== "vercel+firebase") return why;
      return isLocationId(location) ? null : `FIREBASE_LOCATION ${location} on ${cfg.backend} is not a Firestore location id`;
    },

    async firebaseProject(id) {
      try {
        await firebase(["projects:create", id, "--display-name", id], undefined, 300_000);
      } catch (err) {
        // made on an earlier try that a restart cut short: taken only when this login reaches it
        if (!exists(err)) throw err;
        await webApps(id).catch(() => {
          throw err;
        });
      }
    },

    async firebaseDatabase(project) {
      try {
        await firebase(["firestore:databases:create", "(default)", "--location", location, "--project", project], undefined, 300_000);
      } catch (err) {
        if (!exists(err)) throw err;
      }
    },

    async firebaseApp(project, name) {
      const had = (await webApps(project)).find((a) => a.displayName === name);
      if (had) return had.appId;
      const made = await firebase(["apps:create", "WEB", name, "--project", project]);
      const appId = isObj(made) ? made["appId"] : null;
      if (typeof appId !== "string" || !appId) throw new Error("firebase apps:create named no app id");
      return appId;
    },

    async firebaseEnv(project, app, vercelProject) {
      needToken();
      const config = sdkConfigOf(await firebase(["apps:sdkconfig", "WEB", app, "--project", project]));
      if (!config || config["projectId"] !== project) throw new Error(`firebase apps:sdkconfig did not answer the config of a web app in ${project}`);
      const env = firebaseEnv(config);
      const body = Object.entries(env).map(([key, value]) => ({ key, value, type: "plain", target: ["production", "preview", "development"] }));
      const res = await api(`/v10/projects/${encodeURIComponent(vercelProject)}/env?upsert=true`, { method: "POST", body: JSON.stringify(body) });
      if (!res.ok) throw new Error(`the Vercel API answered ${res.status} setting the Firebase config on project ${vercelProject}`);
      const answer: unknown = await res.json().catch(() => null);
      const failed = isObj(answer) && Array.isArray(answer["failed"]) ? answer["failed"].length : 0;
      if (failed) throw new Error(`the Vercel API refused ${failed} of the Firebase config's env on project ${vercelProject}`);
    },

    async firebaseDeploy(from, project) {
      await withBundle(from, async ({ file, head }) => {
        const tmp = await mkdtemp(join(tmpdir(), "canopy-firebase-deploy-"));
        try {
          const app = join(tmp, "app");
          const opts = { timeoutMs: 300_000, env: { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" } };
          const cloned = await deps.exec(["git", ...NO_HOOKS, "clone", "--no-checkout", "--quiet", "--", file, app], { ...opts, cwd: tmp });
          if (cloned.code !== 0) throw new Error(`git clone of the seed's bundle: ${tail(cloned)}`);
          const checked = await deps.exec(["git", ...NO_HOOKS, "checkout", "-q", "--detach", head], { ...opts, cwd: app });
          if (checked.code !== 0) throw new Error(`git checkout of the seed's HEAD: ${tail(checked)}`);
          // the project is named on the command line, and no env file of the agent's is read
          for (const name of await readdir(app)) {
            if (name === ".firebaserc" || name.startsWith(".env")) await rm(join(app, name), { recursive: true, force: true });
          }
          const config = await readSeed(app, "firebase.json");
          const refused = firebaseConfigRefusal(config);
          if (refused) throw new Error(refused);
          // read as canopy reads a seed's file: a symlink on the way or a hard link is refused
          for (const f of firebaseFiles(config ?? "")) {
            if ((await readSeed(app, f)) === null) throw new Error(`firebase.json names ${f}, which is not in the repo`);
          }
          const out = await linkOut(app);
          if (out) throw new Error(`${out} is a symlink out of the repo, so canopy will not hand the repo to the firebase CLI`);
          await firebase(["deploy", "--only", "firestore", "--project", project], app, 600_000);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      });
    },

    async createRepo(slug, description) {
      const who = await deps.exec(["gh", "api", "user", "--jq", ".login"], { timeoutMs: 30_000 });
      const owner = who.stdout.trim();
      if (who.code !== 0 || !/^[A-Za-z0-9-]+$/.test(owner)) throw new Error(`gh cannot say who it is logged in as: ${tail(who)}`);
      for (const name of repoCandidates(slug)) {
        const full = `${owner}/${name}`;
        const seen = await deps.exec(["gh", "repo", "view", full, "--json", "name"], { timeoutMs: 30_000 });
        if (seen.code === 0) continue;
        const made = await deps.exec(["gh", "repo", "create", full, "--private", "--disable-wiki", "--description", description.slice(0, 300)], { timeoutMs: 60_000 });
        if (made.code !== 0) throw new Error(`gh repo create ${full}: ${tail(made)}`);
        return full;
      }
      throw new Error(`every name from ${slug} to ${slug}-9 is taken on GitHub`);
    },

    async project(slug, seedPath) {
      needToken();
      const framework = frameworkOf(await readSeed(seedPath, "package.json").catch(() => null));
      for (const name of repoCandidates(slug).map(vercelProject)) {
        const res = await api(`/v9/projects/${encodeURIComponent(name)}`);
        if (res.ok) continue;
        if (res.status !== 404) throw new Error(`the Vercel API answered ${res.status} for project ${name}`);
        // made here, so the link never has to make it: vercel link only
        // promises a non-interactive link to a project that exists. With no
        // framework Vercel serves the repo's root as it is, so a Vite or Next
        // app says which it is.
        const made = await api("/v11/projects", { method: "POST", body: JSON.stringify({ name, ...(framework ? { framework } : {}) }) });
        if (made.ok) return name;
        if (made.status === 409) continue;
        throw new Error(`the Vercel API answered ${made.status} making project ${name}`);
      }
      throw new Error(`every Vercel project name from ${slug} to ${slug}-9 is taken`);
    },

    async bundle(seedPath) {
      const tmp = await mkdtemp(join(tmpdir(), "canopy-bundle-"));
      const file = join(tmp, "seed.bundle");
      try {
        const { head } = await bundle(seedPath, file);
        return { file, head, done: () => rm(tmp, { recursive: true, force: true }) };
      } catch (err) {
        await rm(tmp, { recursive: true, force: true });
        throw err;
      }
    },

    async push(from, repo) {
      // Pushed from a bare clone of a bundle of the seed, never from the
      // seed itself, nor a clone of it: the seed's .git/config is the
      // agents' to write, and a pushurl, a pushInsteadOf or a credential
      // helper there would send canopy's push, or its token, where they
      // chose. The bundle is made where canopy's seed git runs (the stage
      // runner on an isolated backend) and is plain data here.
      const url = deps.remote ? deps.remote(repo) : `https://github.com/${repo}.git`;
      await withBundle(from, async ({ file, head }) => {
        const tmp = await mkdtemp(join(tmpdir(), "canopy-ship-"));
        const bare = join(tmp, "seed.git");
        const git = (args: string[], cwd: string, timeoutMs = 30_000): Promise<ExecResult> =>
          deps.exec(["git", ...NO_HOOKS, ...args], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
        try {
          const cloned = await git(["clone", "--bare", "--quiet", "--", file, bare], tmp, 300_000);
          if (cloned.code !== 0) throw new Error(`git clone of the seed's bundle: ${tail(cloned)}`);
          const set = await git(["remote", "set-url", "origin", url], bare);
          if (set.code !== 0) throw new Error(`git remote: ${tail(set)}`);
          // the bundle's HEAD, whatever branch the clone took as its own
          const pushed = await git(["push", "origin", `${head}:refs/heads/main`], bare, 300_000);
          if (pushed.code !== 0) throw new Error(`git push: ${tail(pushed)}`);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      });
    },

    async pushBranch(from, to) {
      const ref = `refs/heads/${extendBranch(to.slug)}`;
      const refused = branchPushRefusal({ remote: to.remote, ref }, { remote: to.want, slug: to.slug });
      if (refused) throw new Error(refused);
      const gh = githubRepo(to.remote);
      if (!gh) throw new Error(`${to.remote} is not a github.com repo`);
      if (!/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(to.base)) throw new Error("the branch's base is not a commit id");
      const url = deps.branchRemote ? deps.branchRemote(to.remote) : to.remote;
      await withBundle(from, async ({ file, head }) => {
        const tmp = await mkdtemp(join(tmpdir(), "canopy-handoff-"));
        const bare = join(tmp, "seed.git");
        const git = (args: string[], cwd: string, timeoutMs = 30_000): Promise<ExecResult> =>
          deps.exec(["git", ...NO_HOOKS, ...args], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
        try {
          const cloned = await git(["clone", "--bare", "--quiet", "--", file, bare], tmp, 300_000);
          if (cloned.code !== 0) throw new Error(`git clone of the seed's bundle: ${tail(cloned)}`);
          // the commit Accept saw is the branch's tip, not some other branch HEAD was moved to
          const tip = await git(["rev-parse", "--verify", "-q", `${ref}^{commit}`], bare);
          if (tip.code !== 0 || tip.stdout.trim() !== head) throw new Error(`the seed's HEAD is not the tip of ${extendBranch(to.slug)}, so canopy will not push it`);
          const grows = await git(["merge-base", "--is-ancestor", to.base, head], bare);
          if (grows.code !== 0) throw new Error(`${extendBranch(to.slug)} does not grow from ${to.base.slice(0, 12)}, the target's branch canopy cloned`);
          // every commit, a merge's other side too: history simplification
          // would hide a `-s ours` merge of the notes' own branch
          const touched = await git(["log", "--full-history", "--no-merges", "--format=", "--name-only", `${to.base}..${head}`, "--", ...NOTE_FILES.map((f) => `:(literal)${f}`)], bare);
          if (touched.code !== 0) throw new Error(`git log of the branch: ${tail(touched)}`);
          const notes = [...new Set(touched.stdout.split("\n").filter((l) => l.trim()))];
          if (notes.length) throw new Error(`the branch's commits touch canopy's notes (${notes.join(", ")}), which never go to the user's repo`);
          // a merge brings in history canopy did not build: the branch is a line of the agent's commits
          const merges = await git(["rev-list", "--min-parents=2", `${to.base}..${head}`], bare);
          if (merges.code !== 0) throw new Error(`git rev-list of the branch: ${tail(merges)}`);
          const merge = merges.stdout.trim().split("\n")[0];
          if (merge) throw new Error(`${extendBranch(to.slug)} holds a merge (${merge.slice(0, 12)}); canopy hands off a straight line of commits only`);
          // one ref, no +, no tags, whatever the global config says
          const pushed = await git(["-c", "push.followTags=false", "-c", "push.recurseSubmodules=no", "push", "--quiet", "--no-verify", "--", url, `${head}:${ref}`], bare, 300_000);
          if (pushed.code !== 0) throw new Error(`git push: ${tail(pushed)}`);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      });
      return `https://github.com/${gh.owner}/${gh.name}/tree/${extendBranch(to.slug)}`;
    },

    async deploy(from, project) {
      const token = needToken();
      // the seed as a bundle first, so a seed canopy will not run git in is
      // refused before anything reaches Vercel
      return withBundle(from, async ({ file, head }) => {
        const tmp = await mkdtemp(join(tmpdir(), "canopy-deploy-"));
        try {
          return await deployFrom(file, head, tmp, project, token);
        } finally {
          await rm(tmp, { recursive: true, force: true });
        }
      });
    },
  };
  return self;

  /** `f` over the bundle given, or over one made of the seed path given
   *  and removed after */
  async function withBundle<T>(from: ShipSource, f: (b: ShipBundle) => Promise<T>): Promise<T> {
    if (typeof from !== "string") return f(from);
    const made = await self.bundle(from);
    try {
      return await f(made);
    } finally {
      await made.done();
    }
  }

  /** the deploy proper, from the bundle in `file` at its commit `head` */
  async function deployFrom(file: string, head: string, tmp: string, project: string, token: string): Promise<string> {
    // the project canopy made, by id, so no link file in the seed can
    // point the deploy at another one
    const found = await api(`/v9/projects/${encodeURIComponent(project)}`);
    if (!found.ok) throw new Error(`the Vercel API answered ${found.status} for project ${project}`);
    const meta: unknown = await found.json().catch(() => null);
    const projectId = isObj(meta) && typeof meta["id"] === "string" ? meta["id"] : "";
    const orgId = isObj(meta) && typeof meta["accountId"] === "string" ? meta["accountId"] : "";
    if (!projectId || !orgId) throw new Error(`the Vercel API did not say which project and team ${project} is, so canopy will not deploy it blind`);
    // canopy goes live only on a URL its smoke GET reaches, and the team's
    // default protection puts Vercel's login in front of production ones.
    // Previews stay protected; set per project, never team-wide.
    const sso = isObj(meta) ? meta["ssoProtection"] : null;
    if (isObj(sso) && sso["deploymentType"] !== "preview") {
      const set = await api(`/v9/projects/${encodeURIComponent(projectId)}`, { method: "PATCH", body: JSON.stringify({ ssoProtection: { deploymentType: "preview" } }) });
      if (!set.ok) throw new Error(`the Vercel API answered ${set.status} setting Vercel Authentication on project ${project}, so canopy will not deploy a project whose production would sit behind Vercel's login`);
    }
    // Deployed from a fresh clone of the seed's bundle at its HEAD: what
    // was pushed, and nothing the seed holds uncommitted or ignored
    // (.env.local, .vercel/).
    const app = join(tmp, "app");
    // the checkout runs the global config's filter drivers on what the
    // seed's .gitattributes names; git-lfs would fetch from wherever a
    // committed .lfsconfig says
    const opts = { timeoutMs: 300_000, env: { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" } };
    const cloned = await deps.exec(["git", ...NO_HOOKS, "clone", "--no-checkout", "--quiet", "--", file, app], { ...opts, cwd: tmp });
    if (cloned.code !== 0) throw new Error(`git clone of the seed's bundle: ${tail(cloned)}`);
    const checked = await deps.exec(["git", ...NO_HOOKS, "checkout", "-q", "--detach", head], { ...opts, cwd: app });
    if (checked.code !== 0) throw new Error(`git checkout of the seed's HEAD: ${tail(checked)}`);
    await rm(join(app, ".vercel"), { recursive: true, force: true });
    const refused = vercelConfigRefusal(await readdir(app), await readSeed(app, "vercel.json"));
    if (refused) throw new Error(refused);
    await writeSeed(app, ".vercelignore", withCanopyIgnored(await readSeed(app, ".vercelignore")));
    const env = { VERCEL_TOKEN: token, VERCEL_TELEMETRY_DISABLED: "1", VERCEL_ORG_ID: orgId, VERCEL_PROJECT_ID: projectId };
    const link = await deps.exec(vercelArgs("link", project, cfg.vercelScope), { cwd: app, timeoutMs: 120_000, env });
    if (link.code !== 0) throw new Error(`vercel link: ${tail(link, token)}`);
    const out = await deps.exec(vercelArgs("deploy", project, cfg.vercelScope), { cwd: app, timeoutMs: 15 * 60_000, env });
    if (out.code !== 0) throw new Error(`vercel deploy: ${tail(out, token)}`);
    const dep = deploymentUrl(out.stdout);
    if (!dep) throw new Error("vercel deploy printed no deployment url");
    const res = await api(`/v13/deployments/${new URL(dep).host}`);
    if (!res.ok) throw new Error(`the Vercel API answered ${res.status} for the deployment, so canopy cannot check where it went live`);
    const body: unknown = await res.json().catch(() => null);
    const aliases = isObj(body) && Array.isArray(body["alias"]) ? body["alias"].filter((a): a is string => typeof a === "string") : [];
    const strange = strangeAliases(aliases);
    if (strange.length) throw new Error(`the deploy is also at ${strange.join(", ")}, which is not a vercel.app address: remove it from the project's domains, then resume`);
    const url = productionUrl(aliases, dep);
    if (!isVercelAppUrl(url)) throw new Error(`the deploy answered ${url}, which is not a vercel.app address`);
    const home = await get(url);
    if ("away" in home) {
      throw new Error(`${url} sends visitors on to ${home.away ?? "an address it does not name"}, likely a sign-in page: turn off deployment protection for production, then resume`);
    }
    const why = smokeRefusal(home.status, url);
    if (why) throw new Error(why);
    // a framework the project did not take serves the repo's root, and
    // the notes under .canopy/ with it
    const intent = await readSeed(app, ".canopy/intent.md").catch(() => null);
    const note = await get(`${url}/.canopy/intent.md`, true);
    if (intent && !("away" in note) && note.status >= 200 && note.status < 300 && servesFile(note.body, intent)) {
      throw new Error("the deploy serves the repo root; .canopy/ is public");
    }
    return url;
  }
}
