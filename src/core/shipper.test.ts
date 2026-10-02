import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, type ExecOptions, type ExecResult } from "./exec";
import { shipConfig, shipper, type ShipDeps } from "./shipper";

interface Call { cmd: string[]; opts: ExecOptions }
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const no = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });

function fakes(answer: (c: Call) => ExecResult, http: (url: string, method: string) => Response = () => new Response("{}", { status: 200 })) {
  const calls: Call[] = [];
  const fetched: { url: string; method: string; auth: string | null; redirect?: string }[] = [];
  const deps: ShipDeps = {
    exec: async (cmd, opts = {}) => {
      const c = { cmd, opts };
      calls.push(c);
      return answer(c);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      fetched.push({ url, method, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect });
      return http(url, method);
    }) as typeof fetch,
    which: (bin) => (bin === "vercel" ? "/usr/bin/vercel" : null),
  };
  return { calls, fetched, deps };
}
const cfg = shipConfig({ VERCEL_TOKEN: "tok_secret" }, "mini");

describe("createRepo", () => {
  test("a private repo under the logged-in owner, skipping taken names", async () => {
    const f = fakes((c) => {
      if (c.cmd.join(" ") === "gh api user --jq .login") return ok("eric\n");
      if (c.cmd[1] === "repo" && c.cmd[2] === "view") return c.cmd[3] === "eric/coin-counter" ? ok("{}") : no("not found");
      return ok();
    });
    expect(await shipper(cfg, f.deps).createRepo("coin-counter", "Coin counter")).toBe("eric/coin-counter-2");
    const create = f.calls.find((c) => c.cmd[2] === "create");
    expect(create?.cmd).toEqual(["gh", "repo", "create", "eric/coin-counter-2", "--private", "--disable-wiki", "--description", "Coin counter"]);
  });
  test("a gh that cannot say who it is fails with the reason", async () => {
    const f = fakes(() => no("HTTP 401"));
    await expect(shipper(cfg, f.deps).createRepo("x", "x")).rejects.toThrow("gh cannot say who it is logged in as: HTTP 401");
  });
});

describe("project", () => {
  test("the first project name Vercel does not have yet, made there before the link", async () => {
    const f = fakes(
      () => ok(),
      (url, method) => new Response("{}", { status: method === "POST" ? 200 : url.endsWith("/v9/projects/coin-counter") ? 200 : 404 }),
    );
    expect(await shipper(cfg, f.deps).project("coin-counter")).toBe("coin-counter-2");
    expect(f.fetched.map((x) => `${x.method} ${x.url}`)).toEqual([
      "GET https://api.vercel.com/v9/projects/coin-counter",
      "GET https://api.vercel.com/v9/projects/coin-counter-2",
      "POST https://api.vercel.com/v11/projects",
    ]);
    expect(f.fetched.every((x) => x.auth === "Bearer tok_secret")).toBe(true);
  });
  test("a name another account took between the read and the make goes on to the next", async () => {
    const f = fakes(
      () => ok(),
      (url, method) => new Response("{}", { status: method === "POST" ? (f.fetched.filter((x) => x.method === "POST").length === 1 ? 409 : 200) : 404 }),
    );
    expect(await shipper(cfg, f.deps).project("coin-counter")).toBe("coin-counter-2");
  });
});

