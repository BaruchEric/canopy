import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startServer } from "../server/index";
import { helperTokenFile } from "./api";
import { pairFlow } from "./auth";

let scratch: string;
let port = 0;
let stop: () => void | Promise<void>;
const lines: string[] = [];
const saved: Record<string, string | undefined> = {};
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_TOKEN", "CANOPY_API", "CANOPY_TMUX", "CANOPY_CALLERS", "CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS"];

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-auth-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "server");
  process.env["CANOPY_CALLERS"] = "enforce";
  process.env["CANOPY_TMUX"] = "0";
  delete process.env["CANOPY_TOKEN"];
  delete process.env["CANOPY_API"];
  delete process.env["CANOPY_BIND"];
  delete process.env["CANOPY_PUBLIC_ORIGIN"];
  await mkdir(join(scratch, "root"), { recursive: true });
  const s = await startServer({ root: join(scratch, "root"), port: 0, callersLog: (l) => lines.push(l) });
  port = s.port;
  stop = s.stop;
});

afterAll(async () => {
  await stop();
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

const base = (): string => `http://127.0.0.1:${port}`;
const clientFile = (): string => join(scratch, "client", `token-127.0.0.1-${port}`);

const firstCode = (): string => {
  const m = /first sign-in code (\S+) /.exec(lines.find((l) => l.includes("first sign-in code")) ?? "");
  if (!m?.[1]) throw new Error("the server printed no first code");
  return m[1];
};

const cli = async (...args: string[]): Promise<{ code: number; out: string }> => {
  const p = Bun.spawn(["bun", join(import.meta.dir, "../../bin/canopy.ts"), ...args], {
    env: { ...process.env, CANOPY_CONFIG_DIR: join(scratch, "client") },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [o, e] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code: await p.exited, out: o + e };
};

describe("canopy auth against an enforce server", () => {
  test("login with the first code writes a 0600 token file, and land gets past the check", async () => {
    const bare = await cli("land", "no-such-run", "--backend", base());
    expect(bare.code).toBe(1);
    expect(bare.out).toContain("needs the operate right");
    const login = await cli("auth", "login", "--backend", base(), "--code", firstCode());
    expect(login.code).toBe(0);
    expect(login.out).toContain("signed in");
    expect((await stat(clientFile())).mode & 0o777).toBe(0o600);
    const land = await cli("land", "no-such-run", "--backend", base());
    expect(land.code).toBe(1);
    expect(land.out.trim()).toBe("no branch run by that id");
    const status = await cli("auth", "status", "--backend", base());
    expect(status.code).toBe(0);
    expect(status.out).toContain("enforce");
    expect(status.out).toContain("cli");
  });

  test("logout revokes the caller and removes the file; the old token gets 401", async () => {
    const token = (await readFile(clientFile(), "utf8")).trim();
    const out = await cli("auth", "logout", "--backend", base());
    expect(out.code).toBe(0);
    await expect(stat(clientFile())).rejects.toThrow();
    const res = await fetch(`${base()}/api/auth/ticket`, { method: "POST", headers: { "content-type": "application/json", "x-canopy-token": token }, body: JSON.stringify({ for: "term" }) });
    expect(res.status).toBe(401);
  });
});

describe("pairFlow", () => {
  test("a helper label claims a helper token; the window ends a pair nobody approves", async () => {
    const said: string[] = [];
    // the first code is spent by now, so nobody can approve: the window must end it
    await expect(pairFlow({ base: base(), label: "helper test", kind: "helper", poll: 5, window: 40, say: (l) => said.push(l) })).rejects.toThrow("timed out");
    expect(said.join("\n")).toContain("approve");
  });

  test("the request names its kind, whatever the label starts with", async () => {
    await expect(pairFlow({ base: base(), label: "laptop", kind: "cli", poll: 5, window: 40 })).rejects.toThrow("timed out");
    const auth = (await (await fetch(`${base()}/api/auth`)).json()) as { pending: { label: string; kind: string }[] };
    expect(auth.pending.find((p) => p.label === "laptop")?.kind).toBe("cli");
    expect(auth.pending.find((p) => p.label === "helper test")?.kind).toBe("helper");
  });

  test("helperTokenFile is named for the helper, host and port", () => {
    process.env["CANOPY_CONFIG_DIR"] = join(scratch, "client");
    expect(helperTokenFile("http://mini:7850/")).toBe(join(scratch, "client", "token-helper-mini-7850"));
    process.env["CANOPY_CONFIG_DIR"] = join(scratch, "server");
  });
});
