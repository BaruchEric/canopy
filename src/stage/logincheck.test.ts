import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLogin, LoginProber, loginKey, loginOf, PROBE_AGAIN, PROBE_ARGS, PROBE_EVERY, probeResult, stageToken } from "./logincheck";
import type { LoginProbe } from "../core/stagewire";

const NOW = Date.UTC(2026, 10, 11, 20, 44);
/** shaped like what claude setup-token prints; not a real one */
const TOKEN = `sk-ant-oat01-${"a1B2_c3-".repeat(8)}`;
const DAY = 24 * 60 * 60_000;
const file = (oauth: Record<string, unknown>): string => JSON.stringify({ claudeAiOauth: oauth });

describe("loginOf", () => {
  test("a login with a refresh token is good until that token lapses", () => {
    const until = NOW + 20 * DAY;
    expect(loginOf(file({ accessToken: "a", refreshToken: "r", expiresAt: NOW - 1, refreshTokenExpiresAt: until }), NOW)).toEqual({ how: "login", until });
    // an older file names no lapse: still a login, with no day to show
    expect(loginOf(file({ accessToken: "a", refreshToken: "r", expiresAt: NOW - 1 }), NOW)).toEqual({ how: "login" });
  });

  test("a refresh token past its time is expired, on the day it lapsed", () => {
    const until = Date.UTC(2026, 10, 1, 14, 31, 59);
    expect(loginOf(file({ accessToken: "a", refreshToken: "r", expiresAt: NOW + DAY, refreshTokenExpiresAt: until }), NOW)).toEqual({ how: "expired", until });
  });

  test("the file claude leaves after a refresh fails, both tokens emptied, is expired", () => {
    // the mini's stages on 2026-11-11, as claude wrote it at 12:44
    const until = Date.UTC(2026, 10, 1, 14, 31, 59);
    expect(loginOf(file({ accessToken: "", refreshToken: "", expiresAt: 0, refreshTokenExpiresAt: until, scopes: ["user:inference"], subscriptionType: "max" }), NOW)).toEqual({ how: "expired", until });
    expect(loginOf(file({ accessToken: "", refreshToken: "" }), NOW)).toEqual({ how: "expired" });
  });

  test("an access token alone works until it lapses, then it is expired", () => {
    expect(loginOf(file({ accessToken: "a", expiresAt: NOW + DAY }), NOW)).toEqual({ how: "login", until: NOW + DAY });
    expect(loginOf(file({ accessToken: "a", expiresAt: NOW - DAY }), NOW)).toEqual({ how: "expired", until: NOW - DAY });
  });

  test("no file, or one claude could not sign in with, is no login", () => {
    expect(loginOf(null, NOW)).toEqual({ how: "none" });
    for (const text of ["", "not json", "[]", "{}", '{"claudeAiOauth":"x"}', '{"claudeAiOauth":null}']) expect(loginOf(text, NOW)).toEqual({ how: "none" });
  });

  test("only a state and a time come out, never a token", () => {
    const login = loginOf(file({ accessToken: "sk-ant-oat01-secret", refreshToken: "sk-ant-ort01-secret", expiresAt: NOW + 1, refreshTokenExpiresAt: NOW + DAY }), NOW);
    expect(JSON.stringify(login)).not.toContain("secret");
    expect(Object.keys(login).sort()).toEqual(["how", "until"]);
  });
});

