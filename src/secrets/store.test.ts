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

  test("works with no remote at all", async () => {
    const s = await SecretStore.open({ data: join(dir, "data"), remote: null, breakglass: BREAKGLASS, log: quiet });
    expect(s.unpushed).toBe(0);
    expect(s.head).toMatch(/^[0-9a-f]{7,}$/);
  });
});
