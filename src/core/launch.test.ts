import { describe, expect, test } from "bun:test";
import {
  buildKey,
  describeLaunch,
  fillLaunch,
  fmtBytes,
  globToRegExp,
  isDefaultLaunch,
  isSafeAssetName,
  isSafeTag,
  launchTarget,
  normalizeLaunch,
  parseBuildKey,
  parsePulls,
  parseReleases,
  pickAsset,
  unpackKind,
  type Platform,
} from "./launch";
import { DEFAULT_LAUNCH } from "./types";

const mac: Platform = { os: "darwin", arch: "arm64" };
const macIntel: Platform = { os: "darwin", arch: "x64" };
const linux: Platform = { os: "linux", arch: "x64" };

describe("normalizeLaunch", () => {
  test("blank for anything that is not an object", () => {
    expect(normalizeLaunch(null)).toEqual(DEFAULT_LAUNCH);
    expect(normalizeLaunch("bun run dev")).toEqual(DEFAULT_LAUNCH);
  });
  test("keeps each line trimmed and flattens line breaks", () => {
    const l = normalizeLaunch({ build: "  bun run build\n", run: "bun\nrun dev", asset: 7, launch: "open {file}" });
    expect(l).toEqual({ build: "bun run build", run: "bun run dev", asset: "", launch: "open {file}" });
  });
  test("isDefaultLaunch and describeLaunch", () => {
    expect(isDefaultLaunch(DEFAULT_LAUNCH)).toBe(true);
    expect(describeLaunch(DEFAULT_LAUNCH)).toBe("defaults");
    expect(describeLaunch({ ...DEFAULT_LAUNCH, run: "x", asset: "*.dmg" })).toBe("run · asset");
  });
});

describe("fillLaunch", () => {
  test("quotes the file for the shell", () => {
    expect(fillLaunch("open -a {file}", "/tmp/My App.app")).toBe("open -a '/tmp/My App.app'");
    expect(fillLaunch("{file} --flag", "/tmp/it's")).toBe("'/tmp/it'\\''s' --flag");
  });
});

describe("build keys", () => {
  test("round trip", () => {
    expect(parseBuildKey(buildKey({ kind: "release", tag: "v1.2.0" }))).toEqual({ kind: "release", tag: "v1.2.0" });
    expect(parseBuildKey(buildKey({ kind: "pr", number: 42 }))).toEqual({ kind: "pr", number: 42 });
    expect(parseBuildKey("local")).toEqual({ kind: "local" });
  });
  test("refuses what nothing here made", () => {
    expect(parseBuildKey("release:../x")).toBeNull();
    expect(parseBuildKey("pr:x")).toBeNull();
    expect(parseBuildKey("other")).toBeNull();
  });
  test("safe names", () => {
    expect(isSafeTag("v1.0.0-rc.1+build")).toBe(true);
    expect(isSafeTag("..")).toBe(false);
    expect(isSafeTag(".hidden")).toBe(false);
    expect(isSafeTag("a/b")).toBe(false);
    expect(isSafeAssetName("App-1.0.dmg")).toBe(true);
    expect(isSafeAssetName("../App.dmg")).toBe(false);
    expect(isSafeAssetName("")).toBe(false);
  });
});

describe("parseReleases", () => {
  test("keeps tag, name, when and the assets; drops drafts", () => {
    const body = [
      {
        tag_name: "v2.0",
        name: "Two",
        prerelease: false,
        draft: false,
        published_at: "2026-09-17T15:23:22Z",
        html_url: "https://github.com/o/n/releases/tag/v2.0",
        assets: [
          { name: "app-macos.dmg", size: 10, browser_download_url: "https://x/app-macos.dmg", url: "https://api/1" },
          { name: "", size: 1, browser_download_url: "https://x/none" },
        ],
      },
      { tag_name: "v3.0", draft: true, assets: [] },
      { tag_name: "weekly", prerelease: true, assets: "no" },
      "junk",
    ];
    const rel = parseReleases(body);
    expect(rel.map((r) => r.tag)).toEqual(["v2.0", "weekly"]);
    expect(rel[0]?.assets).toEqual([
      { name: "app-macos.dmg", size: 10, url: "https://x/app-macos.dmg", apiUrl: "https://api/1" },
    ]);
    expect(rel[0]?.publishedAt).toBe(Date.parse("2026-09-17T15:23:22Z"));
    expect(rel[1]?.name).toBe("weekly");
    expect(rel[1]?.prerelease).toBe(true);
  });
  test("a non-list is an error", () => {
    expect(() => parseReleases({ message: "Not Found" })).toThrow();
  });
});

describe("parsePulls", () => {
  test("number, title, author, branch, draft, when", () => {
    const pulls = parsePulls([
      {
        number: 7,
        title: "Fix",
        user: { login: "ann" },
        head: { ref: "fix-it" },
        draft: true,
        updated_at: "2026-09-01T00:00:00Z",
        html_url: "https://github.com/o/n/pull/7",
      },
      { number: 0, title: "no" },
    ]);
    expect(pulls).toEqual([
      {
        number: 7,
        title: "Fix",
        author: "ann",
        branch: "fix-it",
        draft: true,
        updatedAt: Date.parse("2026-09-01T00:00:00Z"),
        url: "https://github.com/o/n/pull/7",
      },
    ]);
  });
});