describe("claudeLogin", () => {
  let dir = "";
  beforeAll(async () => {
    dir = await realpath(await mkdtemp(join(tmpdir(), "cs-login-")));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });
  const home = async (name: string, text?: string): Promise<string> => {
    const h = join(dir, name);
    await mkdir(h, { recursive: true });
    if (text !== undefined) await writeFile(join(h, ".credentials.json"), text);
    return h;
  };

  test("a token file beside the login is the login, whatever the login file holds", async () => {
    const h = await home("token", file({ accessToken: "", refreshToken: "" }));
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: h }, NOW, "linux")).toEqual({ how: "expired" });
    await writeFile(join(h, "oauth-token.txt"), `  ${TOKEN}\n`);
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: h }, NOW, "linux")).toEqual({ how: "token" });
    expect(await stageToken({ CLAUDE_CONFIG_DIR: h })).toBe(TOKEN);
    // on a Mac too: the file is the runner's own, not the Keychain's
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: h }, NOW, "darwin")).toEqual({ how: "token" });
  });

  test("a token file that is not one line of a token is no token", async () => {
    const h = await home("badtoken");
    for (const bad of ["", "  \n", "short", `${TOKEN}\nexport EVIL=1`, `two ${TOKEN}`, `${TOKEN}\u0000`, "x".repeat(5000)]) {
      await writeFile(join(h, "oauth-token.txt"), bad);
      expect(await stageToken({ CLAUDE_CONFIG_DIR: h })).toBe(null);
      expect(await claudeLogin({ CLAUDE_CONFIG_DIR: h }, NOW, "linux")).toEqual({ how: "none" });
    }
    // no folder named, no file, and a link in its place
    expect(await stageToken({})).toBe(null);
    expect(await stageToken({ CLAUDE_CONFIG_DIR: await home("notoken") })).toBe(null);
    const real = await home("realtoken");
    await writeFile(join(real, "oauth-token.txt"), TOKEN);
    const linked = await home("linkedtoken");
    await symlink(join(real, "oauth-token.txt"), join(linked, "oauth-token.txt"));
    expect(await stageToken({ CLAUDE_CONFIG_DIR: linked })).toBe(null);
  });

  test("the file under CLAUDE_CONFIG_DIR is read, else the one under HOME's .claude", async () => {
    const until = NOW + 9 * DAY;
    const h = await home("named", file({ accessToken: "a", refreshToken: "r", refreshTokenExpiresAt: until }));
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: h }, NOW, "linux")).toEqual({ how: "login", until });
    const under = await home(join("homed", ".claude"), file({ accessToken: "a", refreshToken: "r", refreshTokenExpiresAt: until }));
    expect(await claudeLogin({ HOME: join(under, "..") }, NOW, "linux")).toEqual({ how: "login", until });
  });

  test("no file is no login on Linux, and nothing said on a Mac, which keeps its login in the Keychain", async () => {
    const h = await home("empty");
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: h }, NOW, "linux")).toEqual({ how: "none" });
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: h }, NOW, "darwin")).toBeUndefined();
    // nowhere to look says nothing either
    expect(await claudeLogin({}, NOW, "linux")).toBeUndefined();
  });

  test("a link or a folder in the file's place is not followed: nothing is said", async () => {
    const real = await home("real", file({ accessToken: "a", refreshToken: "r" }));
    const linked = await home("linked");
    await symlink(join(real, ".credentials.json"), join(linked, ".credentials.json"));
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: linked }, NOW, "linux")).toBeUndefined();
    const folder = await home("folder");
    await mkdir(join(folder, ".credentials.json"));
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: folder }, NOW, "linux")).toBeUndefined();
  });

  test("a file larger than a login ever is says nothing", async () => {
    const h = await home("huge", `{"claudeAiOauth":{"accessToken":"${"a".repeat(70_000)}","refreshToken":"r"}}`);
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: h }, NOW, "linux")).toBeUndefined();
    // one byte past the limit is past it; the limit itself is read
    const pad = (n: number): string => `{"claudeAiOauth":{"accessToken":"a","refreshToken":"r"}}`.padEnd(n, " ");
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: await home("over", pad(64 * 1024 + 1)) }, NOW, "linux")).toBeUndefined();
    expect(await claudeLogin({ CLAUDE_CONFIG_DIR: await home("at", pad(64 * 1024)) }, NOW, "linux")).toEqual({ how: "login" });
  });
});

