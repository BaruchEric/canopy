import { describe, expect, test } from "bun:test";
import type { Clip } from "../../src/core/clips";
import type { ChanMessage } from "../../src/core/types";
import { commandText, filterClips, headLines, linkParts, pathParts, pinnedFirst, prettyJson, shownClips, shownFile, sourceCounts } from "./clips";

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({ id, text: id, source: "canopy", createdAt: 1, at: 1, count: 1, ...over });
const msg = (id: number, body: string, over: Partial<ChanMessage> = {}): ChanMessage => ({ id, channel: "clipboard", handle: "eric", node: "pixel", kind: "clip", body, meta: {}, ts: 1, ...over });

describe("shownClips", () => {
  test("every backend's clips newest first, the same text once at its newest, then tailchan's text not already held", () => {
    const list = shownClips(
      {
        home: [clip("c-aaaaaaaa", { text: "same", at: 5 }), clip("c-bbbbbbbb", { text: "home", at: 2, pinned: true })],
        "mini|": [clip("mini|c-cccccccc", { text: "same", at: 9, source: "cli", from: "atlas" })],
      },
      [msg(1, "same", { ts: 20 }), msg(2, "from the phone", { ts: 7 }), msg(3, "a file", { kind: "object" }), msg(4, "export API_TOKEN=abcdefgh12345678", { ts: 30 })],
    );
    expect(list.map((c) => [c.key, c.source, c.at])).toEqual([
      ["mini|c-cccccccc", "cli", 9],
      ["chan:2", "tailnet", 7],
      ["c-bbbbbbbb", "canopy", 2],
    ]);
    expect(list[1]).toEqual({ key: "chan:2", text: "from the phone", source: "tailnet", from: "eric@pixel", at: 7, count: 1, pinned: false, cut: false });
    expect(list[1]?.id).toBeUndefined();
    expect(list[2]?.pinned).toBe(true);
  });
});

describe("files in the list", () => {
  test("the same bytes once; tailchan's files shown with their blob, one named like a key left out", () => {
    const file = { name: "shot.png", type: "image/png", size: 10, sha: "a".repeat(64) };
    const list = shownClips(
      {
        home: [clip("c-aaaaaaaa", { text: "shot.png", file, at: 5 }), clip("c-bbbbbbbb", { text: "shot.png", at: 4 })],
        "mini|": [clip("mini|c-cccccccc", { text: "old.png", file: { ...file, name: "old.png" }, at: 3 })],
      },
      [
        msg(7, "clipboard file", { kind: "object", ts: 9, meta: { blob: "f".repeat(32), name: "phone.jpg", mime: "image/jpeg", size: 2048 } }),
        msg(8, "clipboard file", { kind: "object", ts: 8, meta: { blob: "e".repeat(32), name: "id_rsa", mime: "text/plain", size: 9 } }),
        msg(9, "clipboard file", { kind: "object", ts: 7, meta: { name: "no blob" } }),
      ],
    );
    expect(list.map((c) => [c.key, c.text, c.file ? "file" : c.chanFile ? "chan file" : "text"])).toEqual([
      ["chan:7", "phone.jpg", "chan file"],
      ["c-aaaaaaaa", "shot.png", "file"],
      ["c-bbbbbbbb", "shot.png", "text"],
    ]);
    expect(list[0]?.chanFile).toEqual({ name: "phone.jpg", type: "image/jpeg", size: 2048, blob: "f".repeat(32) });
    expect(shownFile(list[1]!)).toEqual(file);
    expect(shownFile(list[2]!)).toBeNull();
  });
});

describe("sourceCounts, filterClips and pinnedFirst", () => {
  const list = shownClips({ home: [clip("c-aaaaaaaa", { text: "git push", source: "shell", from: "Atlas", at: 3 }), clip("c-bbbbbbbb", { text: "Hello", at: 2, pinned: true }), clip("c-cccccccc", { text: "bye", source: "shell", at: 1 })] });
  test("counts per source, in the sources' order, none left out as zero", () => {
    expect(sourceCounts(list)).toEqual([
      { source: "shell", n: 2 },
      { source: "canopy", n: 1 },
    ]);
  });
  test("a source and words in the text or the place, any case", () => {
    expect(filterClips(list, "shell", "").map((c) => c.key)).toEqual(["c-aaaaaaaa", "c-cccccccc"]);
    expect(filterClips(list, null, "atlas").map((c) => c.key)).toEqual(["c-aaaaaaaa"]);
    expect(filterClips(list, null, " hello ").map((c) => c.key)).toEqual(["c-bbbbbbbb"]);
    expect(filterClips(list, "cli", "")).toEqual([]);
  });
  test("pinned first, each group as it came", () => {
    expect(pinnedFirst(list).map((c) => c.key)).toEqual(["c-bbbbbbbb", "c-aaaaaaaa", "c-cccccccc"]);
  });
});

describe("the viewer's pieces", () => {
  test("a link's host and the rest, for http and https alone", () => {
    expect(linkParts("https://github.com/eric/canopy/pull/412?x=1#top")).toEqual({ href: "https://github.com/eric/canopy/pull/412?x=1#top", host: "github.com", rest: "/eric/canopy/pull/412?x=1#top" });
    expect(linkParts("http://127.0.0.1:7850/")).toEqual({ href: "http://127.0.0.1:7850/", host: "127.0.0.1:7850", rest: "" });
    expect(linkParts("javascript:alert(1)")).toBeNull();
    expect(linkParts("not a url")).toBeNull();
  });
  test("a path's folder and name", () => {
    expect(pathParts("/Users/e/dev/canopy/src/core/clips.ts")).toEqual({ dir: "/Users/e/dev/canopy/src/core/", base: "clips.ts" });
    expect(pathParts("~/.config/canopy/")).toEqual({ dir: "~/.config/", base: "canopy/" });
    expect(pathParts("clips.ts")).toEqual({ dir: "", base: "clips.ts" });
  });
  test("pretty JSON under a cap; the head of a text and how much more", () => {
    expect(prettyJson('{"a":[1,2]}')).toBe('{\n  "a": [\n    1,\n    2\n  ]\n}');
    expect(prettyJson("{nope")).toBeNull();
    expect(prettyJson('{"a":1}', 3)).toBeNull();
    expect(headLines("a\nb\nc\n\n", 2)).toEqual({ lines: ["a", "b"], more: 1 });
    expect(commandText("$ bun run build ")).toBe("bun run build");
  });
});
