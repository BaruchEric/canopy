import { describe, expect, test } from "bun:test";
import { childEnv, chunkB64, encodeFrame, fromB64, lineSplitter, parseFrame, requestRefusal, StageAwayError, STAGE_AWAY } from "./stagewire";

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
  test("hello and exit frames parse, with their fields checked", () => {
    expect(parseFrame('{"t":"hello"}')).toEqual({ t: "hello" });
    expect(parseFrame('{"t":"hello","harnesses":["claude"]}')).toEqual({ t: "hello", harnesses: ["claude"] });
    expect(parseFrame('{"t":"hello","harnesses":[1]}')).toBe(null);
    expect(parseFrame('{"t":"exit","code":null}')).toEqual({ t: "exit", code: null });
    expect(parseFrame('{"t":"exit","code":"0"}')).toBe(null);
  });
  test("the away error carries its message and name", () => {
    const e = new StageAwayError();
    expect(e.message).toBe(STAGE_AWAY);
    expect(e.name).toBe("StageAwayError");
    expect(e instanceof Error).toBe(true);
  });
});