describe("the login check with Anthropic", () => {
  test("is one turn of the cheapest model, with the stages' own user settings and no MCP server", () => {
    expect(PROBE_ARGS[0]).toBe("-p");
    expect(PROBE_ARGS.join(" ")).toContain("--model haiku");
    expect(PROBE_ARGS.join(" ")).toContain("--max-turns 1");
    expect(PROBE_ARGS.join(" ")).toContain("--setting-sources user");
    expect(PROBE_ARGS).toContain("--strict-mcp-config");
    expect(PROBE_ARGS.join(" ")).not.toContain("sk-ant");
  });

  test("a turn back is ok; claude's words for a refused login are refused; anything else could not run", () => {
    expect(probeResult({ code: 0, out: "ok\n", err: "" }, NOW)).toEqual({ said: "ok", at: NOW });
    const revoked = 'Failed to authenticate. API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked."}}';
    expect(probeResult({ code: 1, out: `${revoked}\n`, err: "" }, NOW)).toEqual({ said: "refused", at: NOW, words: revoked });
    expect(probeResult({ code: 1, out: "", err: "Invalid API key · Please run /login\n" }, NOW)).toEqual({ said: "refused", at: NOW, words: "Invalid API key · Please run /login" });
    expect(probeResult({ code: 1, out: "", err: "API Error: Connection error.\n" }, NOW)).toEqual({ said: "unrun", at: NOW, words: "API Error: Connection error." });
    expect(probeResult({ code: 3, out: "", err: "" }, NOW)).toEqual({ said: "unrun", at: NOW, words: "claude -p ended with exit 3 and said nothing" });
    expect(probeResult({ code: null, out: "", err: "", timedOut: true }, NOW)).toEqual({ said: "unrun", at: NOW, words: "claude -p did not answer within 120 s" });
  });

  test("its words never carry a token, and stay short", () => {
    const r = probeResult({ code: 1, out: `Invalid bearer token ${TOKEN}\n${"more ".repeat(200)}`, err: "" }, NOW);
    expect(r.said).toBe("refused");
    expect(r.words).not.toContain(TOKEN);
    expect(r.words).toContain("Invalid bearer token (a token)");
    expect((r.words ?? "").length).toBeLessThanOrEqual(300);
  });

  test("what a check is for: a token by a hash of it, a login by its end; nothing to check for a dead login, none, or a runner that says nothing", () => {
    const a = loginKey({ how: "token" }, TOKEN);
    expect(a).toStartWith("token:");
    expect(a).not.toContain(TOKEN.slice(13, 30));
    expect(loginKey({ how: "token" }, `${TOKEN}x`)).not.toBe(a);
    expect(loginKey({ how: "login", until: NOW }, null)).toBe(`login:${NOW}`);
    expect(loginKey({ how: "login" }, null)).toBe("login:");
    for (const l of [{ how: "expired" as const }, { how: "none" as const }, undefined]) expect(loginKey(l, TOKEN)).toBe(null);
  });

  test("checks at once, then at most once a day while the login stays; an hour after a refusal; at once for a new login", async () => {
    let clock = NOW;
    let answer: LoginProbe | null = { said: "ok", at: 0 };
    let runs = 0;
    const prober = new LoginProber(async () => {
      runs++;
      return answer ? { ...answer, at: clock } : null;
    }, () => clock);
    // the first hello starts a check and has nothing to say yet
    expect(prober.observe("token:a")).toBeUndefined();
    await prober.settled();
    expect(runs).toBe(1);
    expect(prober.observe("token:a")).toEqual({ said: "ok", at: NOW });
    // later that day: no second check
    clock += PROBE_EVERY - 60_000;
    expect(prober.observe("token:a")).toEqual({ said: "ok", at: NOW });
    await prober.settled();
    expect(runs).toBe(1);
    // a day on: checked again, and refused
    clock += 120_000;
    answer = { said: "refused", at: 0, words: "Invalid bearer token" };
    prober.observe("token:a");
    await prober.settled();
    expect(runs).toBe(2);
    expect(prober.observe("token:a")).toMatchObject({ said: "refused" });
    // a refusal is checked again within the hour, not a day
    clock += PROBE_AGAIN + 1;
    answer = { said: "ok", at: 0 };
    prober.observe("token:a");
    await prober.settled();
    expect(runs).toBe(3);
    expect(prober.observe("token:a")).toMatchObject({ said: "ok" });
    // a new token: the old word is not this login's, and it is checked at once
    expect(prober.observe("token:b")).toBeUndefined();
    await prober.settled();
    expect(runs).toBe(4);
    expect(prober.observe("token:b")).toMatchObject({ said: "ok" });
    // nothing to check: no word and no run
    expect(prober.observe(null)).toBeUndefined();
    await prober.settled();
    expect(runs).toBe(4);
  });

  test("a check that could not start now (the fence unconfirmed) is not kept, and is asked for again at the next hello", async () => {
    let runs = 0;
    const prober = new LoginProber(async () => {
      runs++;
      return null;
    }, () => NOW);
    prober.observe("token:a");
    await prober.settled();
    expect(prober.observe("token:a")).toBeUndefined();
    await prober.settled();
    expect(runs).toBe(2);
  });

  test("one check at a time, however many hellos come while it runs", async () => {
    let release: () => void = () => {};
    let runs = 0;
    const prober = new LoginProber(() => {
      runs++;
      return new Promise<LoginProbe>((r) => (release = () => r({ said: "ok", at: NOW })));
    }, () => NOW);
    for (let i = 0; i < 5; i++) prober.observe("token:a");
    release();
    await prober.settled();
    expect(runs).toBe(1);
  });
});
