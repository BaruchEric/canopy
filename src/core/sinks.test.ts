import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyKeys, decideKey, parseDotenv, readKeys, readSinkFile, repoRefusal, writeSinkFile } from "./sinks";

describe("dotenv", () => {
  const FILE = "# the dns stack\nexport CF_TOKEN=old # rotated by hand\n\nKEEP_ME='as is'\nPLAIN=x\n";

  test("reads plain, quoted, exported and commented values", () => {
    const r = readKeys(FILE, "dotenv", ["CF_TOKEN", "KEEP_ME", "PLAIN", "ABSENT"]);
    if ("error" in r) throw new Error(r.error);
    expect(r.values).toEqual({ CF_TOKEN: "old", KEEP_ME: "as is", PLAIN: "x", ABSENT: undefined });
  });

  test("a write changes only its own lines and appends missing keys", () => {
    const r = applyKeys(FILE, "dotenv", { CF_TOKEN: "new", ADDED: "y" });
    if ("error" in r) throw new Error(r.error);
    expect(r.text).toBe("# the dns stack\nexport CF_TOKEN=new\n\nKEEP_ME='as is'\nPLAIN=x\nADDED=y\n");
  });

  test("every value comes back as it went in", () => {
    for (const v of ["plain", "", "with space", "has#hash", "it's", 'say "hi"', "multi\nline", "back\\slash", "a=b"]) {
      const w = applyKeys(null, "dotenv", { K: v });
      if ("error" in w) throw new Error(w.error);
      const r = readKeys(w.text, "dotenv", ["K"]);
      if ("error" in r) throw new Error(r.error);
      expect(r.values["K"]).toBe(v);
    }
  });

  test("refuses a value no quoting keeps literal for every reader", () => {
    const r = applyKeys(null, "dotenv", { K: "it's $HOME" });
    expect("error" in r ? r.error : "").toContain("$");
  });

  test("refuses a file it cannot parse and names the line", () => {
    const r = parseDotenv("A=1\nthis is not a pair\n");
    expect("error" in r ? r.error : "").toContain("line 2");
    expect("error" in parseDotenv("A='never closed\n")).toBe(true);
  });

  test("keeps a file without a final newline that way", () => {
    const r = applyKeys("A=1", "dotenv", { A: "2" });
    expect("text" in r ? r.text : "").toBe("A=2");
  });
});

describe("json", () => {
  test("sets dotted paths and keeps other keys and the indent", () => {
    const r = applyKeys('{\n    "name": "x",\n    "auth": { "token": "old" }\n}\n', "json", { "auth.token": "new", "extra.key": "z" });
    if ("error" in r) throw new Error(r.error);
    expect(JSON.parse(r.text)).toEqual({ name: "x", auth: { token: "new" }, extra: { key: "z" } });
    expect(r.text.startsWith('{\n    "name"')).toBe(true);
    expect(r.text.endsWith("}\n")).toBe(true);
  });

  test("refuses a path through a non-object and a non-string value", () => {
    expect("error" in applyKeys('{"auth": "flat"}', "json", { "auth.token": "x" })).toBe(true);
    expect("error" in readKeys('{"auth": {"token": 5}}', "json", ["auth.token"])).toBe(true);
    expect("error" in readKeys("[1]", "json", ["a"])).toBe(true);
  });
});

describe("json with a top-level error key", () => {
  test("is read and written like any other object, not taken for a parse failure", () => {
    expect(readKeys('{"error": "x", "auth": {"token": "t"}}', "json", ["auth.token"])).toEqual({ values: { "auth.token": "t" } });
    const w = applyKeys('{"error": "x"}', "json", { "auth.token": "t" });
    expect("text" in w && JSON.parse(w.text)).toEqual({ error: "x", auth: { token: "t" } });
  });
});

describe("decideKey", () => {
  const T1 = "2026-10-14T12:00:00.000Z";
  const T2 = "2026-10-15T12:00:00.000Z";
  test.each([
    ["same value", undefined, T1, "v", "v", "same"],
    ["missing key", T1, T1, undefined, "v", "write"],
    ["rotated since the last write", T1, T2, "old", "v", "write"],
    ["changed by hand after a write", T1, T1, "hand", "v", "drift"],
    ["different before canopy ever wrote it", undefined, T1, "theirs", "v", "drift"],
  ] as const)("%s", (_label, applied, rotated, file, value, want) => {
    expect(decideKey(applied, rotated, file, value)).toBe(want);
  });
});

describe("files", () => {
  let dir = "";
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-sinks-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("writes atomically at 0600 and reads back; a missing file reads as null", async () => {
    const p = join(dir, ".env");
    expect(await readSinkFile(p)).toEqual({ text: null });
    await writeSinkFile(p, "A=1\n");
    expect(await readFile(p, "utf8")).toBe("A=1\n");
    expect((await lstat(p)).mode & 0o777).toBe(0o600);
    expect(await readSinkFile(p)).toEqual({ text: "A=1\n" });
  });

  test("refuses a symlink and a missing folder", async () => {
    await writeFile(join(dir, "real"), "A=1\n");
    await symlink(join(dir, "real"), join(dir, "link"));
    await expect(writeSinkFile(join(dir, "link"), "A=2\n")).rejects.toThrow("symlink");
    expect("error" in (await readSinkFile(join(dir, "link")))).toBe(true);
    await expect(writeSinkFile(join(dir, "nope", ".env"), "A=1\n")).rejects.toThrow();
    expect(await readFile(join(dir, "real"), "utf8")).toBe("A=1\n");
  });

  test("a path inside a repo is refused unless git ignores it there", async () => {
    const repo = join(dir, "repo");
    await mkdir(repo);
    Bun.spawnSync(["git", "init", "-q", repo]);
    await writeFile(join(repo, ".gitignore"), ".env\n");
    expect(await repoRefusal(join(repo, ".env"), [repo])).toBeNull();
    expect(await repoRefusal(join(repo, "config.json"), [repo])).toContain("does not ignore");
    expect(await repoRefusal(join(dir, "elsewhere.env"), [repo])).toBeNull();
  });
});
