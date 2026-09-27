import { describe, expect, test } from "bun:test";
import {
  BUSY_MARKERS, DEFAULT_SEED, ffTarget, globMatch, isSafeRel, linkPeers, normalizePeers, normalizeSeed,
  parseNameStatus, parseQuotedWords, parseRefLines, parseWipLines, peerMissing, peerRefspecs, peerUnreachable, peerUrl, repoWanted,
  seedWanted,
} from "./peers";
import type { PeerState, Repo } from "./types";

describe("normalizePeers", () => {
  test("keeps a well-formed entry and defaults role to git", () => {
    expect(normalizePeers([{ name: "mini", alias: "mini-peer", root: "dev" }])).toEqual([
      { name: "mini", alias: "mini-peer", root: "dev", role: "git" },
    ]);
  });
  test("keeps repos globs and the mirror role", () => {
    const [p] = normalizePeers([{ name: "qnap", alias: "nas", root: "/share/x", role: "mirror", repos: ["a/*"] }]);
    expect(p).toEqual({ name: "qnap", alias: "nas", root: "/share/x", role: "mirror", repos: ["a/*"] });
  });
  test("drops entries with a bad name, alias or root, and duplicates", () => {
    expect(
      normalizePeers([
        { name: "Mini!", alias: "a", root: "dev" },
        { name: "ok", alias: "-oProxyCommand=x", root: "dev" },
        { name: "ok", alias: "a", root: "" },
        { name: "origin", alias: "a", root: "dev" },
        { name: "gpd", alias: "gpd", root: "dev" },
        { name: "gpd", alias: "other", root: "dev" },
        "junk",
      ]),
    ).toEqual([{ name: "gpd", alias: "gpd", root: "dev", role: "git" }]);
  });
  test("anything but an array is no peers", () => {
    expect(normalizePeers(null)).toEqual([]);
    expect(normalizePeers({ name: "x" })).toEqual([]);
  });
});

describe("normalizeSeed", () => {
  test("defaults when missing, keeps plain names, drops paths", () => {
    expect(normalizeSeed(undefined)).toEqual(DEFAULT_SEED);
    expect(normalizeSeed([".env", "config/.env", "", 3, ".env.*.local"])).toEqual([".env", ".env.*.local"]);
  });
});

const mini = { name: "mini", alias: "mini-peer", root: "dev", role: "git" as const };

describe("urls and refspecs", () => {
  test("ssh peer url is alias:root/id; a local peer is a path", () => {
    expect(peerUrl(mini, "dev-tools/canopy")).toBe("mini-peer:dev/dev-tools/canopy");
    expect(peerUrl({ ...mini, alias: null, root: "/tmp/p" }, "a")).toBe("/tmp/p/a");
  });
  test("refspecs keep branches and wip in the peer's namespace", () => {
    expect(peerRefspecs("mini")).toEqual([
      "+refs/heads/*:refs/remotes/mini/*",
      "+refs/wip/*:refs/peer-wip/mini/*",
    ]);
  });
});

describe("globs", () => {
  test("star stays inside a folder, double star crosses", () => {
    expect(globMatch("dev-tools/*", "dev-tools/canopy")).toBe(true);
    expect(globMatch("dev-tools/*", "dev-tools/canopy/sub")).toBe(false);
    expect(globMatch("dev-tools/**", "dev-tools/canopy/sub")).toBe(true);
    expect(globMatch(".env.*.local", ".env.dev.local")).toBe(true);
    expect(globMatch("a.b", "aXb")).toBe(false);
  });
  test("repoWanted: no globs means every repo", () => {
    expect(repoWanted(mini, "x/y")).toBe(true);
    expect(repoWanted({ ...mini, repos: ["web-apps/keel"] }, "x/y")).toBe(false);
  });
  test("seedWanted matches the basename", () => {
    expect(seedWanted([".env"], "apps/api/.env")).toBe(true);
    expect(seedWanted([".env"], ".env.example")).toBe(false);
  });
});

