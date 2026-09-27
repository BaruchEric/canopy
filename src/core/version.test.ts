import { describe, expect, test } from "bun:test";
import { buildFrom, sameBuild, shortCommit, versionLine } from "./version";

const sha = "4b6ba30c9e1f0a1b2c3d4e5f60718293a4b5c6d7";
const head = { commit: sha, committedAt: "2026-09-26T21:04:11-04:00", dirty: false };

describe("versionLine", () => {
  test("version, short commit and day", () => {
    expect(versionLine({ version: "0.1.0", ...head })).toBe("0.1.0 (4b6ba30, 2026-09-26)");
  });
  test("marks a dirty checkout", () => {
    expect(versionLine({ version: "0.1.0", ...head, dirty: true })).toBe("0.1.0 (4b6ba30+dirty, 2026-09-26)");
  });
  test("bare version without a commit", () => {
    expect(versionLine({ version: "0.1.0", commit: null, committedAt: null, dirty: false })).toBe("0.1.0");
    expect(shortCommit(null)).toBeNull();
  });
});

describe("buildFrom", () => {
  test("git's head when the env says nothing", () => {
    expect(buildFrom("1.0.0", {}, head)).toEqual({ version: "1.0.0", ...head });
  });
  test("CANOPY_COMMIT wins and is never dirty", () => {
    const b = buildFrom("1.0.0", { CANOPY_COMMIT: "ABCDEF1", CANOPY_COMMITTED: "2026-01-02T00:00:00Z" }, { ...head, dirty: true });
    expect(b).toEqual({ version: "1.0.0", commit: "abcdef1", committedAt: "2026-01-02T00:00:00Z", dirty: false });
  });
  test("a CANOPY_COMMIT that is not a hash is ignored", () => {
    expect(buildFrom("1.0.0", { CANOPY_COMMIT: "main; rm" }, null)).toEqual({
      version: "1.0.0",
      commit: null,
      committedAt: null,
      dirty: false,
    });
  });
});

describe("sameBuild", () => {
  const a = { version: "0.1.0", ...head };
  test("the same commit, short or long", () => {
    expect(sameBuild(a, { ...a, commit: "4b6ba30" })).toBe(true);
  });
  test("another commit", () => {
    expect(sameBuild(a, { ...a, commit: "ff3bbe0" })).toBe(false);
  });
  test("uncommitted edits on the same commit still match", () => {
    expect(sameBuild(a, { ...a, dirty: true })).toBe(true);
  });
  test("versions when a commit is unknown", () => {
    expect(sameBuild({ ...a, commit: null }, a)).toBe(true);
    expect(sameBuild({ ...a, commit: null }, { ...a, version: "0.2.0" })).toBe(false);
  });
});
