import { describe, expect, test } from "bun:test";
import { childEnv, chunkB64, encodeFrame, fromB64, gitEnv, lineSplitter, parseFrame, requestRefusal, StageAwayError, STAGE_AWAY, type StageRequest } from "./stagewire";

describe("stage wire", () => {
  test("frames round-trip one per line", () => {
    const f = { t: "out", d: Buffer.from("hé\n").toString("base64") } as const;
    const line = encodeFrame(f);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseFrame(line)).toEqual(f);
  });
  test("a frame that is not one of ours is null", () => {
    expect(parseFrame("{}")).toBe(null);
    expect(parseFrame("nope")).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "out", d: 3 }))).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "spawn", argv: "sh", cwd: "/x", env: {} }))).toBe(null);
  });
  test("the runner starts only claude, codex or sh, by bare name", () => {
    const ok = { t: "spawn" as const, argv: ["claude", "-p"], cwd: "/s/coin", env: {} };
    expect(requestRefusal(ok)).toBe(null);
    for (const argv0 of ["/bin/sh", "bun", "../claude", "claude ", ""]) {
      expect(requestRefusal({ ...ok, argv: [argv0] })).toContain("program");
    }
    expect(requestRefusal({ ...ok, argv: [] })).toContain("program");
    expect(requestRefusal({ ...ok, cwd: "relative" })).toContain("cwd");
    expect(requestRefusal({ t: "hello" })).toBe(null);
  });
  test("the child env is the runner's base plus three names, whatever canopy sends", () => {
    const own = { PATH: "/usr/bin", HOME: "/home/bun", CLAUDE_CONFIG_DIR: "/c", SECRET: "no", GH_TOKEN: "no" };
    const asked = { CANOPY_RUN: "r1", CANOPY_REPO: "_incubator/coin", GH_TOKEN: "ghp_x", VERCEL_TOKEN: "v", PATH: "/evil", LD_PRELOAD: "/x.so" };
    expect(childEnv(own, asked)).toEqual({ PATH: "/usr/bin", HOME: "/home/bun", CLAUDE_CONFIG_DIR: "/c", CANOPY_RUN: "r1", CANOPY_REPO: "_incubator/coin" });
  });
  test("big output goes in 64 KiB slices", () => {
    const bytes = new Uint8Array(150_000).fill(65);
    const parts = chunkB64(bytes);
    expect(parts).toHaveLength(3);
    expect(Buffer.concat(parts.map((p) => Buffer.from(p, "base64"))).equals(Buffer.from(bytes))).toBe(true);
    expect(fromB64(parts[0] ?? "")).toHaveLength(65536);
  });
  test("the splitter keeps a partial line for the next chunk", () => {
    const split = lineSplitter();
    expect(split('{"t":"ex')).toEqual([]);
    expect(split('it","code":0}\n{"t":"eo')).toEqual(['{"t":"exit","code":0}']);
    expect(split('f"}\n')).toEqual(['{"t":"eof"}']);
  });
  test("busy: a request names a seed, the answer says whether it is busy", () => {
    const q = { t: "busy", seed: "/s/coin" } as const;
    expect(parseFrame(encodeFrame(q))).toEqual(q);
    const a = { t: "busy", busy: true } as const;
    expect(parseFrame(encodeFrame(a))).toEqual(a);
    expect(parseFrame(JSON.stringify({ t: "busy" }))).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "busy", busy: "yes" }))).toBe(null);
    expect(requestRefusal(q)).toBe(null);
    expect(requestRefusal({ t: "busy", seed: "coin" })).toContain("seed");
  });
  test("git: a request names a seed, its args and an env of git's own names only", () => {
    const q: Extract<StageRequest, { t: "git" }> = { t: "git", seed: "/s/coin", args: ["status", "--porcelain=v2"], env: { GIT_OPTIONAL_LOCKS: "0" } };
    expect(parseFrame(encodeFrame(q))).toEqual(q);
    expect(parseFrame(JSON.stringify({ t: "git", seed: "/s/coin", args: "status", env: {} }))).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "git", seed: "/s/coin", args: ["status"], env: { A: 1 } }))).toBe(null);
    expect(requestRefusal(q)).toBe(null);
    expect(requestRefusal({ ...q, seed: "coin" })).toContain("seed");
    // a name the runner would drop changes what git writes: refused, never dropped
    for (const name of ["GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_CONFIG_COUNT", "PATH", "GH_TOKEN"]) {
      expect(requestRefusal({ ...q, env: { [name]: "x" } })).toContain(name);
    }
  });
  test("a git request's env is the runner's own: no global or system config, a ceiling at the stage root", () => {
    const own = { PATH: "/usr/bin", HOME: "/home/bun", LANG: "C.UTF-8", GH_TOKEN: "no", CLAUDE_CONFIG_DIR: "/c" };
    const asked = { GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "canopy", GIT_INDEX_FILE: "/tmp/i", HOME: "/evil" };
    expect(gitEnv(own, asked, "/s")).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/nonexistent",
      XDG_CONFIG_HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CEILING_DIRECTORIES: "/s",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "canopy",
    });
  });
  test("hello and exit frames parse, with their fields checked", () => {
    expect(parseFrame('{"t":"hello"}')).toEqual({ t: "hello" });
    // a runner from before the fence says nothing of it, and reads as unchecked
    expect(parseFrame('{"t":"hello","harnesses":["claude"]}')).toEqual({ t: "hello", harnesses: ["claude"], fenced: "unchecked" });
    expect(parseFrame('{"t":"hello","harnesses":["claude"],"fenced":"yes"}')).toEqual({ t: "hello", harnesses: ["claude"], fenced: "unchecked" });
    expect(parseFrame('{"t":"hello","harnesses":[],"fenced":true}')).toEqual({ t: "hello", harnesses: [], fenced: true });
    expect(parseFrame('{"t":"hello","harnesses":[],"fenced":false,"reason":"the fence is down: http://x/ answered"}')).toEqual({
      t: "hello",
      harnesses: [],
      fenced: false,
      reason: "the fence is down: http://x/ answered",
    });
    expect(parseFrame('{"t":"hello","harnesses":[1]}')).toBe(null);
    expect(parseFrame('{"t":"exit","code":null}')).toEqual({ t: "exit", code: null });
    // a refusal keeps fenced only when it says the fence is why
    expect(parseFrame('{"t":"refused","reason":"r","fenced":"unchecked"}')).toEqual({ t: "refused", reason: "r", fenced: "unchecked" });
    expect(parseFrame('{"t":"refused","reason":"r","fenced":true}')).toEqual({ t: "refused", reason: "r" });
    expect(parseFrame('{"t":"exit","code":"0"}')).toBe(null);
  });
  test("the away error carries its message and name", () => {
    const e = new StageAwayError();
    expect(e.message).toBe(STAGE_AWAY);
    expect(e.name).toBe("StageAwayError");
    expect(e instanceof Error).toBe(true);
  });
});