describe("globToRegExp", () => {
  test("star and question mark, case-insensitive, whole name", () => {
    const re = globToRegExp("*-macos-arm64.dmg");
    expect(re.test("App-1.0-macOS-arm64.dmg")).toBe(true);
    expect(re.test("App-1.0-macos-arm64.dmg.sha256")).toBe(false);
    expect(globToRegExp("app-?.zip").test("app-1.zip")).toBe(true);
    expect(globToRegExp("a.b").test("axb")).toBe(false);
  });
});

describe("pickAsset", () => {
  const freecad = [
    "FreeCAD_1.0.0-conda-Linux-aarch64-py311.AppImage",
    "FreeCAD_1.0.0-conda-Linux-x86_64-py311.AppImage",
    "FreeCAD_1.0.0-conda-Linux-x86_64-py311.AppImage-SHA256.txt",
    "FreeCAD_1.0.0-conda-Windows-x86_64-py311.7z",
    "FreeCAD_1.0.0-conda-macOS-arm64-py311.dmg",
    "FreeCAD_1.0.0-conda-macOS-x86_64-py311.dmg",
    "FreeCAD_1.0.0-conda-macOS-arm64-py311.dmg-SHA256.txt",
  ];
  test("the platform's build, arch included", () => {
    expect(pickAsset(freecad, mac)).toBe("FreeCAD_1.0.0-conda-macOS-arm64-py311.dmg");
    expect(pickAsset(freecad, macIntel)).toBe("FreeCAD_1.0.0-conda-macOS-x86_64-py311.dmg");
    expect(pickAsset(freecad, linux)).toBe("FreeCAD_1.0.0-conda-Linux-x86_64-py311.AppImage");
  });
  test("a glob wins over the guess", () => {
    expect(pickAsset(freecad, mac, "*Linux-aarch64*")).toBe("FreeCAD_1.0.0-conda-Linux-aarch64-py311.AppImage");
    expect(pickAsset(freecad, mac, "*.7z")).toBe("FreeCAD_1.0.0-conda-Windows-x86_64-py311.7z");
    expect(pickAsset(freecad, mac, "*.msi")).toBeNull();
  });
  test("prefers the disk image over the zip on a mac, the universal build when no arch fits", () => {
    const names = ["Tool-1.0-mac.zip", "Tool-1.0-mac.dmg", "Tool-1.0-linux.tar.gz"];
    expect(pickAsset(names, mac)).toBe("Tool-1.0-mac.dmg");
    expect(pickAsset(["Tool-universal-macos.dmg", "Tool-linux-x64.tar.gz"], mac)).toBe("Tool-universal-macos.dmg");
  });
  test("nothing for this machine is null, not a guess", () => {
    expect(pickAsset(["Tool-linux-x64.tar.gz", "Tool-win64.exe"], mac)).toBeNull();
    expect(pickAsset(["source.tar.gz", "checksums.txt"], mac)).toBeNull();
  });
  test("one candidate with no platform word is taken as-is", () => {
    expect(pickAsset(["tool.jar", "tool.jar.sha256"], mac)).toBe("tool.jar");
    expect(pickAsset(["tool-linux.AppImage"], mac)).toBeNull();
  });
  test("a source archive is not a build", () => {
    expect(pickAsset(["Tool-1.0-macos-arm64.zip", "Tool-1.0-source.zip"], mac)).toBe("Tool-1.0-macos-arm64.zip");
  });
});

describe("unpackKind and launchTarget", () => {
  test("by extension", () => {
    expect(unpackKind("App.dmg")).toBe("dmg");
    expect(unpackKind("App.zip")).toBe("zip");
    expect(unpackKind("app.tar.gz")).toBe("tar");
    expect(unpackKind("app.tgz")).toBe("tar");
    expect(unpackKind("App.AppImage")).toBe("exec");
    expect(unpackKind("tool")).toBe("exec");
    expect(unpackKind("App.pkg")).toBe("keep");
  });
  test("an app bundle first, then a binary, then the asset for open", () => {
    expect(launchTarget(["Foo.app", "readme.txt"], "Foo.zip")).toEqual({ kind: "app", name: "Foo.app" });
    expect(launchTarget(["Foo.AppImage"], "Foo.AppImage")).toEqual({ kind: "bin", name: "Foo.AppImage" });
    expect(launchTarget(["foo", "LICENSE"], "foo-1.0-linux.tar.gz")).toEqual({ kind: "bin", name: "foo" });
    expect(launchTarget(["foo", "bar", "LICENSE"], "foo-1.0-linux.tar.gz")).toEqual({ kind: "bin", name: "foo" });
    expect(launchTarget(["Foo.pkg"], "Foo.pkg")).toEqual({ kind: "open", name: "Foo.pkg" });
    expect(launchTarget(["README.md"], "Foo.zip")).toBeNull();
  });
});

describe("fmtBytes", () => {
  test("units", () => {
    expect(fmtBytes(512)).toBe("512 B");
    expect(fmtBytes(2048)).toBe("2 KB");
    expect(fmtBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(fmtBytes(3 * 1024 * 1024 * 1024)).toBe("3.00 GB");
  });
});
