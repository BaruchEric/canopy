import { describe, expect, test } from "bun:test";
import { isShareCache, parseShareMeta, shareCache, shareId, shareIdOf, sharedText, staleShares, SHARE_KEEP } from "./sharetarget";

const at = 1_794_096_000_000;

describe("a share's text", () => {
  test("a link shared from a browser stays a link: the page's title is dropped", () => {
    expect(sharedText({ title: "canopy - GitHub", text: "https://github.com/eric/canopy", url: "" })).toBe("https://github.com/eric/canopy");
  });
  test("url is added under the words unless they already carry it", () => {
    expect(sharedText({ title: "", text: "look at this", url: "https://a.example/x" })).toBe("look at this\nhttps://a.example/x");
    expect(sharedText({ title: "", text: "look https://a.example/x", url: "https://a.example/x" })).toBe("look https://a.example/x");
    expect(sharedText({ title: "t", text: "", url: " https://a.example/x " })).toBe("https://a.example/x");
  });
  test("a title alone is kept, and nothing is nothing", () => {
    expect(sharedText({ title: " A note ", text: "  ", url: "" })).toBe("A note");
    expect(sharedText({ title: "", text: "", url: "" })).toBe("");
  });
});

describe("the worker's words read back", () => {
  test("a whole meta survives", () => {
    const m = { title: "t", text: "x", url: "u", files: [{ name: "a.png", type: "image/png", size: 12 }] };
    expect(parseShareMeta(JSON.parse(JSON.stringify(m)))).toEqual(m);
  });
  test("anything malformed reads as nothing shared", () => {
    expect(parseShareMeta(null)).toEqual({ title: "", text: "", url: "", files: [] });
    expect(parseShareMeta("x")).toEqual({ title: "", text: "", url: "", files: [] });
    expect(parseShareMeta({ title: 3, files: "no" })).toEqual({ title: "", text: "", url: "", files: [] });
    expect(parseShareMeta({ files: [null, 4, { name: 1, size: -2 }] }).files).toEqual([{ name: "", type: "", size: 0 }]);
  });
});

describe("share caches", () => {
  const id = shareId(at, "ab12cd34");
  test("an id is the moment and eight letters or digits, and nothing else passes", () => {
    expect(shareIdOf(id)).toBe(id);
    for (const bad of [null, "", "failed", "1-ab12cd34", `${at}-AB12CD34`, `${at}-ab12cd3`, `${at}-ab12cd34/../x`]) expect(shareIdOf(bad)).toBeNull();
  });
  test("a share's cache is named for it", () => {
    expect(shareCache(id)).toBe(`canopy-share-${id}`);
    expect(isShareCache(shareCache(id))).toBe(true);
    expect(isShareCache("canopy-0.2.0 (1ac8fe7, 2026-10-26)")).toBe(false);
  });
  test("a share no page took goes after an hour, as does one not named as ours", () => {
    const fresh = shareCache(id);
    const old = shareCache(shareId(at - SHARE_KEEP - 1, "zz99zz99"));
    expect(staleShares([fresh, old, "canopy-share-junk", "canopy-dev"], at + 1000)).toEqual([old, "canopy-share-junk"]);
  });
});