describe("ffTarget", () => {
  const contains = (pairs: string[]) => (a: string, b: string) => a === b || pairs.includes(`${a}>${b}`);
  test("current when no peer is ahead", () => {
    expect(ffTarget("main", [{ peer: "mini", hash: "a", ahead: 0, behind: 2 }], contains([]))).toEqual({ diverged: [] });
  });
  test("fast-forwards to the one peer ahead", () => {
    expect(ffTarget("main", [{ peer: "mini", hash: "b", ahead: 3, behind: 0 }], contains([]))).toEqual({
      to: { peer: "mini", hash: "b" }, diverged: [],
    });
  });
  test("picks the tip that contains the others", () => {
    const tips = [
      { peer: "mini", hash: "b", ahead: 1, behind: 0 },
      { peer: "gpd", hash: "c", ahead: 2, behind: 0 },
    ];
    expect(ffTarget("main", tips, contains(["c>b"])).to).toEqual({ peer: "gpd", hash: "c" });
  });
  test("peers that disagree with each other: nothing moves, both listed", () => {
    const tips = [
      { peer: "mini", hash: "b", ahead: 1, behind: 0 },
      { peer: "gpd", hash: "c", ahead: 1, behind: 0 },
    ];
    const d = ffTarget("main", tips, contains([]));
    expect(d.to).toBeUndefined();
    expect(d.diverged.map((x) => x.peer).sort()).toEqual(["gpd", "mini"]);
  });
  test("a peer diverged from us is reported, another may still fast-forward", () => {
    const tips = [
      { peer: "mini", hash: "b", ahead: 2, behind: 1 },
      { peer: "gpd", hash: "c", ahead: 1, behind: 0 },
    ];
    const d = ffTarget("feat/x", tips, contains([]));
    expect(d.to).toEqual({ peer: "gpd", hash: "c" });
    expect(d.diverged).toEqual([{ branch: "feat/x", peer: "mini", ahead: 2, behind: 1 }]);
  });
});

describe("parsers", () => {
  test("ref lines", () => {
    expect(parseRefLines("aaa refs/heads/main\nbbb refs/heads/feat/x\n")).toEqual([
      { ref: "refs/heads/main", hash: "aaa" },
      { ref: "refs/heads/feat/x", hash: "bbb" },
    ]);
  });
  test("ref lines skips lines with no space", () => {
    expect(parseRefLines("aaa refs/heads/main\nmalformed\nccc refs/heads/other\n")).toEqual([
      { ref: "refs/heads/main", hash: "aaa" },
      { ref: "refs/heads/other", hash: "ccc" },
    ]);
  });
  test("wip lines strip the peer namespace and keep slashes in the branch", () => {
    expect(parseWipLines("h1 1790000000 p1 refs/peer-wip/mini/feat/x\n", "mini")).toEqual([
      { peer: "mini", branch: "feat/x", at: 1790000000000, parent: "p1", hash: "h1" },
    ]);
  });
  test("name-status pairs, with the list capped and the count kept", () => {
    const out = "M\0a.txt\0A\0dir/with space.md\0D\0gone\0";
    expect(parseNameStatus(out)).toEqual({
      files: 3,
      paths: [
        { status: "M", path: "a.txt" },
        { status: "A", path: "dir/with space.md" },
        { status: "D", path: "gone" },
      ],
    });
    expect(parseNameStatus(out, 1)).toEqual({ files: 3, paths: [{ status: "M", path: "a.txt" }] });
    expect(parseNameStatus("")).toEqual({ files: 0, paths: [] });
  });
  test("missing vs unreachable", () => {
    expect(peerMissing("fatal: '/x' does not appear to be a git repository")).toBe(true);
    expect(peerMissing("canopy-peer: not a repo: x")).toBe(true);
    expect(peerUnreachable("ssh: connect to host mac-peer port 22: Operation timed out")).toBe(true);
    expect(peerUnreachable("ssh: Could not resolve hostname mac-peer")).toBe(true);
    expect(peerUnreachable("Connection closed by 100.1.2.3 port 22")).toBe(true);
    expect(peerUnreachable("fatal: bad object")).toBe(false);
  });
  test("busy markers cover every in-progress operation", () => {
    expect(BUSY_MARKERS).toEqual(["MERGE_HEAD", "rebase-merge", "rebase-apply", "CHERRY_PICK_HEAD", "REVERT_HEAD", "BISECT_LOG", "index.lock"]);
  });
});

