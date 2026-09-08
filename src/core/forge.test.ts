import { describe, expect, test } from "bun:test";
import {
  apiBase,
  forgeRepo,
  linkForgeClones,
  parseRepoPage,
  repoKey,
  reposUrl,
  type ForgeApiRepo,
} from "./forge";
import type { Repo, Source } from "./types";

const SOURCE: Source = {
  id: "beric",
  label: "git.beric.ca",
  kind: "forgejo",
  url: "http://192.168.1.76:3030",
  launch: false,
};

const api = (over: Partial<ForgeApiRepo> = {}): ForgeApiRepo => ({
  name: "canopy",
  full_name: "eric/canopy",
  description: "",
  html_url: "https://git.beric.ca/eric/canopy",
  ssh_url: "ssh://git@192.168.1.76:2222/eric/canopy.git",
  clone_url: "https://git.beric.ca/eric/canopy.git",
  default_branch: "main",
  updated_at: "2026-08-30T18:26:48-07:00",
  private: true,
  empty: false,
  ...over,
});

describe("apiBase", () => {
  test("keeps the origin and drops what the API path adds", () => {
    expect(apiBase("http://192.168.1.76:3030/")).toBe("http://192.168.1.76:3030");
    expect(apiBase("https://git.beric.ca/api/v1")).toBe("https://git.beric.ca");
    expect(apiBase("  https://git.beric.ca/api/v1/  ")).toBe("https://git.beric.ca");
  });

  test("a bare hostname is https", () => {
    expect(apiBase("git.beric.ca")).toBe("https://git.beric.ca");
  });

  test("credentials never survive into a stored address", () => {
    expect(apiBase("https://eric:hunter2@git.beric.ca")).toBe("https://git.beric.ca");
  });

  test("refuses what is not an http address", () => {
    expect(() => apiBase("ssh://git@git.beric.ca")).toThrow();
    expect(() => apiBase("")).toThrow();
  });

  test("pages ask for a fixed size", () => {
    expect(reposUrl("https://git.beric.ca", 2)).toBe(
      "https://git.beric.ca/api/v1/user/repos?limit=50&page=2",
    );
  });
});

describe("parseRepoPage", () => {
  test("takes the fields a card needs and defaults the rest", () => {
    const [r] = parseRepoPage([
      { name: "canopy", html_url: "https://git.beric.ca/eric/canopy" },
    ]);
    expect(r?.full_name).toBe("canopy");
    expect(r?.private).toBe(false);
    expect(r?.description).toBe("");
  });

  test("drops an entry with no name or no page", () => {
    expect(parseRepoPage([{ name: "canopy" }, { html_url: "x" }, 7, null])).toEqual([]);
  });

  test("throws when the body is not a list", () => {
    expect(() => parseRepoPage({ message: "token required" })).toThrow();
  });
});

describe("repoKey", () => {
  test("the same repo through ssh, https and the browser is one key per host", () => {
    expect(repoKey("ssh://git@192.168.1.76:2222/eric/canopy.git")).toBe(
      "192.168.1.76/eric/canopy",
    );
    expect(repoKey("https://git.beric.ca/eric/canopy.git")).toBe("git.beric.ca/eric/canopy");
    expect(repoKey("https://git.beric.ca/eric/canopy")).toBe("git.beric.ca/eric/canopy");
    expect(repoKey("git@192.168.1.76:eric/canopy.git")).toBe("192.168.1.76/eric/canopy");
  });

  test("case never decides a match", () => {
    expect(repoKey("ssh://git@192.168.1.76:2222/eric/ArchiSketch.git")).toBe(
      "192.168.1.76/eric/archisketch",
    );
  });

  test("nothing usable is no key", () => {
    expect(repoKey("not a url")).toBeNull();
  });
});

