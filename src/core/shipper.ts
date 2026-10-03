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
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec as realExec, type ExecOptions, type ExecResult } from "./exec";
import { readSeed, writeSeed } from "./seed";
import { bundleSeed } from "./seedmirror";
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
}

export const shipConfig = (env: Record<string, string | undefined>, backend: string): ShipConfig => ({
  vercelToken: env["VERCEL_TOKEN"]?.trim() || null,
  vercelScope: env["VERCEL_SCOPE"]?.trim() || null,
  backend,
});

export interface ShipDeps {
  exec: (cmd: string[], opts?: ExecOptions) => Promise<ExecResult>;
  fetch: typeof fetch;
  which: (bin: string) => string | null;
  /** where "owner/name" is pushed; GitHub's https url unless a test says */
  remote?: (repo: string) => string;
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

export function shipper(cfg: ShipConfig, deps: ShipDeps = { exec: realExec, fetch, which: (b) => Bun.which(b) }): Shipper {
  const bundle = deps.bundle ?? ((seedPath: string, file: string) => bundleSeed(seedPath, file));
  const scopeQuery = cfg.vercelScope ? `?slug=${encodeURIComponent(cfg.vercelScope)}` : "";
  const api = (path: string, init: { method?: string; body?: string } = {}): Promise<Response> =>
    deps.fetch(`https://api.vercel.com${path}${scopeQuery}`, {
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
  const self: Shipper = {
    ready: (host) => deployReady(host, { vercelToken: cfg.vercelToken !== null, vercelCli: deps.which("vercel") !== null, backend: cfg.backend }),

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
