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
import type { HostId } from "./types";

export interface Shipper {
  /** null when the host can be deployed to from here, else the park reason */
  ready(host: HostId): string | null;
  /** a new private repo under the gh login, "owner/name" */
  createRepo(slug: string, description: string): Promise<string>;
  /** a Vercel project of its own, made under a name the account did not
   *  have, with the framework the seed's package.json makes clear */
  project(slug: string, seedPath: string): Promise<string>;
  /** the seed's HEAD pushed to main from a fresh bare clone of it, hooks off */
  push(seedPath: string, repo: string): Promise<void>;
  /** the seed's HEAD, from a fresh clone of it, linked and deployed to
   *  production with the project pinned; the public production url */
  deploy(seedPath: string, project: string): Promise<string>;
}

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
}

const NO_HOOKS = ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false"];
const tail = (r: ExecResult, secret: string | null = null): string => {
  const text = (r.stderr || r.stdout).trim().split("\n").slice(-3).join(" ").slice(0, 300);
  return secret ? text.split(secret).join("***") : text;
};
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function shipper(cfg: ShipConfig, deps: ShipDeps = { exec: realExec, fetch, which: (b) => Bun.which(b) }): Shipper {
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
  return {
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

    async push(seedPath, repo) {
      // Pushed from a bare clone canopy makes, never from the seed itself:
      // the seed's .git/config is the agents' to write, and a pushurl, a
      // pushInsteadOf or a credential helper there would send canopy's push,
      // or its token, where they chose.
      const url = deps.remote ? deps.remote(repo) : `https://github.com/${repo}.git`;
      const tmp = await mkdtemp(join(tmpdir(), "canopy-ship-"));
      const bare = join(tmp, "seed.git");
      const git = (args: string[], cwd: string, timeoutMs = 30_000): Promise<ExecResult> =>
        deps.exec(["git", ...NO_HOOKS, ...args], { cwd, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
      try {
        const cloned = await git(["clone", "--bare", "--no-local", "--quiet", "--", seedPath, bare], tmp, 300_000);
        if (cloned.code !== 0) throw new Error(`git clone of the seed: ${tail(cloned)}`);
        const set = await git(["remote", "set-url", "origin", url], bare);
        if (set.code !== 0) throw new Error(`git remote: ${tail(set)}`);
        const pushed = await git(["push", "origin", "HEAD:refs/heads/main"], bare, 300_000);
        if (pushed.code !== 0) throw new Error(`git push: ${tail(pushed)}`);
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },

    async deploy(seedPath, project) {
      const token = needToken();
      // the project canopy made, by id, so no link file in the seed can
      // point the deploy at another one
      const found = await api(`/v9/projects/${encodeURIComponent(project)}`);
      if (!found.ok) throw new Error(`the Vercel API answered ${found.status} for project ${project}`);
      const meta: unknown = await found.json().catch(() => null);
      const projectId = isObj(meta) && typeof meta["id"] === "string" ? meta["id"] : "";
      const orgId = isObj(meta) && typeof meta["accountId"] === "string" ? meta["accountId"] : "";
      if (!projectId || !orgId) throw new Error(`the Vercel API did not say which project and team ${project} is, so canopy will not deploy it blind`);
      // Deployed from a fresh clone of the seed's HEAD: what was pushed, and
      // nothing the seed holds uncommitted or ignored (.env.local, .vercel/).
      const tmp = await mkdtemp(join(tmpdir(), "canopy-deploy-"));
      const app = join(tmp, "app");
      try {
        const cloned = await deps.exec(["git", ...NO_HOOKS, "clone", "--no-local", "--quiet", "--", seedPath, app], {
          cwd: tmp,
          timeoutMs: 300_000,
          // the checkout runs the global config's filter drivers on what the
          // seed's .gitattributes names; git-lfs would fetch from wherever
          // a committed .lfsconfig says
          env: { GIT_TERMINAL_PROMPT: "0", GIT_LFS_SKIP_SMUDGE: "1" },
        });
        if (cloned.code !== 0) throw new Error(`git clone of the seed: ${tail(cloned)}`);
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
      } finally {
        await rm(tmp, { recursive: true, force: true });
      }
    },
  };
}