describe("forgeRepo", () => {
  test("a card with no working state and the forge's page as its address", () => {
    const r = forgeRepo(SOURCE, api({ description: "a git cockpit" }));
    expect(r.id).toBe("beric:eric/canopy");
    expect(r.name).toBe("canopy");
    expect(r.path).toBe("https://git.beric.ca/eric/canopy");
    expect(r.link).toBe("https://git.beric.ca/eric/canopy");
    expect(r.group).toBe("git.beric.ca");
    expect(r.status).toBeNull();
    expect(r.host).toBeUndefined();
    expect(r.description).toBe("a git cockpit");
    expect(r.forge).toEqual({
      kind: "forgejo",
      slug: "eric/canopy",
      clone: "ssh://git@192.168.1.76:2222/eric/canopy.git",
      branch: "main",
      updated: Date.parse("2026-08-30T18:26:48-07:00"),
      private: true,
      empty: false,
    });
  });

  test("a forge that says nothing about the branch or the time still makes a card", () => {
    const r = forgeRepo(SOURCE, api({ default_branch: "", updated_at: "whenever" }));
    expect(r.forge?.branch).toBe("main");
    expect(r.forge?.updated).toBe(0);
    expect(r.description).toBeUndefined();
  });
});

const local = (over: Partial<Repo> = {}): Repo => ({
  id: "dev-tools/canopy",
  name: "canopy",
  path: "/Users/eric/dev/dev-tools/canopy",
  group: "dev-tools",
  source: "launch",
  status: null,
  ...over,
});

describe("linkForgeClones", () => {
  test("a forge repo learns the clone that has it as a remote", () => {
    const out = linkForgeClones([
      local({ remotes: ["ssh://git@192.168.1.76:2222/eric/canopy.git"] }),
      forgeRepo(SOURCE, api()),
    ]);
    expect(out[1]?.forge?.clonedAs).toBe("dev-tools/canopy");
  });

  test("the https url the forge advertises matches the same clone", () => {
    const out = linkForgeClones([
      local({ remotes: ["https://git.beric.ca/eric/canopy.git"] }),
      forgeRepo(SOURCE, api()),
    ]);
    expect(out[1]?.forge?.clonedAs).toBe("dev-tools/canopy");
  });

  test("a clone with no web link of its own gets the forge's page", () => {
    const out = linkForgeClones([
      local({ remotes: ["ssh://git@192.168.1.76:2222/eric/canopy.git"] }),
      forgeRepo(SOURCE, api()),
    ]);
    expect(out[0]?.link).toBe("https://git.beric.ca/eric/canopy");
  });

  test("a clone that already links somewhere keeps that link", () => {
    const out = linkForgeClones([
      local({
        remotes: [
          "git@github.com:BaruchEric/canopy.git",
          "ssh://git@192.168.1.76:2222/eric/canopy.git",
        ],
        link: "https://github.com/BaruchEric/canopy",
      }),
      forgeRepo(SOURCE, api()),
    ]);
    expect(out[0]?.link).toBe("https://github.com/BaruchEric/canopy");
  });

  test("a repo only on the forge stays unclaimed", () => {
    const out = linkForgeClones([
      local({ remotes: ["git@github.com:BaruchEric/canopy.git"] }),
      forgeRepo(SOURCE, api({ name: "wiki-personal", full_name: "eric/wiki-personal" })),
    ]);
    expect(out[1]?.forge?.clonedAs).toBeUndefined();
    expect(out[0]?.link).toBeUndefined();
  });

  test("a name in common is not a match — only a remote is", () => {
    const out = linkForgeClones([
      local({ remotes: ["git@github.com:someone/canopy.git"] }),
      forgeRepo(SOURCE, api()),
    ]);
    expect(out[1]?.forge?.clonedAs).toBeUndefined();
  });

  test("a clone that goes away drops the tie on the next pass", () => {
    const claimed = linkForgeClones([
      local({ remotes: ["ssh://git@192.168.1.76:2222/eric/canopy.git"] }),
      forgeRepo(SOURCE, api()),
    ]);
    const forge = claimed[1];
    if (!forge) throw new Error("no forge repo");
    const out = linkForgeClones([forge]);
    expect(out[0]?.forge?.clonedAs).toBeUndefined();
  });
});
