import { describe, expect, test } from "bun:test";
import {
  deployReady,
  deploymentUrl,
  frameworkOf,
  isVercelAppUrl,
  productionUrl,
  repoCandidates,
  servesFile,
  smokeRefusal,
  strangeAliases,
  vercelArgs,
  vercelConfigRefusal,
  vercelProject,
  withCanopyIgnored,
} from "./deploy";

describe("deployReady", () => {
  const env = { vercelToken: true, vercelCli: true, backend: "mini" };
  test("vercel with a token and the CLI is ready; each gap says what to add", () => {
    expect(deployReady("vercel", env)).toBe(null);
    expect(deployReady("vercel", { ...env, vercelToken: false })).toBe("add VERCEL_TOKEN to mini's .env");
    expect(deployReady("vercel", { ...env, vercelCli: false })).toBe("the vercel CLI is not installed on mini");
    expect(deployReady("vercel+convex", env)).toBe("deploying to vercel+convex arrives in phase 4");
    expect(deployReady("mini", env)).toBe("deploying to mini arrives in phase 4");
  });
});

describe("names", () => {
  test("repo names try the slug, then -2 to -9, always lowercase and safe", () => {
    expect(repoCandidates("coin-counter").slice(0, 3)).toEqual(["coin-counter", "coin-counter-2", "coin-counter-3"]);
    expect(repoCandidates("coin-counter")).toHaveLength(9);
    expect(repoCandidates("Ünsafe name!")[0]).toBe("unsafe-name");
    expect(repoCandidates("---")[0]).toBe("sprout");
  });
  test("a vercel project name keeps to its rules", () => {
    expect(vercelProject("coin-counter-2")).toBe("coin-counter-2");
    expect(vercelProject("A----B")).toBe("a--b");
    expect(vercelProject("x".repeat(120))).toHaveLength(100);
  });
});

describe("the deploy's answers", () => {
  test("only an https vercel.app address counts", () => {
    expect(isVercelAppUrl("https://coin-counter.vercel.app")).toBe(true);
    expect(isVercelAppUrl("https://coin-counter-abc123-eric.vercel.app/")).toBe(true);
    expect(isVercelAppUrl("http://coin-counter.vercel.app")).toBe(false);
    expect(isVercelAppUrl("https://coins.example.com")).toBe(false);
    expect(isVercelAppUrl("https://evil.com/.vercel.app")).toBe(false);
  });
  test("the deployment url is the last vercel.app line vercel deploy printed", () => {
    const out = "Vercel CLI 61.1.0\nhttps://coin-counter-abc123-eric.vercel.app\n";
    expect(deploymentUrl(out)).toBe("https://coin-counter-abc123-eric.vercel.app");
    expect(deploymentUrl("Error: no\n")).toBe(null);
  });
  test("the production url is the shortest vercel.app alias, else the deployment's own", () => {
    expect(productionUrl(["coin-counter-eric.vercel.app", "coin-counter.vercel.app", "coins.example.com"], "https://d.vercel.app")).toBe("https://coin-counter.vercel.app");
    expect(productionUrl([], "https://d.vercel.app")).toBe("https://d.vercel.app");
  });
  test("a smoke GET goes live on 2xx or 3xx; 401 and 403 name the protection", () => {
    expect(smokeRefusal(200, "https://x.vercel.app")).toBe(null);
    expect(smokeRefusal(401, "https://x.vercel.app")).toBe("https://x.vercel.app answers 401: Vercel's deployment protection may cover it; turn it off for production in the project's settings, then resume");
    expect(smokeRefusal(500, "https://x.vercel.app")).toBe("https://x.vercel.app answers 500");
  });
  test("the vercel argv never carries the token", () => {
    expect(vercelArgs("link", "coin-counter", null)).toEqual(["vercel", "link", "--yes", "--project", "coin-counter"]);
    expect(vercelArgs("deploy", "coin-counter", "team-x")).toEqual(["vercel", "deploy", "--prod", "--yes", "--scope", "team-x"]);
  });
});

describe("what a deploy takes from the seed", () => {
  test("vercelConfigRefusal: alias and unknown keys refused, the list and no file let through", () => {
    expect(vercelConfigRefusal([], null)).toBe(null);
    expect(vercelConfigRefusal(["vercel.json"], JSON.stringify({ $schema: "x", buildCommand: "b", cleanUrls: true, headers: [] }))).toBe(null);
    expect(vercelConfigRefusal(["vercel.json"], JSON.stringify({ alias: "a.example" }))).toContain("sets alias");
    expect(vercelConfigRefusal(["vercel.json"], JSON.stringify({ github: { enabled: false }, scope: "t" }))).toContain("sets github, scope");
    expect(vercelConfigRefusal(["vercel.json"], "[]")).toBe("vercel.json is not a JSON object");
    for (const n of ["now.json", "vercel.toml", "vercel.ts", "vercel.mjs"]) expect(vercelConfigRefusal([n], null)).toContain(`${n} is a Vercel config`);
  });
  test("vercelConfigRefusal: a name that differs only by case is refused, since a Mac reads it as the real one", () => {
    for (const n of ["VERCEL.TS", "Vercel.toml", "Now.JSON", "vercel.MJS"]) expect(vercelConfigRefusal([n], null)).toContain(`${n} is a Vercel config`);
    expect(vercelConfigRefusal(["Vercel.json"], "{}")).toContain("only by case");
    expect(vercelConfigRefusal(["vercel.json", "README.md"], "{}")).toBe(null);
  });
  test("frameworkOf: next over vite, either dependency list, nothing when unclear", () => {
    expect(frameworkOf(JSON.stringify({ devDependencies: { vite: "7" } }))).toBe("vite");
    expect(frameworkOf(JSON.stringify({ dependencies: { next: "16" }, devDependencies: { vite: "7" } }))).toBe("nextjs");
    expect(frameworkOf(JSON.stringify({ dependencies: { react: "19" } }))).toBe(null);
    expect(frameworkOf("{")).toBe(null);
    expect(frameworkOf(null)).toBe(null);
  });
  test("withCanopyIgnored: one .canopy/ line, last", () => {
    expect(withCanopyIgnored(null)).toBe(".canopy/\n");
    expect(withCanopyIgnored(".canopy/\n!.canopy/a.md\n\n")).toBe("!.canopy/a.md\n.canopy/\n");
  });
  test("strangeAliases and servesFile", () => {
    expect(strangeAliases(["a.vercel.app", "https://b.vercel.app", "eric.example.com", "a.vercel.app.evil.com"])).toEqual(["eric.example.com", "a.vercel.app.evil.com"]);
    expect(servesFile("# Coin\n\nbody", "# Coin\n\nbody\n")).toBe(true);
    expect(servesFile("<!doctype html>", "# Coin\n")).toBe(false);
    expect(servesFile("anything", "  ")).toBe(false);
  });
});
