import { describe, expect, test } from "bun:test";
import { isGitHub, parseRemote } from "./access";

describe("parseRemote", () => {
  test("reads the URL shapes git remotes actually take", () => {
    expect(parseRemote("https://github.com/nateherkai/AIS-OS")).toEqual({
      host: "github.com",
      owner: "nateherkai",
      name: "AIS-OS",
    });
    expect(parseRemote("https://github.com/BaruchEric/canopy.git")).toEqual({
      host: "github.com",
      owner: "BaruchEric",
      name: "canopy",
    });
    expect(parseRemote("git@github.com:BuilderIO/skills.git")).toEqual({
      host: "github.com",
      owner: "BuilderIO",
      name: "skills",
    });
    // Self-hosted, non-default port — the forgejo mirror on the NAS.
    expect(parseRemote("ssh://git@192.168.1.10:2222/eric/_devhub.git")).toEqual(
      {
        host: "192.168.1.10",
        owner: "eric",
        name: "_devhub",
      },
    );
  });

  test("returns null rather than guessing", () => {
    for (const bad of ["", "not a url", "https://github.com/onlyowner"]) {
      expect(parseRemote(bad)).toBeNull();
    }
  });
});

describe("isGitHub", () => {
  test("matches github and its subdomains", () => {
    expect(isGitHub("github.com")).toBe(true);
    expect(isGitHub("www.github.com")).toBe(true);
  });

  test("is not fooled by lookalike hosts", () => {
    // A denial hint keyed off the wrong host would be worse than no hint.
    for (const host of [
      "notgithub.com",
      "github.com.evil.test",
      "gitlab.com",
      "192.168.1.10",
    ]) {
      expect(isGitHub(host)).toBe(false);
    }
  });
});
