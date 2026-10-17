import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallerBook } from "../server/callers";
import { startServer } from "../server/index";
import { apiBase, callerHeaders, callerToken, setHomeBase, setTokenFlag, tokenFile } from "./api";
import { ask } from "./health";

let scratch: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_TOKEN", "CANOPY_API", "CANOPY_TMUX", "CANOPY_CALLERS", "CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS"];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-cliapi-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "cfg");
  delete process.env["CANOPY_TOKEN"];
  delete process.env["CANOPY_API"];
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  setTokenFlag(undefined);
  await rm(scratch, { recursive: true, force: true });
});

describe("apiBase", () => {
  test("the given origin, else CANOPY_API, else the local default, without trailing slashes", () => {
    expect(apiBase()).toBe("http://127.0.0.1:7850");
    process.env["CANOPY_API"] = "http://mini:7850//";
    expect(apiBase()).toBe("http://mini:7850");
    expect(apiBase("http://other:1/")).toBe("http://other:1");
    delete process.env["CANOPY_API"];
  });
});

describe("tokenFile", () => {
  test("named for the host and port, with the scheme's default port when none is given", () => {
    expect(tokenFile("http://127.0.0.1:7850/")).toBe(join(scratch, "cfg", "token-127.0.0.1-7850"));
    expect(tokenFile("http://mini")).toBe(join(scratch, "cfg", "token-mini-80"));
    expect(tokenFile("https://canopy.example.ca")).toBe(join(scratch, "cfg", "token-canopy.example.ca-443"));
  });
});

describe("callerToken", () => {
  const base = "http://127.0.0.1:7850";
  const file = () => tokenFile(base);

  test("the flag first, then the file, then the environment", async () => {
    await mkdir(join(scratch, "cfg"), { recursive: true });
    process.env["CANOPY_TOKEN"] = "from-env";
    expect(callerToken(base)).toBe("from-env");
    await writeFile(file(), "from-file\n");
    expect(callerToken(base)).toBe("from-file");
    expect(callerToken(base, "from-flag")).toBe("from-flag");
    setTokenFlag("global-flag");
    expect(callerToken(base)).toBe("global-flag");
    setTokenFlag(undefined);
  });

  test("a file holding only whitespace counts as no token", async () => {
    await writeFile(file(), " \n\t\n");
    delete process.env["CANOPY_TOKEN"];
    expect(callerToken(base)).toBeNull();
    process.env["CANOPY_TOKEN"] = "from-env";
    expect(callerToken(base)).toBe("from-env");
    delete process.env["CANOPY_TOKEN"];
    await rm(file(), { force: true });
  });

  test("callerHeaders sets the header only with a token, and keeps the extra headers", () => {
    const bare = callerHeaders(base, undefined, { "content-type": "application/json" });
    expect(bare.has("x-canopy-token")).toBe(false);
    expect(bare.get("content-type")).toBe("application/json");
    const withToken = callerHeaders(base, "cnp_cli_x", { "content-type": "application/json" });
    expect(withToken.get("x-canopy-token")).toBe("cnp_cli_x");
    expect(withToken.get("content-type")).toBe("application/json");
  });
});

describe("a token goes only where it was meant", () => {
  test("the flag and the environment reach the home base, a peer needs its own file", async () => {
    const home = "http://127.0.0.1:7850";
    const peer = "http://mini:7850";
    process.env["CANOPY_TOKEN"] = "from-env";
    setTokenFlag("from-flag");
    expect(callerHeaders(home).get("x-canopy-token")).toBe("from-flag");
    expect(callerHeaders(peer).has("x-canopy-token")).toBe(false);
    setTokenFlag(undefined);
    expect(callerHeaders(home).get("x-canopy-token")).toBe("from-env");
    expect(callerHeaders(peer).has("x-canopy-token")).toBe(false);
    setHomeBase(peer);
    expect(callerHeaders(peer).get("x-canopy-token")).toBe("from-env");
    expect(callerHeaders(home).has("x-canopy-token")).toBe(false);
    setHomeBase(undefined);
    await mkdir(join(scratch, "cfg"), { recursive: true });
    await writeFile(tokenFile(peer), "peer-own\n");
    expect(callerHeaders(peer).get("x-canopy-token")).toBe("peer-own");
    await rm(tokenFile(peer), { force: true });
    delete process.env["CANOPY_TOKEN"];
  });
});

