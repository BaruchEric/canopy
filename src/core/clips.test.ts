import { describe, expect, test } from "bun:test";
import {
  CLIP_CHARS,
  CLIP_DAYS,
  CLIP_KEEP,
  CLIP_NAME_CHARS,
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
  clipKey,
  fileKind,
  fileName,
  kindOf,
  looksSecretFile,
  mediaType,
  openable,
  parseClip,
  servedType,
  sizeWord,
  sniffType,
  textFile,
  textFileKind,
  textHead,
  type Clip,
  type ClipFile,
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
  test("an env line whose whole name is the word is one too, alone on its line", () => {
    for (const s of ["TOKEN=abcdefgh12345678", "PASSWORD=hunter22hunter22", "export API_KEY='abcdefgh1234'", "  SECRET_KEY = abcdefgh1234"]) {
      expect(looksSecret(s)).toBe(true);
    }
    // a value shorter than a secret, and a name with its = on the next line
    expect(looksSecret("TOKEN=$(cat f) run")).toBe(false);
    expect(looksSecret("GITHUB_TOKEN\n=ghx1234567890abcd")).toBe(false);
  });
  test("a long run of blank lines, capitals or dashes is read once, not from every place in it", () => {
    const started = performance.now();
    expect(looksSecret("\n".repeat(200_000))).toBe(false);
    expect(looksSecret(` \n`.repeat(100_000))).toBe(false);
    expect(looksSecret(`${"A_TOKEN".repeat(20_000)} x`)).toBe(false);
    expect(looksSecret("eyJ-".repeat(50_000))).toBe(false);
    // milliseconds now; the blank lines alone took half a minute before
    expect(performance.now() - started).toBeLessThan(5_000);
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

describe("files on the clipboard", () => {
  const file = (sha: string, over: Partial<ClipFile> = {}): ClipFile => ({ name: "shot.png", type: "image/png", size: 10, sha: sha.repeat(64).slice(0, 64), ...over });
  test("the same bytes are the same clip under any name, and never the same as text of the name", () => {
    let clips: Clip[] = [];
    clips = putClip(clips, { text: "shot.png", source: "device", file: file("a") }, 1_000, "c-aaaaaaaa").clips;
    clips = putClip(clips, { text: "shot.png", source: "canopy" }, 2_000, "c-bbbbbbbb").clips;
    const again = putClip(clips, { text: "other.png", source: "cli", file: file("a", { name: "other.png" }) }, 3_000, "c-cccccccc");
    expect(again.clip).toMatchObject({ id: "c-aaaaaaaa", text: "other.png", count: 2, file: { name: "other.png" } });
    expect(again.clips.map((c) => c.id)).toEqual(["c-aaaaaaaa", "c-bbbbbbbb"]);
    expect(clipKey(again.clip)).toBe(`file:${"a".repeat(64)}`);
    expect(clipKey({ text: "shot.png" })).toBe("shot.png");
  });
  test("a text that reads as a file's key is its own clip and leaves the file alone", () => {
    const kept = putClip([], { text: "shot.png", source: "device", file: file("a") }, 1_000, "c-aaaaaaaa").clips;
    const r = putClip(kept, { text: `file:${"a".repeat(64)}`, source: "cli" }, 2_000, "c-bbbbbbbb");
    expect(r.clip.id).toBe("c-bbbbbbbb");
    expect(r.clip.file).toBeUndefined();
    expect(r.clips.map((c) => [c.id, c.file?.name])).toEqual([["c-bbbbbbbb", undefined], ["c-aaaaaaaa", "shot.png"]]);
    // and the file kept again is still the file's clip, not the text's
    expect(putClip(r.clips, { text: "shot.png", source: "device", file: file("a") }, 3_000, "c-cccccccc").clip).toMatchObject({ id: "c-aaaaaaaa", count: 2 });
  });
  test("past the byte budget the oldest unpinned files go, the text and the pinned stay", () => {
    const now = 10_000;
    const clips = [
      clip("c-aaaaaaaa", { at: 9_000, file: file("a", { size: 400 }) }),
      clip("c-bbbbbbbb", { at: 8_000, text: "words" }),
      clip("c-cccccccc", { at: 7_000, file: file("c", { size: 400 }) }),
      clip("c-dddddddd", { at: 6_000, file: file("d", { size: 400 }), pinned: true }),
      clip("c-eeeeeeee", { at: 5_000, file: file("e", { size: 100 }) }),
    ];
    const out = pruneClips(clips, now, 600);
    expect(out.gone).toEqual(["c-cccccccc"]);
    expect(out.clips.map((c) => c.id)).toEqual(["c-aaaaaaaa", "c-bbbbbbbb", "c-dddddddd", "c-eeeeeeee"]);
  });
  test("a kept record with a file reads back with its name as its text; the old device source reads as device", () => {
    const c = parseClip({ id: "c-aaaaaaaa", text: "x", source: "clipboard", at: 5, file: { name: "a/b.pdf", type: "Application/PDF; q=1", size: 3, sha: "f".repeat(64) } });
    expect(c).toEqual({ id: "c-aaaaaaaa", text: "b.pdf", source: "device", createdAt: 5, at: 5, count: 1, file: { name: "b.pdf", type: "application/pdf", size: 3, sha: "f".repeat(64) } });
    expect(parseClip({ id: "c-aaaaaaaa", text: "x", source: "device", at: 5, file: { name: "a", size: 3, sha: "short" } })?.file).toBeUndefined();
  });
  test("names, types and sizes as kept", () => {
    expect(fileName("C:\\Users\\e\\shot 1.png")).toBe("shot 1.png");
    expect(fileName("../../etc/passwd")).toBe("passwd");
    expect(fileName("a\u0000b\nc")).toBe("abc");
    expect(fileName("..")).toBe("file");
    expect(fileName(undefined)).toBe("file");
    // the cap never leaves half of a two-unit character at the end
    expect(fileName(`${"a".repeat(CLIP_NAME_CHARS - 1)}\u{1F600}.png`)).toBe("a".repeat(CLIP_NAME_CHARS - 1));
    expect(fileName(`${"a".repeat(CLIP_NAME_CHARS - 2)}\u{1F600}.png`)).toBe(`${"a".repeat(CLIP_NAME_CHARS - 2)}\u{1F600}`);
    expect(mediaType("IMAGE/PNG")).toBe("image/png");
    expect(mediaType("text/html; charset=utf-8")).toBe("text/html");
    expect(mediaType("nonsense")).toBe("application/octet-stream");
    expect(sizeWord(512)).toBe("512 B");
    expect(sizeWord(14_000)).toBe("14 KB");
    expect(sizeWord(2.4 * 1024 * 1024)).toBe("2.4 MB");
    expect(sizeWord(25 * 1024 * 1024)).toBe("25 MB");
  });
  test("a key's file name is refused, its .pub is not", () => {
    for (const n of ["id_rsa", "id_ed25519", "id_ed25519_sk", "server.pem", "tls.key", "cert.p12", "vault.kdbx", ".env", ".env.local"]) expect({ n, secret: looksSecretFile(n) }).toEqual({ n, secret: true });
    for (const n of ["id_ed25519.pub", "keys.md", "envoy.yaml", "photo.png", "keynote.pdf"]) expect({ n, secret: looksSecretFile(n) }).toEqual({ n, secret: false });
  });
  test("text in a file, read for the secret check and the viewer; bytes that are not text are not", () => {
    expect(textHead(new TextEncoder().encode("hello, wörld"))).toBe("hello, wörld");
    expect(textHead(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 1]))).toBeNull();
    expect(textHead(new Uint8Array([0xff, 0xfe, 0xfd, 0xfc, 0xfb, 0xfa, 0xf9, 0xf8]))).toBeNull();
  });
  test("a pipe's first bytes name its type", () => {
    expect(sniffType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d]))).toEqual({ type: "image/png", ext: "png" });
    expect(sniffType(new TextEncoder().encode("%PDF-1.7"))).toEqual({ type: "application/pdf", ext: "pdf" });
    expect(sniffType(new TextEncoder().encode("RIFF\u0000\u0000\u0000\u0000WEBPVP8 "))).toEqual({ type: "image/webp", ext: "webp" });
    expect(sniffType(new TextEncoder().encode("plain"))).toBeNull();
  });
  test("kinds, what is served as itself, what may open in a tab, what reads as text", () => {
    expect(["image/png", "image/svg+xml", "application/pdf", "video/mp4", "audio/mpeg", "application/zip"].map(fileKind)).toEqual(["image", "image", "pdf", "video", "audio", "file"]);
    expect(kindOf({ text: "https://a.b/c" })).toBe("link");
    expect(kindOf({ text: "https://a.b/c", file: file("a", { type: "application/pdf" }) })).toBe("pdf");
    expect(servedType("image/png")).toBe("image/png");
    expect(servedType("image/svg+xml")).toBe("image/svg+xml");
    expect(servedType("text/html")).toBe("application/octet-stream");
    expect(servedType("application/javascript")).toBe("application/octet-stream");
    expect(openable("application/pdf")).toBe(true);
    expect(openable("image/svg+xml")).toBe(false);
    expect(openable("text/html")).toBe(false);
    expect(textFile({ name: "a.ts", type: "application/octet-stream", size: 100 })).toBe(true);
    expect(textFile({ name: "notes", type: "text/plain", size: 100 })).toBe(true);
    expect(textFile({ name: "a.png", type: "image/png", size: 100 })).toBe(false);
    expect(textFile({ name: "big.log", type: "text/plain", size: 600 * 1024 })).toBe(false);
    // an SVG is XML, and still draws as a picture
    expect(textFile({ name: "logo.svg", type: "image/svg+xml", size: 100 })).toBe(false);
    expect(textFileKind({ name: "notes.md", type: "text/markdown" }, "pick up the router")).toBe("text");
    expect(textFileKind({ name: "page.html", type: "text/html" }, "<h1>hi</h1>")).toBe("code");
    expect(textFileKind({ name: "a.json", type: "application/json" }, '{"a":1}')).toBe("json");
  });
});
