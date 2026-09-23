import { describe, expect, test } from "bun:test";
import { DEFAULT_SEED, normalizePeers, normalizeSeed } from "./peers";

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
