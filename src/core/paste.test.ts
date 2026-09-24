import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expiredPastes, pasteDir, pasteName, pasteText, savePaste } from "./paste";

const ID = "0123456789abcdef0123456789abcdef";

describe("pasteName", () => {
  test("names the file after the shell and the time, with the type's extension", () => {
    expect(pasteName(ID, "image/png", 42)).toBe("01234567-42.png");
    expect(pasteName(ID, "image/jpeg", 42)).toBe("01234567-42.jpg");
    expect(pasteName(ID, "IMAGE/WEBP; charset=binary", 42)).toBe("01234567-42.webp");
  });
  test("refuses anything that is not an image Claude Code reads", () => {
    expect(pasteName(ID, "image/svg+xml", 42)).toBeNull();
    expect(pasteName(ID, "text/plain", 42)).toBeNull();
    expect(pasteName(ID, "", 42)).toBeNull();
  });
});

describe("pasteText", () => {
  test("leaves a plain path bare", () => {
    expect(pasteText("/config/pastes/01234567-42.png")).toBe("/config/pastes/01234567-42.png");
  });
  test("escapes spaces and shell characters", () => {
    expect(pasteText("/Users/a b/it's.png")).toBe("/Users/a\\ b/it\\'s.png");
  });
});

describe("expiredPastes", () => {
  test("names the files older than a week", () => {
    const day = 24 * 60 * 60 * 1000;
    const now = 100 * day;
    expect(expiredPastes([{ name: "old", mtime: now - 8 * day }, { name: "new", mtime: now - day }], now)).toEqual(["old"]);
  });
});

describe("savePaste", () => {
  let dir: string;
  const prev = process.env["CANOPY_CONFIG_DIR"];
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "canopy-paste-"));
    process.env["CANOPY_CONFIG_DIR"] = dir;
  });
  afterEach(async () => {
    if (prev === undefined) delete process.env["CANOPY_CONFIG_DIR"];
    else process.env["CANOPY_CONFIG_DIR"] = prev;
    await rm(dir, { recursive: true, force: true });
  });

  test("writes the bytes under pastes/, private, and clears expired ones", async () => {
    await savePaste("first.png", new Uint8Array([1]).buffer);
    const old = join(pasteDir(), "first.png");
    const long = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    await utimes(old, long, long);
    await writeFile(join(pasteDir(), "recent.png"), "x");

    const path = await savePaste("second.png", new Uint8Array([7, 8, 9]).buffer);
    expect(path).toBe(join(dir, "pastes", "second.png"));
    expect([...(await readFile(path))]).toEqual([7, 8, 9]);
    expect((await stat(path)).mode & 0o777).toBe(0o600);
    expect((await readdir(pasteDir())).sort()).toEqual(["recent.png", "second.png"]);
  });
});
