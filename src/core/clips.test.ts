import { describe, expect, test } from "bun:test";
import {
  CLIP_CHARS,
  CLIP_DAYS,
  CLIP_KEEP,
  agoWord,
  applyClips,
  clipKind,
  clipLabel,
  clipLine,
  clipText,
  isClipId,
  lineCount,
  looksSecret,
  mintClipId,
  parseClips,
  parseDevice,
  pruneClips,
  putClip,
  sortClips,
  swatchOf,
  takeClip,
  type Clip,
} from "./clips";

const clip = (id: string, over: Partial<Clip> = {}): Clip => ({ id, text: id, source: "canopy", createdAt: 1_000, at: 1_000, count: 1, ...over });
const DAY = 24 * 60 * 60_000;
const DEVICE = { id: "0123456789abcdef", name: "Mac, Chrome", platform: "mac" };

describe("mintClipId", () => {
  test("c- and eight base32 characters", () => {
    expect(mintClipId(() => new Uint8Array([0, 0, 0, 0, 0]))).toBe("c-aaaaaaaa");
    expect(isClipId(mintClipId())).toBe(true);
  });
  test("a note's id, a bare word and the wrong length are not clip ids", () => {
    expect(isClipId("n-aaaaaaaa")).toBe(false);
    expect(isClipId("c-aaaa")).toBe(false);
    expect(isClipId(7)).toBe(false);
  });
});

describe("looksSecret", () => {
  test("the shapes of keys, tokens and passwords", () => {
    for (const s of [
      "AGE-SECRET-KEY-1QQPZRY9X8GF2TVDW0S3JN54KHCE6MUA7LQPZRY9X8GF2TVDW",
      "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAA\n-----END OPENSSH PRIVATE KEY-----",
      "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U",
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789",
      "github_pat_11ABCDEFG0abcdefghijklmnopqrstuvwxyz",
      "sk-ant-api03-abcdefghijklmnopqrstuvwxyz",
      "sk-proj-abcdefghijklmnopqrstuvwxyz0123456789ABCD",
      "AKIAIOSFODNN7EXAMPLE",
      "xoxb-1234567890-abcdefghij",
      "Authorization: Bearer abcdefghijklmnopqrstuvwxyz012345",
      "export ANTHROPIC_API_KEY=abcdefgh12345678",
      "DB_PASSWORD='hunter22hunter22'",
      "line one\nGITHUB_TOKEN=ghx1234567890abcd\nline three",
    ]) {
      expect(looksSecret(s)).toBe(true);
    }
  });
  test("hashes, ids, links, paths and code that only mentions a token are kept", () => {
    for (const s of [
      "4fadb455",
      "4fadb455c3e1f4f8a2b9e7d6c5b4a3f2e1d0c9b8",
      "550e8400-e29b-41d4-a716-446655440000",
      "https://github.com/eric/canopy/pull/412",
      "/Users/ericbaruch/dev/dev-tools/canopy/src/core/clips.ts",
      "const token = await getToken();",
      "sk-short",
      "TOKEN=",
      "bun run redeploy --pull",
    ]) {
      expect(looksSecret(s)).toBe(false);
    }
  });
});

describe("clipText and clipLabel", () => {
  test("text as given, cut at the cap; whitespace alone is nothing", () => {
    expect(clipText("  two\nlines \n")).toEqual({ text: "  two\nlines \n", cut: false });
    const long = clipText("x".repeat(CLIP_CHARS + 5));
    expect(long.text).toHaveLength(CLIP_CHARS);
    expect(long.cut).toBe(true);
    expect(clipText(" \n\t")).toEqual({ text: "", cut: false });
  });
  test("a label is one trimmed line, capped, or nothing", () => {
    expect(clipLabel("  canopy\n main ")).toBe("canopy main");
    expect(clipLabel("x".repeat(200))).toHaveLength(80);
    expect(clipLabel("   ")).toBeUndefined();
    expect(clipLabel(4)).toBeUndefined();
  });
});

