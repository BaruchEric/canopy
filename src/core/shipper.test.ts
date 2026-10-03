import { describe, expect, test } from "bun:test";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, type ExecOptions, type ExecResult } from "./exec";
import { setSeedBusy, setSeedRoots } from "./seedgit";
import { shipConfig, shipper, type ShipDeps } from "./shipper";

interface Call { cmd: string[]; opts: ExecOptions }
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const no = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });

/** `answer` is what every command says; with `realGit` git runs for real
 *  (the deploy's clone of a real seed) and only the rest is answered */
function fakes(
  answer: (c: Call) => ExecResult | Promise<ExecResult>,
  http: (url: string, method: string) => Response = () => new Response("{}", { status: 200 }),
  realGit = false,
) {
  const calls: Call[] = [];
  const fetched: { url: string; method: string; auth: string | null; redirect?: string; body?: string }[] = [];
  const deps: ShipDeps = {
    exec: async (cmd, opts = {}) => {
      const c = { cmd, opts };
      calls.push(c);
      return realGit && cmd[0] === "git" ? exec(cmd, opts) : answer(c);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? init.body : undefined;
      fetched.push({ url, method, auth: new Headers(init?.headers).get("authorization"), redirect: init?.redirect, ...(body ? { body } : {}) });
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

/** a real seed: a git repo with these files committed */
async function seedWith(files: Record<string, string>): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "canopy-ship-seed-"));
  const run = async (...args: string[]): Promise<void> => {
    const r = await exec(["git", ...args], { cwd: dir });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  await run("init", "-q", "-b", "main");
  for (const [rel, text] of Object.entries(files)) {
    await mkdir(join(dir, rel, ".."), { recursive: true });
    await writeFile(join(dir, rel), text);
  }
  await run("add", "-A");
  await run("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "seed", "--allow-empty");
  return dir;
}

describe("project", () => {
  test("the first project name Vercel does not have yet, made there before the link", async () => {
    const f = fakes(
      () => ok(),
      (url, method) => new Response("{}", { status: method === "POST" ? 200 : url.endsWith("/v9/projects/coin-counter") ? 200 : 404 }),
    );
    expect(await shipper(cfg, f.deps).project("coin-counter", await seedWith({}))).toBe("coin-counter-2");
    expect(f.fetched.map((x) => `${x.method} ${x.url}`)).toEqual([
      "GET https://api.vercel.com/v9/projects/coin-counter",
      "GET https://api.vercel.com/v9/projects/coin-counter-2",
      "POST https://api.vercel.com/v11/projects",
    ]);
    expect(f.fetched.every((x) => x.auth === "Bearer tok_secret")).toBe(true);
    // no package.json says which framework, so none is sent
    expect(f.fetched.at(-1)?.body).toBe(JSON.stringify({ name: "coin-counter-2" }));
  });
  test("a name another account took between the read and the make goes on to the next", async () => {
    const f = fakes(
      () => ok(),
      (url, method) => new Response("{}", { status: method === "POST" ? (f.fetched.filter((x) => x.method === "POST").length === 1 ? 409 : 200) : 404 }),
    );
    expect(await shipper(cfg, f.deps).project("coin-counter", await seedWith({}))).toBe("coin-counter-2");
  });
  test("a Vite app is made as one, and a Next app as Next", async () => {
    const make = async (pkg: Record<string, unknown>): Promise<unknown> => {
      const f = fakes(() => ok(), (_url, method) => new Response("{}", { status: method === "POST" ? 200 : 404 }));
      await shipper(cfg, f.deps).project("app", await seedWith({ "package.json": JSON.stringify(pkg) }));
      return JSON.parse(f.fetched.find((x) => x.method === "POST")?.body ?? "null");
    };
    expect(await make({ devDependencies: { vite: "^7.0.0" } })).toEqual({ name: "app", framework: "vite" });
    expect(await make({ dependencies: { next: "16.0.0", react: "19" } })).toEqual({ name: "app", framework: "nextjs" });
    expect(await make({ dependencies: { express: "5" } })).toEqual({ name: "app" });
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
    const head = "c".repeat(40);
    const bundled: string[] = [];
    const deps: ShipDeps = {
      ...f.deps,
      bundle: async (seedPath, file) => {
        bundled.push(seedPath);
        await writeFile(file, "a bundle");
        return { head };
      },
    };
    await expect(shipper(cfg, deps).push("/seed", "eric/x")).rejects.toThrow("git push: rejected: non-fast-forward");
    expect(bundled).toEqual(["/seed"]);
    for (const c of f.calls) {
      expect(c.cmd).toContain("core.hooksPath=/dev/null");
      expect(c.cmd).toContain("core.fsmonitor=false");
      expect(c.opts.env?.["GIT_TERMINAL_PROMPT"]).toBe("0");
    }
    // the clone is of the bundle, never of the seed, and the push is the bundle's HEAD
    const clone = f.calls[0]?.cmd ?? [];
    expect(clone.slice(clone.indexOf("clone"), -2)).toEqual(["clone", "--bare", "--quiet", "--"]);
    expect(clone.at(-2)).toEndWith("/seed.bundle");
    expect(f.calls.some((c) => c.cmd.includes("/seed"))).toBe(false);
    expect(f.calls.find((c) => c.cmd.includes("push"))?.cmd.slice(-2)).toEqual(["origin", `${head}:refs/heads/main`]);
  });
});

describe("a seed whose config canopy will not run", () => {
  test("push and deploy refuse it before any clone, naming the key", async () => {
    const seeds = join(await mkdtemp(join(tmpdir(), "canopy-ship-guard-")), "_incubator");
    const dir = join(seeds, "coin");
    await mkdir(dir, { recursive: true });
    expect((await exec(["git", "init", "-q", "-b", "main"], { cwd: dir })).code).toBe(0);
    expect((await exec(["git", "config", "core.fsmonitor", "/bin/true"], { cwd: dir })).code).toBe(0);
    setSeedRoots([seeds]);
    try {
      const f = fakes(() => ok(), () => new Response(JSON.stringify({ id: "prj_1", accountId: "team_1" }), { status: 200 }));
      await expect(shipper(cfg, f.deps).push(dir, "eric/coin")).rejects.toThrow("core.fsmonitor");
      await expect(shipper(cfg, f.deps).deploy(dir, "coin")).rejects.toThrow("core.fsmonitor");
      expect(f.calls.filter((c) => c.cmd.includes("clone"))).toHaveLength(0);
    } finally {
      setSeedRoots([]);
    }
  });
});

describe("a seed while a stage is alive", () => {
  test("push waits for the seed to go quiet before it bundles the seed", async () => {
    const seeds = join(await mkdtemp(join(tmpdir(), "canopy-ship-busy-")), "_incubator");
    const dir = join(seeds, "coin");
    await mkdir(dir, { recursive: true });
    expect((await exec(["git", "init", "-q", "-b", "main"], { cwd: dir })).code).toBe(0);
    const commit = ["git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "--allow-empty", "-m", "one"];
    expect((await exec(commit, { cwd: dir })).code).toBe(0);
    let busy = true;
    setSeedRoots([seeds]);
    setSeedBusy(() => busy);
    try {
      const f = fakes(() => ok());
      const pushing = shipper(cfg, f.deps)
        .push(dir, "eric/coin")
        .then(
          () => "pushed",
          (e: unknown) => String(e),
        );
      await Bun.sleep(600);
      expect(f.calls.filter((c) => c.cmd.includes("clone"))).toHaveLength(0);
      busy = false;
      expect(await pushing).toBe("pushed");
      expect(f.calls.filter((c) => c.cmd.includes("clone"))).toHaveLength(1);
    } finally {
      setSeedBusy(() => false);
      setSeedRoots([]);
    }
  });
});

describe("deploy", () => {
  const PROJECT = JSON.stringify({ id: "prj_123", accountId: "team_456" });
  const INTENT = "# Coin counter\n\n## What the user said\n\nCount coins.\n";
  const deployed = (c: Call): ExecResult => (c.cmd[1] === "deploy" ? ok("Vercel CLI 61.1.0\nhttps://coin-counter-abc-eric.vercel.app\n") : ok());
  /** the API's answers: the project, then the deployment with these aliases; every other url is the app */
  const api =
    (aliases: string[], app: (url: string) => Response, deployment = 200) =>
    (url: string): Response => {
      if (url.includes("/v9/projects/")) return new Response(PROJECT, { status: 200 });
      if (url.includes("/v13/deployments/")) return new Response(JSON.stringify({ alias: aliases }), { status: deployment });
      return app(url);
    };
  const page = (url: string): Response => (url.endsWith("/.canopy/intent.md") ? new Response("not found", { status: 404 }) : new Response("<html>", { status: 200 }));
  const PROD = ["coin-counter.vercel.app", "coin-counter-eric.vercel.app"];
  const seed = () => seedWith({ "index.html": "<p>ok</p>\n", ".canopy/intent.md": INTENT });
  const vercelCalls = (f: { calls: Call[] }) => f.calls.filter((c) => c.cmd[0] === "vercel");

  test("link and deploy from a clone with the project pinned, read the aliases, smoke the production url; the token only in the env", async () => {
    const f = fakes(deployed, api(PROD, page), true);
    const dir = await seed();
    expect(await shipper(cfg, f.deps).deploy(dir, "coin-counter")).toBe("https://coin-counter.vercel.app");
    const v = vercelCalls(f);
    expect(v.map((c) => c.cmd.slice(0, 2).join(" "))).toEqual(["vercel link", "vercel deploy"]);
    for (const c of v) {
      expect(c.cmd.join(" ")).not.toContain("tok_secret");
      expect(c.opts.env?.["VERCEL_TOKEN"]).toBe("tok_secret");
      expect(c.opts.env?.["VERCEL_ORG_ID"]).toBe("team_456");
      expect(c.opts.env?.["VERCEL_PROJECT_ID"]).toBe("prj_123");
      // never the seed itself, and the clone is gone after
      expect(c.opts.cwd).not.toBe(dir);
      expect(c.opts.cwd && existsSync(c.opts.cwd)).toBe(false);
    }
    expect(f.calls.filter((c) => c.cmd[0] === "git").every((c) => c.cmd.includes("core.hooksPath=/dev/null"))).toBe(true);
    expect(f.calls.find((c) => c.cmd.includes("clone"))?.opts.env?.["GIT_LFS_SKIP_SMUDGE"]).toBe("1");
    // the clone is of a bundle of the seed, checked out at the seed's HEAD, detached
    const clone = f.calls.find((c) => c.cmd.includes("clone"))?.cmd ?? [];
    expect(clone.at(-2)).toEndWith("/seed.bundle");
    expect(f.calls.some((c) => c.cmd.includes(dir))).toBe(false);
    const head = (await exec(["git", "rev-parse", "HEAD"], { cwd: dir })).stdout.trim();
    expect(f.calls.find((c) => c.cmd.includes("checkout"))?.cmd.slice(-3)).toEqual(["-q", "--detach", head]);
    expect(f.fetched.map((x) => x.url)).toEqual([
      "https://api.vercel.com/v9/projects/coin-counter",
      "https://api.vercel.com/v13/deployments/coin-counter-abc-eric.vercel.app",
      "https://coin-counter.vercel.app",
      "https://coin-counter.vercel.app/.canopy/intent.md",
    ]);
    // the smoke GETs go to the public page without the token
    expect(f.fetched.slice(2).every((x) => x.auth === null)).toBe(true);
  });

  test("a deployment the API lists no vercel.app alias for goes live on its own hash url, which is what the smoke GET hits", async () => {
    // why the previews-only PATCH below stays: Standard Protection guards this url
    const f = fakes(deployed, api([], page), true);
    expect(await shipper(cfg, f.deps).deploy(await seed(), "coin-counter")).toBe("https://coin-counter-abc-eric.vercel.app");
    expect(f.fetched.map((x) => x.url).slice(2)).toEqual([
      "https://coin-counter-abc-eric.vercel.app",
      "https://coin-counter-abc-eric.vercel.app/.canopy/intent.md",
    ]);
  });

  describe("Vercel Authentication", () => {
    /** the project read with this ssoProtection (omitted when undefined); a PATCH answers `patch` */
    const withSso = (sso: unknown, patch = 200) => (url: string, method: string): Response => {
      if (method === "PATCH") return new Response("{}", { status: patch });
      if (url.includes("/v9/projects/")) return new Response(JSON.stringify({ id: "prj_123", accountId: "team_456", ...(sso === undefined ? {} : { ssoProtection: sso }) }), { status: 200 });
      return api(PROD, page)(url);
    };
    const patches = (f: { fetched: { method: string; url: string; body?: string }[] }) => f.fetched.filter((x) => x.method === "PATCH");

    for (const type of ["prod_deployment_urls_and_all_previews", "all"]) {
      test(`${type} is set to previews only, once, before the first exec`, async () => {
        let patchedBeforeExec = false;
        const f = fakes(
          (c) => {
            patchedBeforeExec ||= patches(f).length === 1;
            return deployed(c);
          },
          withSso({ deploymentType: type }),
          true,
        );
        await shipper(cfg, f.deps).deploy(await seed(), "coin-counter");
        expect(patches(f).map((x) => `${x.url} ${x.body}`)).toEqual(['https://api.vercel.com/v9/projects/prj_123 {"ssoProtection":{"deploymentType":"preview"}}']);
        expect(f.fetched.find((x) => x.method === "PATCH")?.auth).toBe("Bearer tok_secret");
        expect(patchedBeforeExec).toBe(true);
      });
    }

    for (const [name, sso] of [["null", null], ["absent", undefined], ["already preview", { deploymentType: "preview" }]] as const) {
      test(`${name} sends no PATCH`, async () => {
        const f = fakes(deployed, withSso(sso), true);
        await shipper(cfg, f.deps).deploy(await seed(), "coin-counter");
        expect(patches(f)).toEqual([]);
      });
    }

    test("a PATCH answering 403 throws before any clone, and the error holds no token", async () => {
      const f = fakes(deployed, withSso({ deploymentType: "all" }, 403), true);
      const err = await shipper(cfg, f.deps).deploy(await seed(), "coin-counter").then(() => null, (e: unknown) => e);
      expect(err).toBeInstanceOf(Error);
      const msg = (err as Error).message;
      expect(msg).toContain("403");
      expect(msg).toContain("login");
      expect(msg).not.toContain("tok_secret");
      expect(f.calls).toEqual([]);
    });
  });

  test("before the link .vercel/ is gone and .vercelignore ends with .canopy/", async () => {
    const seen: { vercel?: boolean; ignore?: string } = {};
    const f = fakes(
      async (c) => {
        if (c.cmd[1] === "link" && c.opts.cwd) {
          seen.vercel = existsSync(join(c.opts.cwd, ".vercel"));
          seen.ignore = await readFile(join(c.opts.cwd, ".vercelignore"), "utf8");
        }
        return deployed(c);
      },
      api(PROD, page),
      true,
    );
    const dir = await seedWith({
      "index.html": "<p>ok</p>\n",
      ".canopy/intent.md": INTENT,
      ".vercel/project.json": JSON.stringify({ orgId: "team_other", projectId: "prj_other" }),
      ".vercelignore": ".canopy/\n!.canopy/intent.md\nnotes/\n",
    });
    await shipper(cfg, f.deps).deploy(dir, "coin-counter");
    expect(vercelCalls(f).map((c) => c.cmd[1])).toEqual(["link", "deploy"]);
    expect(seen.vercel).toBe(false);
    expect(seen.ignore).toBe("!.canopy/intent.md\nnotes/\n.canopy/\n");
    // the seed itself keeps what it had
    expect(existsSync(join(dir, ".vercel", "project.json"))).toBe(true);
  });

  test("a vercel.json with alias or a key off the list, or another Vercel config, is refused before vercel runs", async () => {
    const refused = async (files: Record<string, string>): Promise<string> => {
      const f = fakes(deployed, api(PROD, page), true);
      const err = await shipper(cfg, f.deps)
        .deploy(await seedWith({ "index.html": "x", ...files }), "p")
        .then(() => "deployed")
        .catch((e: Error) => e.message);
      expect(vercelCalls(f)).toHaveLength(0);
      return err;
    };
    expect(await refused({ "vercel.json": JSON.stringify({ alias: ["eric.example.com"] }) })).toContain("vercel.json sets alias");
    expect(await refused({ "vercel.json": JSON.stringify({ buildCommand: "bun run build", scope: "other-team" }) })).toContain("vercel.json sets scope");
    expect(await refused({ "vercel.ts": "export default {}" })).toContain("vercel.ts is a Vercel config canopy does not read");
    expect(await refused({ "vercel.json": "{" })).toBe("vercel.json is not JSON");
  });
  test("a vercel.json on the list deploys", async () => {
    const f = fakes(deployed, api(PROD, page), true);
    const dir = await seedWith({ "index.html": "x", ".canopy/intent.md": INTENT, "vercel.json": JSON.stringify({ framework: "vite", outputDirectory: "dist", rewrites: [] }) });
    expect(await shipper(cfg, f.deps).deploy(dir, "p")).toBe("https://coin-counter.vercel.app");
  });

  test("a project the API cannot name by id and team is never deployed", async () => {
    const f = fakes(deployed, (url) => (url.includes("/v9/projects/") ? new Response(JSON.stringify({ name: "p" }), { status: 200 }) : page(url)), true);
    await expect(shipper(cfg, f.deps).deploy(await seed(), "p")).rejects.toThrow("will not deploy it blind");
    expect(vercelCalls(f)).toHaveLength(0);
  });

  test("an alias off vercel.app parks, and so does a deployment the API will not describe", async () => {
    const f = fakes(deployed, api([...PROD, "coins.eric.example"], page), true);
    await expect(shipper(cfg, f.deps).deploy(await seed(), "p")).rejects.toThrow("the deploy is also at coins.eric.example, which is not a vercel.app address");
    const g = fakes(deployed, api(PROD, page, 500), true);
    await expect(shipper(cfg, g.deps).deploy(await seed(), "p")).rejects.toThrow("the Vercel API answered 500 for the deployment");
  });

  test("a deploy that serves .canopy/intent.md parks; a 404 or the app's own page for it is live", async () => {
    const serving = (intent: (url: string) => Response) => (url: string) => (url.endsWith("/.canopy/intent.md") ? intent(url) : new Response("<html>", { status: 200 }));
    const leak = fakes(deployed, api(PROD, serving(() => new Response(INTENT, { status: 200 }))), true);
    await expect(shipper(cfg, leak.deps).deploy(await seed(), "p")).rejects.toThrow("the deploy serves the repo root; .canopy/ is public");
    const gone = fakes(deployed, api(PROD, serving(() => new Response("not found", { status: 404 }))), true);
    expect(await shipper(cfg, gone.deps).deploy(await seed(), "p")).toBe("https://coin-counter.vercel.app");
    // a single-page app answers every path with its index.html
    const spa = fakes(deployed, api(PROD, serving(() => new Response("<!doctype html><div id=root>", { status: 200 }))), true);
    expect(await shipper(cfg, spa.deps).deploy(await seed(), "p")).toBe("https://coin-counter.vercel.app");
  });

  test("a production url behind protection fails with the reason; no token fails before anything runs", async () => {
    const f = fakes(deployed, api(PROD, () => new Response("{}", { status: 401 })), true);
    await expect(shipper(cfg, f.deps).deploy(await seed(), "p")).rejects.toThrow("answers 401: Vercel's deployment protection may cover it");
    const none = fakes(deployed);
    await expect(shipper(shipConfig({}, "mini"), none.deps).deploy("/seed", "p")).rejects.toThrow("add VERCEL_TOKEN to mini's .env");
    expect(none.calls).toHaveLength(0);
  });
  const redirect = (status: number, location: string) => new Response(null, { status, headers: { location } });
  test("a redirect off the production host is refused and never followed", async () => {
    const f = fakes(deployed, api(PROD, () => redirect(307, "https://vercel.com/login?next=x")), true);
    await expect(shipper(cfg, f.deps).deploy(await seed(), "p")).rejects.toThrow("sends visitors on to vercel.com");
    expect(f.fetched.some((x) => x.url.includes("//vercel.com"))).toBe(false);
    expect(f.fetched.at(-1)?.redirect).toBe("manual");
  });
  test("a redirect with no usable location is refused", async () => {
    const f = fakes(deployed, api(PROD, () => new Response(null, { status: 302 })), true);
    await expect(shipper(cfg, f.deps).deploy(await seed(), "p")).rejects.toThrow("sends visitors on to an address it does not name");
  });
  test("a same-host redirect is followed by hand", async () => {
    const f = fakes(deployed, api([], (url) => (url.endsWith("/home") ? new Response("<html>", { status: 200 }) : redirect(308, "/home"))), true);
    expect(await shipper(cfg, f.deps).deploy(await seed(), "p")).toBe("https://coin-counter-abc-eric.vercel.app");
    expect(f.fetched.filter((x) => !x.url.includes("api.vercel.com")).every((x) => x.redirect === "manual")).toBe(true);
  });
  test("six same-host hops are a loop", async () => {
    const f = fakes(deployed, api(PROD, () => redirect(307, "/again")), true);
    await expect(shipper(cfg, f.deps).deploy(await seed(), "p")).rejects.toThrow("redirects in a loop");
  });
  test("a failed deploy never echoes the token", async () => {
    const f = fakes((c) => (c.cmd[1] === "deploy" ? no("auth failed for tok_secret here") : ok()), api(PROD, page), true);
    const err = await shipper(cfg, f.deps).deploy(await seed(), "p").catch((e: Error) => e.message);
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
    project = await ship.project(name, dir);
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