describe("push", () => {
  const git = async (cwd: string, ...args: string[]): Promise<string> => {
    const r = await exec(["git", ...args], { cwd });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
    return r.stdout.trim();
  };
  const bareRepo = async (name: string): Promise<string> => {
    const path = join(await mkdtemp(join(tmpdir(), `canopy-ship-${name}-`)), `${name}.git`);
    await exec(["git", "init", "-q", "--bare", path]);
    return path;
  };
  /** a seed whose own config sends any push from it to `decoy` instead */
  const hostileSeed = async (target: string, decoy: string): Promise<{ seed: string; head: string }> => {
    const seed = await mkdtemp(join(tmpdir(), "canopy-ship-seed-"));
    await git(seed, "init", "-q", "-b", "main");
    await writeFile(join(seed, "index.html"), "<p>ok</p>\n");
    await git(seed, "add", "-A");
    await git(seed, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
    await git(seed, "remote", "add", "origin", target);
    await git(seed, "config", "remote.origin.pushurl", decoy);
    await git(seed, "config", `url.${decoy}.pushInsteadOf`, target);
    return { seed, head: await git(seed, "rev-parse", "HEAD") };
  };
  const refs = async (bare: string): Promise<string> => (await exec(["git", "for-each-ref", "--format=%(refname) %(objectname)"], { cwd: bare })).stdout.trim();

  test("the seed's HEAD reaches the target's main, whatever the seed's config says", async () => {
    const target = await bareRepo("target");
    const decoy = await bareRepo("decoy");
    const { seed, head } = await hostileSeed(target, decoy);
    const cwds: string[] = [];
    const deps: ShipDeps = {
      exec: (cmd, opts) => {
        if (opts?.cwd) cwds.push(opts.cwd);
        return exec(cmd, opts);
      },
      fetch,
      which: () => null,
      remote: (repo) => (repo === "eric/coin-counter" ? target : "nowhere"),
    };
    await shipper(cfg, deps).push(seed, "eric/coin-counter");
    expect(await refs(target)).toBe(`refs/heads/main ${head}`);
    expect(await refs(decoy)).toBe("");
    // nothing ran in the seed, and the scratch clone is gone
    expect(cwds.includes(seed)).toBe(false);
    expect(cwds.length).toBeGreaterThan(0);
    for (const c of cwds) expect(existsSync(c)).toBe(false);
    // the seed's own config would have sent a plain push to the decoy
    await git(seed, "push", "-q", "origin", "HEAD:refs/heads/main");
    expect(await refs(decoy)).toBe(`refs/heads/main ${head}`);
  });
  test("a refused push fails with git's words, hooks off and no prompt", async () => {
    const f = fakes((c) => (c.cmd.includes("push") ? no("rejected: non-fast-forward") : ok()));
    await expect(shipper(cfg, f.deps).push("/seed", "eric/x")).rejects.toThrow("git push: rejected: non-fast-forward");
    for (const c of f.calls) {
      expect(c.cmd).toContain("core.hooksPath=/dev/null");
      expect(c.cmd).toContain("core.fsmonitor=false");
      expect(c.opts.env?.["GIT_TERMINAL_PROMPT"]).toBe("0");
    }
    const clone = f.calls[0]?.cmd ?? [];
    expect(clone.slice(clone.indexOf("clone"), -1)).toEqual(["clone", "--bare", "--no-local", "--quiet", "--", "/seed"]);
  });
});

describe("deploy", () => {
  const deployed = (c: Call): ExecResult => (c.cmd[1] === "deploy" ? ok("Vercel CLI 61.1.0\nhttps://coin-counter-abc-eric.vercel.app\n") : ok());
  test("link, deploy, read the aliases, smoke the production url; the token only in the env", async () => {
    const f = fakes(deployed, (url) =>
      url.includes("/v13/deployments/")
        ? new Response(JSON.stringify({ alias: ["coin-counter.vercel.app", "coin-counter-eric.vercel.app"] }), { status: 200 })
        : new Response("<html>", { status: 200 }),
    );
    expect(await shipper(cfg, f.deps).deploy("/seed", "coin-counter")).toBe("https://coin-counter.vercel.app");
    expect(f.calls.map((c) => c.cmd.slice(0, 2).join(" "))).toEqual(["vercel link", "vercel deploy"]);
    for (const c of f.calls) {
      expect(c.cmd.join(" ")).not.toContain("tok_secret");
      expect(c.opts.env?.["VERCEL_TOKEN"]).toBe("tok_secret");
    }
    expect(f.fetched.map((x) => x.url)).toEqual(["https://api.vercel.com/v13/deployments/coin-counter-abc-eric.vercel.app", "https://coin-counter.vercel.app"]);
    // the smoke GET goes to the public page without the token
    expect(f.fetched[1]?.auth).toBe(null);
  });
  test("a production url behind protection fails with the reason; no token fails before anything runs", async () => {
    const f = fakes(deployed, (url) => new Response("{}", { status: url.includes("api.vercel.com") ? 200 : 401 }));
    await expect(shipper(cfg, f.deps).deploy("/seed", "p")).rejects.toThrow("answers 401: Vercel's deployment protection may cover it");
    const none = fakes(deployed);
    await expect(shipper(shipConfig({}, "mini"), none.deps).deploy("/seed", "p")).rejects.toThrow("add VERCEL_TOKEN to mini's .env");
    expect(none.calls).toHaveLength(0);
  });
  const prod = (smoke: (url: string) => Response) => (url: string) => (url.includes("api.vercel.com") ? new Response("{}", { status: 200 }) : smoke(url));
  const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });
  test("a redirect off the production host is refused and never followed", async () => {
    const f = fakes(deployed, prod(() => redirect(307, "https://vercel.com/login?next=x")));
    await expect(shipper(cfg, f.deps).deploy("/seed", "p")).rejects.toThrow("sends visitors on to vercel.com");
    expect(f.fetched.some((x) => x.url.includes("//vercel.com"))).toBe(false);
    expect(f.fetched.at(-1)?.redirect).toBe("manual");
  });
  test("a redirect with no usable location is refused", async () => {
    const f = fakes(deployed, prod(() => new Response(null, { status: 302 })));
    await expect(shipper(cfg, f.deps).deploy("/seed", "p")).rejects.toThrow("sends visitors on to an address it does not name");
  });
  test("a same-host redirect is followed by hand", async () => {
    const f = fakes(deployed, prod((url) => (url.endsWith("/home") ? new Response("<html>", { status: 200 }) : redirect(308, "/home"))));
    expect(await shipper(cfg, f.deps).deploy("/seed", "p")).toBe("https://coin-counter-abc-eric.vercel.app");
    expect(f.fetched.filter((x) => !x.url.includes("api.vercel.com")).every((x) => x.redirect === "manual")).toBe(true);
  });
  test("six same-host hops are a loop", async () => {
    const f = fakes(deployed, prod(() => redirect(307, "/again")));
    await expect(shipper(cfg, f.deps).deploy("/seed", "p")).rejects.toThrow("redirects in a loop");
  });
  test("a failed deploy never echoes the token", async () => {
    const f = fakes((c) => (c.cmd[1] === "deploy" ? no("auth failed for tok_secret here") : ok()));
    const err = await shipper(cfg, f.deps).deploy("/seed", "p").catch((e: Error) => e.message);
    expect(err).toContain("***");
    expect(err).not.toContain("tok_secret");
  });
  test("ready reads the token and the CLI", () => {
    expect(shipper(cfg, fakes(() => ok()).deps).ready("vercel")).toBe(null);
    expect(shipper(shipConfig({}, "mini"), fakes(() => ok()).deps).ready("vercel")).toBe("add VERCEL_TOKEN to mini's .env");
  });
});