describe("parseDevice and parseClips", () => {
  test("a device needs a 16-hex id and a name; an odd platform reads as other", () => {
    expect(parseDevice(DEVICE)).toEqual(DEVICE);
    expect(parseDevice({ ...DEVICE, platform: "Mac OS!" })).toEqual({ ...DEVICE, platform: "other" });
    expect(parseDevice({ ...DEVICE, id: "nope" })).toBeUndefined();
    expect(parseDevice({ ...DEVICE, name: " " })).toBeUndefined();
  });
  test("reads the file's array newest first, dropping what is not a clip and any second copy of an id", () => {
    const v = [
      { id: "c-aaaaaaaa", text: "old", source: "shell", at: 10, createdAt: 5, count: 2, from: "atlas", device: DEVICE, pinned: true },
      { id: "c-bbbbbbbb", text: "new", source: "cli", at: 30 },
      { id: "c-cccccccc", text: "bad source", source: "mail", at: 20 },
      { id: "c-dddddddd", text: "", source: "page", at: 20 },
      { id: "n-eeeeeeee", text: "a note id", source: "page", at: 20 },
      { id: "c-aaaaaaaa", text: "again", source: "page", at: 40 },
      "nothing",
    ];
    expect(parseClips(v)).toEqual([
      { id: "c-bbbbbbbb", text: "new", source: "cli", at: 30, createdAt: 30, count: 1 },
      { id: "c-aaaaaaaa", text: "old", source: "shell", at: 10, createdAt: 5, count: 2, from: "atlas", device: DEVICE, pinned: true },
    ]);
    expect(parseClips({ clips: [] })).toEqual([]);
  });
});

describe("putClip", () => {
  test("new text is a new clip at the top", () => {
    const r = putClip([clip("c-aaaaaaaa")], { text: "hello", source: "shell", from: "atlas", device: DEVICE }, 5_000, "c-bbbbbbbb");
    expect(r.clip).toEqual({ id: "c-bbbbbbbb", text: "hello", source: "shell", from: "atlas", device: DEVICE, createdAt: 5_000, at: 5_000, count: 1 });
    expect(r.clips.map((c) => c.id)).toEqual(["c-bbbbbbbb", "c-aaaaaaaa"]);
    expect(r.gone).toEqual([]);
  });
  test("the same text again is the same clip: moved up, counted, with the newest source and its pin kept", () => {
    const list = [clip("c-bbbbbbbb", { at: 3_000 }), clip("c-aaaaaaaa", { text: "hello", source: "shell", from: "atlas", pinned: true, at: 2_000 })];
    const r = putClip(list, { text: "hello", source: "cli" }, 9_000, "c-zzzzzzzz");
    expect(r.clip).toEqual({ id: "c-aaaaaaaa", text: "hello", source: "cli", createdAt: 1_000, at: 9_000, count: 2, pinned: true });
    expect(r.clips.map((c) => c.id)).toEqual(["c-aaaaaaaa", "c-bbbbbbbb"]);
  });
  test("past the cap, the oldest unpinned clip goes and is named", () => {
    const list = Array.from({ length: CLIP_KEEP }, (_, i) => clip(mintClipId(() => new Uint8Array([i >> 8, i & 255, 1, 1, 1])), { text: `t${i}`, at: 10_000 + i }));
    const ids = new Set(list.map((c) => c.id));
    expect(ids.size).toBe(CLIP_KEEP);
    const pinned = clip("c-pinnedaa", { text: "pinned", at: 1, pinned: true });
    const r = putClip([...list, pinned], { text: "fresh", source: "page" }, 20_000, "c-freshaaa");
    expect(r.clips).toHaveLength(CLIP_KEEP + 1);
    expect(r.gone).toEqual([list[0]?.id ?? ""]);
    expect(r.clips.some((c) => c.id === "c-pinnedaa")).toBe(true);
  });
});

describe("pruneClips", () => {
  test("unpinned clips older than the age go; pinned ones stay; nothing gone is the same list", () => {
    const now = 100 * DAY;
    const list = [clip("c-aaaaaaaa", { at: now - (CLIP_DAYS + 1) * DAY }), clip("c-bbbbbbbb", { at: now - (CLIP_DAYS + 1) * DAY, pinned: true }), clip("c-cccccccc", { at: now - DAY })];
    const r = pruneClips(list, now);
    expect(r.gone).toEqual(["c-aaaaaaaa"]);
    expect(r.clips.map((c) => c.id)).toEqual(["c-cccccccc", "c-bbbbbbbb"]);
    const fresh = [clip("c-cccccccc", { at: now })];
    expect(pruneClips(fresh, now).clips).toBe(fresh);
  });
});