describe("parseQuotedWords", () => {
  test("reads what git and remoteCommand send", () => {
    expect(parseQuotedWords("git-upload-pack 'dev/São Paulo'")).toEqual(["git-upload-pack", "dev/São Paulo"]);
    expect(parseQuotedWords("'canopy-peer' 'seed' 'a b' '.env'")).toEqual(["canopy-peer", "seed", "a b", ".env"]);
    expect(parseQuotedWords("'it'\\''s'")).toEqual(["it's"]);
  });
  test("handles backslash escaping for any character, like git sq_quote", () => {
    expect(parseQuotedWords("git-upload-pack 'dev/a'\\!'b'")).toEqual(["git-upload-pack", "dev/a!b"]);
    expect(parseQuotedWords("a\\;b")).toEqual(["a;b"]);
  });
  test("refuses anything a shell would expand or chain", () => {
    for (const bad of ["a; rm -rf ~", "a | b", "$(x)", "`x`", "a && b", "\"$HOME\"", "a > f", "'unterminated"]) {
      expect(parseQuotedWords(bad)).toBeNull();
    }
  });
  test("refuses a trailing lone backslash or backslash-newline", () => {
    expect(parseQuotedWords("a\\")).toBeNull();
    expect(parseQuotedWords("a\\\n")).toBeNull();
  });
});

describe("isSafeRel", () => {
  test("accepts a plain relative id or file name, nested paths included", () => {
    expect(isSafeRel("proj")).toBe(true);
    expect(isSafeRel("dev-tools/canopy")).toBe(true);
    expect(isSafeRel(".env")).toBe(true);
    expect(isSafeRel("a/b/c")).toBe(true);
  });
  test("rejects traversal, empty segments, and absolute paths", () => {
    expect(isSafeRel("../evil")).toBe(false);
    expect(isSafeRel("../../x")).toBe(false);
    expect(isSafeRel("a/../b")).toBe(false);
    expect(isSafeRel("a/./b")).toBe(false);
    expect(isSafeRel("a//b")).toBe(false);
    expect(isSafeRel("a/")).toBe(false);
    expect(isSafeRel("")).toBe(false);
    expect(isSafeRel(".")).toBe(false);
    expect(isSafeRel("..")).toBe(false);
    expect(isSafeRel("/etc/passwd")).toBe(false);
  });
  test("rejects a leading dash on the whole name and NUL or newline", () => {
    expect(isSafeRel("-rf")).toBe(false);
    expect(isSafeRel("--upload-pack=x")).toBe(false);
    expect(isSafeRel("a\0b")).toBe(false);
    expect(isSafeRel("a\nb")).toBe(false);
    // a dash mid-path is not a leading dash on the whole name
    expect(isSafeRel("web-apps/-foo")).toBe(true);
  });
});

describe("linkPeers", () => {
  test("attaches state by id and keeps untouched repos identical", () => {
    const a = { id: "a" } as Repo;
    const b = { id: "b" } as Repo;
    const st = { at: 1 } as PeerState;
    const out = linkPeers([a, b], new Map([["a", st]]));
    expect(out[0]).toEqual({ id: "a", peers: st } as Repo);
    expect(out[1]).toBe(b);
  });
});
