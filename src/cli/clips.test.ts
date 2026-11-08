import { describe, expect, test } from "bun:test";
import type { Clip } from "../core/clips";
import { asksUsage, cliFrom, clipLines, mergeHeld, pickHeld } from "./clips";

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({ id, text: id, source: "cli", createdAt: 1, at: 1, count: 1, ...over });

describe("mergeHeld", () => {
  test("every backend's clips newest first, the same text once at its newest", () => {
    const held = mergeHeld([
      { backend: "mac", clips: [clip("c-aaaaaaaa", { text: "same", at: 5 }), clip("c-bbbbbbbb", { at: 1 })] },
      { backend: "mini", clips: [clip("c-cccccccc", { text: "same", at: 9 }), clip("c-dddddddd", { at: 3 })] },
    ]);
    expect(held.map((h) => [h.clip.id, h.backend])).toEqual([
      ["c-cccccccc", "mini"],
      ["c-dddddddd", "mini"],
      ["c-bbbbbbbb", "mac"],
    ]);
  });
});

describe("clipLines and pickHeld", () => {
  test("a numbered line per clip, a pin marked, the backend named when there are several", () => {
    const held = [
      { clip: clip("c-aaaaaaaa", { text: "git push", source: "shell", at: 0, pinned: true }), backend: "mac" },
      { clip: clip("c-bbbbbbbb", { text: "https://x.dev/a", at: 0 }), backend: "mini" },
    ];
    expect(clipLines(held, 120_000, false)).toEqual(["  1* c-aaaaaaaa   2m  shell     command git push", "  2  c-bbbbbbbb   2m  cli       link    https://x.dev/a"]);
    expect(clipLines(held, 120_000, true)[1]).toBe("  2  c-bbbbbbbb   2m  cli@mini           link    https://x.dev/a");
    expect(pickHeld(held, undefined)?.clip.id).toBe("c-aaaaaaaa");
    expect(pickHeld(held, "2")?.clip.id).toBe("c-bbbbbbbb");
    expect(pickHeld(held, "c-bbbbbbbb")?.backend).toBe("mini");
    expect(pickHeld(held, "3")).toBeUndefined();
  });
});

describe("cliFrom", () => {
  test("a canopy shell's repo, a run marked, else the machine", () => {
    expect(cliFrom({ CANOPY_REPO: "/Users/e/dev/canopy/" }, "mac")).toBe("canopy");
    expect(cliFrom({ CANOPY_REPO: "/repos/atlas", CANOPY_RUN: "r1" }, "mac")).toBe("atlas (run)");
    expect(cliFrom({}, "macmini-2018")).toBe("macmini-2018");
  });
});

describe("files in the CLI's list", () => {
  test("a file shows its kind, name and size, and the same bytes on two backends show once", () => {
    const file = { name: "shot.png", type: "image/png", size: 2_400_000, sha: "a".repeat(64) };
    const held = mergeHeld([
      { backend: "mac", clips: [clip("c-aaaaaaaa", { text: "shot.png", file, at: 5 })] },
      { backend: "mini", clips: [clip("c-bbbbbbbb", { text: "copy.png", file: { ...file, name: "copy.png" }, at: 9 }), clip("c-cccccccc", { text: "shot.png", at: 1 })] },
    ]);
    expect(held.map((h) => h.clip.id)).toEqual(["c-bbbbbbbb", "c-cccccccc"]);
    expect(clipLines(held, 9, false)[0]).toBe("  1  c-bbbbbbbb  now  cli       image   copy.png  2.3 MB");
  });
});

describe("asksUsage", () => {
  test("--help or -h asks for the usage instead of keeping the word", () => {
    expect(asksUsage(["--help"])).toBe(true);
    expect(asksUsage(["-h"])).toBe(true);
    expect(asksUsage(["list", "--help"])).toBe(true);
  });
  test("text that only mentions the flag is kept as text", () => {
    expect(asksUsage(["run with --help to see"])).toBe(false);
    expect(asksUsage(["help"])).toBe(false);
    expect(asksUsage([])).toBe(false);
  });
});
