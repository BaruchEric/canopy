import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSecretFile, verifyFile } from "../core/secretfile";
import { SecretStore, storePaths } from "./store";

const BREAKGLASS = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";
const quiet = () => {};

let dir = "";
let remote = "";
const git = (cwd: string, ...args: string[]) => Bun.spawnSync(["git", "-C", cwd, ...args]).stdout.toString().trim();

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-store-"));
  remote = join(dir, "remote.git");
  Bun.spawnSync(["git", "init", "-q", "--bare", "-b", "main", remote]);
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("SecretStore", () => {
  test("a first start makes the keys at 0400, an empty signed file, and pushes it", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    const p = storePaths(join(dir, "data"));
    expect((await stat(p.identity)).mode & 0o777).toBe(0o400);
    expect((await stat(p.signingKey)).mode & 0o777).toBe(0o400);
    expect(s.file.keys).toEqual({ mini: s.recipient, breakglass: BREAKGLASS });
    expect(s.unpushed).toBe(0);
    const pushed = parseSecretFile(git(remote, "show", "main:secrets.json"));
    if ("error" in pushed) throw new Error(pushed.error);
    expect(await verifyFile(pushed.file, s.publicB64)).toBe(true);
  });

  test("a second start keeps the same keys and reads the file back", async () => {
    const a = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    const b = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    expect(b.recipient).toBe(a.recipient);
    expect(b.publicB64).toBe(a.publicB64);
    expect(b.head).toBe(a.head);
  });

  test("a commit signs, commits as canopy@mini with the message given, and pushes", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    await s.commit({ ...s.file, keys: { ...s.file.keys, mac: BREAKGLASS } }, "secrets: add the mac key");
    expect(git(remote, "log", "-1", "--format=%ae %s", "main")).toBe("canopy@mini secrets: add the mac key");
    const pushed = parseSecretFile(git(remote, "show", "main:secrets.json"));
    if ("error" in pushed) throw new Error(pushed.error);
    expect(pushed.file.keys["mac"]).toBe(BREAKGLASS);
    expect(await verifyFile(pushed.file, s.publicB64)).toBe(true);
  });

  test("a push that fails keeps the commit and counts it", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    await rm(remote, { recursive: true, force: true });
    await s.commit({ ...s.file, keys: { ...s.file.keys, mac: BREAKGLASS } }, "secrets: add the mac key");
    expect(s.unpushed).toBe(1);
    expect(git(join(dir, "data", "repo"), "log", "-1", "--format=%s")).toBe("secrets: add the mac key");
  });

  test("refuses to start on a file this key did not sign", async () => {
    await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    const file = join(dir, "data", "repo", "secrets.json");
    await writeFile(file, (await readFile(file, "utf8")).replace(BREAKGLASS, BREAKGLASS.replace("xtc4", "xtc5")));
    await expect(SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet })).rejects.toThrow("not signed by this mini's key");
  });

  test("a start does not merge an older signed file, or an unsigned one, pushed on top", async () => {
    const logs: string[] = [];
    const s = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    await s.commit({ ...s.file, keys: { ...s.file.keys, mac: BREAKGLASS } }, "secrets: add the mac key");
    const seq = s.file.seq;
    const work = join(dir, "work");
    Bun.spawnSync(["git", "clone", "-q", remote, work]);
    const id = ["-c", "user.name=t", "-c", "user.email=t@t"];
    await writeFile(join(work, "secrets.json"), git(work, "show", "HEAD~1:secrets.json") + "\n");
    Bun.spawnSync(["git", "-C", work, ...id, "commit", "-qam", "put back"]);
    Bun.spawnSync(["git", "-C", work, "push", "-q", "origin", "HEAD:main"]);
    const b = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: (l) => logs.push(l) });
    expect(b.file.seq).toBe(seq);
    expect(b.file.keys["mac"]).toBe(BREAKGLASS);
    expect(logs.join("\n")).toContain("older");
    await writeFile(join(work, "secrets.json"), (await readFile(join(work, "secrets.json"), "utf8")).replace('"seq": 1', '"seq": 99'));
    Bun.spawnSync(["git", "-C", work, ...id, "commit", "-qam", "unsigned"]);
    Bun.spawnSync(["git", "-C", work, "push", "-q", "origin", "HEAD:main"]);
    const c = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: (l) => logs.push(l) });
    expect(c.file.seq).toBe(seq);
    expect(logs.join("\n")).toContain("not signed");
  });

  test("each commit raises the signed sequence number", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: quiet });
    const first = s.file.seq;
    await s.commit({ ...s.file, keys: { ...s.file.keys, mac: BREAKGLASS } }, "secrets: add the mac key");
    expect(s.file.seq).toBe(first + 1);
  });

  test("a remote set after a start without one is added, and the waiting commits go up", async () => {
    const a = await SecretStore.open({ data: join(dir, "data"), remote: null, breakglass: BREAKGLASS, log: quiet });
    await a.commit({ ...a.file, keys: { ...a.file.keys, mac: BREAKGLASS } }, "secrets: add the mac key");
    const logs: string[] = [];
    const b = await SecretStore.open({ data: join(dir, "data"), remote, breakglass: BREAKGLASS, log: (l) => logs.push(l) });
    expect(b.unpushed).toBe(0);
    // an empty remote has not split from anything
    expect(logs.join("\n")).not.toContain("split");
    expect(git(remote, "log", "-1", "--format=%s", "main")).toBe("secrets: add the mac key");
    const c = await SecretStore.open({ data: join(dir, "data"), remote: join(dir, "moved.git"), breakglass: BREAKGLASS, log: quiet });
    expect(git(join(dir, "data", "repo"), "remote", "get-url", "origin")).toBe(join(dir, "moved.git"));
    expect(c.unpushed).toBeGreaterThan(0);
  });

  test("works with no remote at all", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote: null, breakglass: BREAKGLASS, log: quiet });
    expect(s.unpushed).toBe(0);
    expect(s.head).toMatch(/^[0-9a-f]{7,}$/);
  });
});
