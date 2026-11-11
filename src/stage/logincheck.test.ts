import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeLogin, loginOf, stageToken } from "./logincheck";

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
