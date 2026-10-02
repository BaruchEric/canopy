import { describe, expect, test } from "bun:test";
import type { ExecOptions, ExecResult } from "./exec";
import { shipConfig, shipper, type ShipDeps } from "./shipper";

interface Call { cmd: string[]; opts: ExecOptions }
const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "" });
const no = (stderr = "nope"): ExecResult => ({ code: 1, stdout: "", stderr });

function fakes(answer: (c: Call) => ExecResult, http: (url: string, method: string) => Response = () => new Response("{}", { status: 200 })) {
  const calls: Call[] = [];
  const fetched: { url: string; method: string; auth: string | null }[] = [];
  const deps: ShipDeps = {
    exec: async (cmd, opts = {}) => {
      const c = { cmd, opts };
      calls.push(c);
      return answer(c);
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      fetched.push({ url, method, auth: new Headers(init?.headers).get("authorization") });
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
  test("origin added or reset, then HEAD to main, with hooks off and no prompt", async () => {
    const f = fakes((c) => (c.cmd.includes("get-url") ? no() : ok()));
    await shipper(cfg, f.deps).push("/seed", "eric/coin-counter");
    const git = f.calls.map((c) => c.cmd.filter((w) => !w.startsWith("core.") && w !== "-c").slice(1).join(" "));
    expect(git).toEqual(["remote get-url origin", "remote add origin https://github.com/eric/coin-counter.git", "push -u origin HEAD:refs/heads/main"]);
    for (const c of f.calls) {
      expect(c.cmd).toContain("core.hooksPath=/dev/null");
      expect(c.opts.cwd).toBe("/seed");
      expect(c.opts.env?.["GIT_TERMINAL_PROMPT"]).toBe("0");
    }
  });
  test("a refused push fails with git's words", async () => {
    const f = fakes((c) => (c.cmd.includes("push") ? no("rejected: non-fast-forward") : ok()));
    await expect(shipper(cfg, f.deps).push("/seed", "eric/x")).rejects.toThrow("git push: rejected: non-fast-forward");
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
  test("a production url that sends visitors to a sign-in page is not live", async () => {
    const f = fakes(deployed, (url) => {
      if (url.includes("api.vercel.com")) return new Response("{}", { status: 200 });
      const res = new Response("<html>sign in", { status: 200 });
      Object.defineProperty(res, "url", { value: "https://vercel.com/login?next=x" });
      return res;
    });
    await expect(shipper(cfg, f.deps).deploy("/seed", "p")).rejects.toThrow("sends visitors on to vercel.com");
  });
  test("ready reads the token and the CLI", () => {
    expect(shipper(cfg, fakes(() => ok()).deps).ready("vercel")).toBe(null);
    expect(shipper(shipConfig({}, "mini"), fakes(() => ok()).deps).ready("vercel")).toBe("add VERCEL_TOKEN to mini's .env");
  });
});