describe("takeClip and applyClips", () => {
  test("taking a clip again moves it up and counts it, its source as it was", () => {
    const r = takeClip([clip("c-bbbbbbbb", { at: 3_000 }), clip("c-aaaaaaaa", { source: "shell", at: 2_000 })], "c-aaaaaaaa", 7_000);
    expect(r?.clip).toEqual(clip("c-aaaaaaaa", { source: "shell", at: 7_000, count: 2 }));
    expect(r?.clips.map((c) => c.id)).toEqual(["c-aaaaaaaa", "c-bbbbbbbb"]);
    expect(takeClip([], "c-aaaaaaaa", 1)).toBeNull();
  });
  test("a change applies by id, newest first, and applying it twice changes nothing", () => {
    const list = [clip("c-aaaaaaaa", { at: 2 }), clip("c-bbbbbbbb", { at: 1 })];
    const change = { put: [clip("c-bbbbbbbb", { at: 5, count: 2 }), clip("c-cccccccc", { at: 3 })], gone: ["c-aaaaaaaa"] };
    const once = applyClips(list, change);
    expect(once.map((c) => [c.id, c.at])).toEqual([
      ["c-bbbbbbbb", 5],
      ["c-cccccccc", 3],
    ]);
    expect(applyClips(once, change)).toEqual(once);
    expect(sortClips([clip("c-aaaaaaaa", { at: 1, createdAt: 1 }), clip("c-bbbbbbbb", { at: 1, createdAt: 2 })]).map((c) => c.id)).toEqual(["c-bbbbbbbb", "c-aaaaaaaa"]);
  });
});

describe("clipKind", () => {
  test("each kind from its shape", () => {
    const cases: [string, ReturnType<typeof clipKind>][] = [
      ["https://github.com/eric/canopy/pull/412", "link"],
      ["http://127.0.0.1:7850/?view=library", "link"],
      ["#3e7a38", "color"],
      ["oklch(62% 0.12 140 / 0.8)", "color"],
      ["rgb(12, 34, 56)", "color"],
      ["4fadb455", "hash"],
      ["/Users/ericbaruch/dev/canopy/src/core/clips.ts", "path"],
      ["~/.config/canopy/clips.json", "path"],
      ["src/core/clips.ts", "path"],
      ['{"a": 1, "b": [2, 3]}', "json"],
      ["[1, 2, 3]", "json"],
      ["git push origin main", "command"],
      ["$ bun run build", "command"],
      ["docker compose \\\n  up -d", "command"],
      ["function a() {\n  return 1;\n}", "code"],
      ["Copied text from a page,\nover two lines.", "text"],
      ["hello there", "text"],
      ["deadbeef", "text"],
      ["javascript:alert(1)", "text"],
      ["red; background: url(x)", "text"],
    ];
    for (const [text, kind] of cases) expect([text, clipKind(text)]).toEqual([text, kind]);
  });
  test("a swatch only for a color written out, never for other text", () => {
    expect(swatchOf("  #abc ")).toBe("#abc");
    expect(swatchOf("rgb(1,2,3); color: red")).toBeNull();
    expect(swatchOf("url(javascript:x)")).toBeNull();
  });
});

describe("lineCount and clipLine", () => {
  test("lines without the trailing newlines; one line folded and cut", () => {
    expect(lineCount("a\nb\n\n")).toBe(2);
    expect(lineCount("one")).toBe(1);
    expect(clipLine("  a\n\n b  ")).toBe("a b");
    expect(clipLine("x".repeat(10), 5)).toBe("xxxx…");
  });
});

describe("agoWord", () => {
  test("now, minutes, hours and days", () => {
    expect(agoWord(1_000, 20_000)).toBe("now");
    expect(agoWord(0, 4 * 60_000)).toBe("4m");
    expect(agoWord(0, 2 * 3_600_000)).toBe("2h");
    expect(agoWord(0, 3 * DAY)).toBe("3d");
    expect(agoWord(5_000, 1_000)).toBe("now");
  });
});