describe("a redirect never carries the token on", () => {
  test("the second stub never sees the header", async () => {
    const seen: (string | null)[] = [];
    const other = Bun.serve({ port: 0, fetch: (req) => (seen.push(req.headers.get("x-canopy-token")), Response.json({ ok: true })) });
    const first = Bun.serve({ port: 0, fetch: () => Response.redirect(`http://127.0.0.1:${other.port}/signin`, 302) });
    const a = `http://127.0.0.1:${first.port}`;
    try {
      process.env["CANOPY_TOKEN"] = "cnp_cli_env";
      setHomeBase(a);
      // the raw-fetch shape the commands use
      const res = await fetch(`${a}/api/x`, { redirect: "manual", headers: callerHeaders(a) });
      expect(res.status).toBe(302);
      await expect(ask({ name: "x", urls: [a] }, "GET", "/api/x")).rejects.toThrow("needs a sign-in");
      expect(seen).toEqual([]);
    } finally {
      setHomeBase(undefined);
      delete process.env["CANOPY_TOKEN"];
      first.stop(true);
      other.stop(true);
    }
  });
});

describe("ask against a stub", () => {
  test("a 403 with need is final, a 401 without need tries the next address", async () => {
    const hits: string[] = [];
    const seen: (string | null)[] = [];
    const stub = Bun.serve({
      port: 0,
      fetch(req) {
        const { pathname } = new URL(req.url);
        hits.push(pathname);
        seen.push(req.headers.get("x-canopy-token"));
        if (pathname === "/forbidden") return Response.json({ error: "this needs admin", need: "admin" }, { status: 403 });
        if (pathname === "/gate") return new Response("sign in", { status: 401 });
        return Response.json({ ok: true });
      },
    });
    try {
      const a = `http://127.0.0.1:${stub.port}`;
      const dead = "http://127.0.0.1:1";
      await expect(ask({ name: "x", urls: [a, `${a}/second`] }, "POST", "/forbidden", {})).rejects.toThrow("this needs admin");
      expect(hits).toEqual(["/forbidden"]);
      const two = await ask<{ ok: boolean }>({ name: "x", urls: [dead, a] }, "GET", "/fine");
      expect(two.ok).toBe(true);
      hits.length = 0;
      await expect(ask({ name: "x", urls: [a, a] }, "GET", "/gate")).rejects.toThrow("needs a sign-in");
      expect(hits).toEqual(["/gate", "/gate"]);
      // the stub is the home backend here, so the environment's token goes to it
      process.env["CANOPY_TOKEN"] = "cnp_cli_env";
      setHomeBase(a);
      await ask({ name: "x", urls: [a] }, "GET", "/fine");
      expect(seen.at(-1)).toBe("cnp_cli_env");
      setHomeBase(undefined);
      delete process.env["CANOPY_TOKEN"];
    } finally {
      stub.stop(true);
    }
  });
});

describe("canopy land against an enforce server", () => {
  let stop: () => void | Promise<void>;
  let port = 0;
  let cli = "";

  beforeAll(async () => {
    const config = join(scratch, "enforce");
    process.env["CANOPY_CONFIG_DIR"] = config;
    process.env["CANOPY_CALLERS"] = "enforce";
    process.env["CANOPY_TMUX"] = "0";
    delete process.env["CANOPY_BIND"];
    delete process.env["CANOPY_PUBLIC_ORIGIN"];
    const book = new CallerBook({ file: join(config, "callers.json") });
    cli = book.mint("cli", { label: "a test cli" }).token;
    await book.flush();
    const root = join(scratch, "root");
    await mkdir(root, { recursive: true });
    const s = await startServer({ root, port: 0, callersLog: () => {} });
    port = s.port;
    stop = s.stop;
  });
  afterAll(async () => {
    await stop();
  });

  const run = async (...extra: string[]): Promise<{ code: number; out: string }> => {
    const p = Bun.spawn(["bun", join(import.meta.dir, "../../bin/canopy.ts"), "land", "no-such-run", "--backend", `http://127.0.0.1:${port}`, ...extra], {
      env: { ...process.env, CANOPY_CONFIG_DIR: join(scratch, "elsewhere") },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
    return { code: await p.exited, out: o + e };
  };

  test("bare it exits 1 with the right it needed; with a minted token it gets past the check", async () => {
    const bare = await run();
    expect(bare.code).toBe(1);
    expect(bare.out).toContain("needs the operate right");
    const withToken = await run("--token", cli);
    expect(withToken.code).toBe(1);
    expect(withToken.out.trim()).toBe("no branch run by that id");
  });
});
