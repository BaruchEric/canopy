import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { applyKeys, decideKey, looseDotenv, parseDotenv, readKeys, mcpIgnoreRefusal, readSinkFile, repoRefusal, writeSinkFile } from "./sinks";

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

describe("a dotenv file somebody keeps by hand (notes)", () => {
  // a label line another tool reads by its words, a key with a hyphen, a login line, and pairs between them
  const NOTES = "# keys\nOPENAI_API_KEY=sk-old\nCloudflare Global API Key: 0123abcd\nx-api-key=zzz\nme@example.com hunter2\n\nexport GROQ_API_KEY='gq old'  # mine\n";

  test("a strict read and a strict write refuse it, as for a compose file", () => {
    expect("error" in readKeys(NOTES, "dotenv", ["OPENAI_API_KEY"])).toBe(true);
    const w = applyKeys(NOTES, "dotenv", { OPENAI_API_KEY: "sk-new" });
    expect("error" in w ? w.error : "").toContain("line 3");
  });

  test("with notes its pairs are read around the lines that are not pairs", () => {
    const r = readKeys(NOTES, "dotenv", ["OPENAI_API_KEY", "GROQ_API_KEY", "ABSENT"], true);
    if ("error" in r) throw new Error(r.error);
    expect(r.values).toEqual({ OPENAI_API_KEY: "sk-old", GROQ_API_KEY: "gq old", ABSENT: undefined });
  });

  test("with notes a write changes its own lines and every other line goes back byte for byte", () => {
    const w = applyKeys(NOTES, "dotenv", { OPENAI_API_KEY: "sk-new", ADDED: "y" }, true);
    if ("error" in w) throw new Error(w.error);
    expect(w.text).toBe("# keys\nOPENAI_API_KEY=sk-new\nCloudflare Global API Key: 0123abcd\nx-api-key=zzz\nme@example.com hunter2\n\nexport GROQ_API_KEY='gq old'  # mine\nADDED=y\n");
    // a missing last newline stays missing
    const bare = applyKeys("Note: one\nA=1\nNote: two", "dotenv", { A: "2" }, true);
    expect("text" in bare ? bare.text : "").toBe("Note: one\nA=2\nNote: two");
  });

  test("a value over several lines is carried whole, and a line inside it is never taken for a pair", () => {
    const text = 'CERT="-----BEGIN\nB=inside\n-----END"\nB=real\n';
    expect(looseDotenv(text)).toEqual({ pairs: [{ key: "B", value: "real" }], skipped: [1, 2, 3] });
    const w = applyKeys(text, "dotenv", { B: "new" }, true);
    expect("text" in w ? w.text : "").toBe('CERT="-----BEGIN\nB=inside\n-----END"\nB=new\n');
  });

  test("with notes it is still refused where a write could go wrong", () => {
    // a managed key set on a line canopy cannot read: a new line would leave two answers
    const twice = applyKeys('A="x" junk\nB=1\n', "dotenv", { A: "2" }, true);
    expect("error" in twice ? twice.error : "").toBe("line 1 sets A in a form canopy cannot read");
    expect("error" in readKeys('A="x" junk\nB=1\n', "dotenv", ["A"], true)).toBe(true);
    // the same file is fine for a key it does read
    expect(readKeys('A="x" junk\nB=1\n', "dotenv", ["B"], true)).toEqual({ values: { B: "1" } });
    // a label with a colon and a CRLF line set their key for some other reader
    const label = applyKeys("Resend: re_old\nB=1\n", "dotenv", { Resend: "re_new" }, true);
    expect("error" in label ? label.error : "").toBe("line 1 sets Resend in a form canopy cannot read");
    const crlf = applyKeys("Note: one\r\nA=1\r\n", "dotenv", { A: "2" }, true);
    expect("error" in crlf ? crlf.error : "").toBe("line 2 sets A in a form canopy cannot read");
    // a quote that never closes swallows the rest of the file for a real reader
    const open = applyKeys("A=1\nNOTE='never closed\nB=2\n", "dotenv", { B: "3" }, true);
    expect("error" in open ? open.error : "").toBe("line 2 opens a quote that never closes");
  });

  test("the import's numbers stop at the last line, with or without a final newline", () => {
    expect(looseDotenv("A=1\nnote\n").skipped).toEqual([2]);
    expect(looseDotenv("A=1\nnote").skipped).toEqual([2]);
    expect(looseDotenv("A='open\n").skipped).toEqual([1]);
    expect(looseDotenv("")).toEqual({ pairs: [], skipped: [] });
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

describe("json keys canopy does not manage", () => {
  test("keep every byte through a write: key order, number spelling, escapes, inline arrays, big numbers", () => {
    const before = '{\n  "b": 1.0,\n  "10": "\\u00e9",\n  "list": [1,2,  3],\n  "big": 12345678901234567890,\n  "auth": {"token": "old", "z": true}\n}\n';
    const r = applyKeys(before, "json", { "auth.token": "new" });
    if ("error" in r) throw new Error(r.error);
    expect(r.text).toBe(before.replace('"old"', '"new"'));
  });

  test("a missing key goes in after the last member, the rest untouched", () => {
    const r = applyKeys('{\n    "b": 1.0,\n    "auth": {}\n}', "json", { "auth.token": "t", "x.y": "z" });
    if ("error" in r) throw new Error(r.error);
    expect(r.text).toBe('{\n    "b": 1.0,\n    "auth": {"token": "t"},\n    "x": {"y":"z"}\n}');
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
    ["an older stamp than the one written (a file put back)", T2, T1, "newer", "old", "drift"],
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

describe("the mcp-env folder", () => {
  test("writeSinkFile makes a missing mcp-env folder 0700, and only that folder", async () => {
    const h = mkdtempSync(join(tmpdir(), "mcpenv-"));
    try {
      mkdirSync(join(h, ".claude"));
      await writeSinkFile(join(h, ".claude", "mcp-env", "github.env"), "A=b\n");
      expect(statSync(join(h, ".claude", "mcp-env")).mode & 0o777).toBe(0o700);
      expect(statSync(join(h, ".claude", "mcp-env", "github.env")).mode & 0o777).toBe(0o600);
      await expect(writeSinkFile(join(h, "other", "x.env"), "A=b\n")).rejects.toThrow();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("mcpIgnoreRefusal passes only when dotclaude's git ignores mcp-env/", async () => {
    const h = mkdtempSync(join(tmpdir(), "mcpignore-"));
    try {
      await exec(["git", "init", "-q", join(h, ".claude")]);
      expect(await mcpIgnoreRefusal(h, "github")).toContain("git does not ignore it");
      writeFileSync(join(h, ".claude", ".gitignore"), "mcp-env/\n");
      expect(await mcpIgnoreRefusal(h, "github")).toBeNull();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});
