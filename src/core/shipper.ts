/**
 * The incubator's deploy, carried out by canopy and not by an agent (spec
 * amendment 2): the private GitHub repo, the push, the Vercel link and
 * deploy, and a smoke GET of the production url. Bun-only; every outside
 * call goes through injected deps so the tests drive it with fakes.
 */
import { deployReady, deploymentUrl, isVercelAppUrl, productionUrl, repoCandidates, smokeRefusal, vercelArgs, vercelProject } from "./deploy";
import { exec as realExec, type ExecOptions, type ExecResult } from "./exec";
import type { HostId } from "./types";

export interface Shipper {
  /** null when the host can be deployed to from here, else the park reason */
  ready(host: HostId): string | null;
  /** a new private repo under the gh login, "owner/name" */
  createRepo(slug: string, description: string): Promise<string>;
  /** a Vercel project of its own, made under a name the account did not have */
  project(slug: string): Promise<string>;
  /** origin set to the repo, HEAD pushed to main, hooks off */
  push(seedPath: string, repo: string): Promise<void>;
  /** linked and deployed to production; the public production url */
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

    async project(slug) {
      needToken();
      for (const name of repoCandidates(slug).map(vercelProject)) {
        const res = await api(`/v9/projects/${encodeURIComponent(name)}`);
        if (res.ok) continue;
        if (res.status !== 404) throw new Error(`the Vercel API answered ${res.status} for project ${name}`);
        // made here, so the link never has to make it: vercel link only
        // promises a non-interactive link to a project that exists
        const made = await api("/v11/projects", { method: "POST", body: JSON.stringify({ name }) });
        if (made.ok) return name;
        if (made.status === 409) continue;
        throw new Error(`the Vercel API answered ${made.status} making project ${name}`);
      }
      throw new Error(`every Vercel project name from ${slug} to ${slug}-9 is taken`);
    },

    async push(seedPath, repo) {
      const url = `https://github.com/${repo}.git`;
      const git = (args: string[], timeoutMs = 30_000): Promise<ExecResult> =>
        deps.exec(["git", ...NO_HOOKS, ...args], { cwd: seedPath, timeoutMs, env: { GIT_TERMINAL_PROMPT: "0" } });
      const has = await git(["remote", "get-url", "origin"]);
      const set = await git(has.code === 0 ? ["remote", "set-url", "origin", url] : ["remote", "add", "origin", url]);
      if (set.code !== 0) throw new Error(`git remote: ${tail(set)}`);
      const pushed = await git(["push", "-u", "origin", "HEAD:refs/heads/main"], 300_000);
      if (pushed.code !== 0) throw new Error(`git push: ${tail(pushed)}`);
    },

    async deploy(seedPath, project) {
      const token = needToken();
      const env = { VERCEL_TOKEN: token, VERCEL_TELEMETRY_DISABLED: "1" };
      const link = await deps.exec(vercelArgs("link", project, cfg.vercelScope), { cwd: seedPath, timeoutMs: 120_000, env });
      if (link.code !== 0) throw new Error(`vercel link: ${tail(link, token)}`);
      const out = await deps.exec(vercelArgs("deploy", project, cfg.vercelScope), { cwd: seedPath, timeoutMs: 15 * 60_000, env });
      if (out.code !== 0) throw new Error(`vercel deploy: ${tail(out, token)}`);
      const dep = deploymentUrl(out.stdout);
      if (!dep) throw new Error("vercel deploy printed no deployment url");
      const res = await api(`/v13/deployments/${new URL(dep).host}`);
      const body: unknown = res.ok ? await res.json() : null;
      const aliases = isObj(body) && Array.isArray(body["alias"]) ? body["alias"].filter((a): a is string => typeof a === "string") : [];
      const url = productionUrl(aliases, dep);
      if (!isVercelAppUrl(url)) throw new Error(`the deploy answered ${url}, which is not a vercel.app address`);
      // redirects are followed by hand and only within the production host,
      // so an app cannot make this backend fetch another address
      const host = new URL(url).host;
      const away = `${url} sends visitors on to HOST, likely a sign-in page: turn off deployment protection for production, then resume`;
      let at = url;
      for (let hop = 0; ; hop++) {
        const smoke = await deps.fetch(at, { redirect: "manual", signal: AbortSignal.timeout(30_000) });
        if (smoke.status >= 300 && smoke.status < 400) {
          const loc = smoke.headers.get("location");
          let next: URL | null = null;
          try {
            next = loc ? new URL(loc, at) : null;
          } catch {
            next = null;
          }
          if (!next || next.host !== host || next.protocol !== "https:") throw new Error(away.replace("HOST", next?.host ?? "an address it does not name"));
          if (hop >= 5) throw new Error(`${url} redirects in a loop`);
          at = next.href;
          continue;
        }
        const refused = smokeRefusal(smoke.status, url);
        if (refused) throw new Error(refused);
        break;
      }
      return url;
    },
  };
}