// Live run: makes a real private repo and a real Vercel project, then deletes both.
// Needs CANOPY_INCUBATOR_IT=1 and VERCEL_TOKEN; `gh repo delete` needs the delete_repo scope.
const LIVE = process.env["CANOPY_INCUBATOR_IT"] === "1" && Boolean(process.env["VERCEL_TOKEN"]);
test.skipIf(!LIVE)("a real static site goes live and is cleaned up", async () => {
  const dir = await mkdtemp(join(tmpdir(), "canopy-it-"));
  const name = `canopy-it-${randomBytes(3).toString("hex")}`;
  const ship = shipper(shipConfig(process.env, "it"));
  let repo: string | null = null;
  let project: string | null = null;
  try {
    await writeFile(join(dir, "index.html"), "<!doctype html><title>canopy it</title><p>ok</p>");
    for (const args of [["init", "-b", "main"], ["add", "-A"], ["-c", "user.name=canopy", "-c", "user.email=canopy@localhost", "commit", "-m", "it"]]) {
      expect((await exec(["git", ...args], { cwd: dir })).code).toBe(0);
    }
    repo = await ship.createRepo(name, "canopy integration test, deleted at the end");
    project = await ship.project(name);
    await ship.push(dir, repo);
    const url = await ship.deploy(dir, project);
    expect(url).toMatch(/^https:\/\/.+\.vercel\.app$/);
  } finally {
    if (project) {
      const scope = process.env["VERCEL_SCOPE"] ? `?slug=${encodeURIComponent(process.env["VERCEL_SCOPE"])}` : "";
      await fetch(`https://api.vercel.com/v9/projects/${project}${scope}`, { method: "DELETE", headers: { authorization: `Bearer ${process.env["VERCEL_TOKEN"] ?? ""}` } });
    }
    if (repo) await exec(["gh", "repo", "delete", repo, "--yes"]);
    await rm(dir, { recursive: true, force: true });
  }
}, 20 * 60_000);
