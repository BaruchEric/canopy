import { describe, expect, test } from "bun:test";
import { NEW_USAGE, parseNewArgs, sproutLink } from "./newargs";

describe("parseNewArgs", () => {
  test("the idea, repeated files and links, a repo", () => {
    expect(parseNewArgs(["a", "coin", "counter", "--file", "a.png", "--url", "https://x.test", "--file", "b.m4a", "--repo", "https://github.com/a/b"], {})).toEqual({
      text: "a coin counter",
      files: ["a.png", "b.m4a"],
      urls: ["https://x.test"],
      repo: "https://github.com/a/b",
      backend: "http://127.0.0.1:7850",
    });
  });
  test("the backend: the flag, else the shell's CANOPY_API, else loopback", () => {
    expect(parseNewArgs(["x", "--backend", "http://mini:7850/"], { CANOPY_API: "http://127.0.0.1:9" })).toMatchObject({ backend: "http://mini:7850" });
    expect(parseNewArgs(["x"], { CANOPY_API: "http://127.0.0.1:9" })).toMatchObject({ backend: "http://127.0.0.1:9" });
  });
  test("nothing given, a flag with no value, or a backend that is not a web origin is an error", () => {
    expect(parseNewArgs([], {})).toEqual({ error: "give an idea, --file, --url or --repo" });
    expect(parseNewArgs(["x", "--file"], {})).toEqual({ error: "--file needs a value" });
    expect(parseNewArgs(["x", "--backend", "mini"], {})).toEqual({ error: "--backend must be an http(s) origin, got mini" });
  });
  test("an unknown flag is an error that lists the flags canopy new takes, and -- ends the flags", () => {
    expect(parseNewArgs(["a", "coin", "counter", "--repoo", "https://github.com/a/b"], {})).toEqual({ error: `unknown flag --repoo\n${NEW_USAGE}` });
    expect(parseNewArgs(["--fil", "a.png"], {})).toEqual({ error: `unknown flag --fil\n${NEW_USAGE}` });
    expect(NEW_USAGE).toContain("--file");
    expect(NEW_USAGE).toContain("--url");
    expect(NEW_USAGE).toContain("--repo");
    expect(NEW_USAGE).toContain("--backend");
    expect(parseNewArgs(["--file", "a.png", "--", "--verbose", "logs", "for", "the", "app"], {})).toMatchObject({ text: "--verbose logs for the app", files: ["a.png"] });
  });
  test("a lone url is the repo when it reads as one, else a link, with a note naming the other flag", () => {
    expect(parseNewArgs(["https://github.com/a/b"], {})).toEqual({
      text: "",
      files: [],
      urls: [],
      repo: "https://github.com/a/b",
      backend: "http://127.0.0.1:7850",
      note: "took https://github.com/a/b as --repo; pass it with --url to give it as a link",
    });
    // a page inside a GitHub repo: the server clones the repo and keeps the page as a link
    expect(parseNewArgs(["https://github.com/a/b/blob/main/README.md"], {})).toMatchObject({ urls: [], repo: "https://github.com/a/b/blob/main/README.md" });
    expect(parseNewArgs(["git@github.com:a/b.git"], {})).toMatchObject({ repo: "git@github.com:a/b.git" });
    expect(parseNewArgs(["https://git.example.com/a/b.git"], {})).toMatchObject({ repo: "https://git.example.com/a/b.git" });
    expect(parseNewArgs(["https://example.com/post", "--file", "a.png"], {})).toEqual({
      text: "",
      files: ["a.png"],
      urls: ["https://example.com/post"],
      backend: "http://127.0.0.1:7850",
      note: "took https://example.com/post as --url; pass it with --repo to start from it",
    });
    // with a repo already named, a lone url is a link
    expect(parseNewArgs(["https://github.com/c/d", "--repo", "https://github.com/a/b"], {})).toMatchObject({ urls: ["https://github.com/c/d"], repo: "https://github.com/a/b" });
    // the token goes to the server, which clones with it; the note never shows it
    const withToken = parseNewArgs(["https://x:tok3n@github.com/a/b"], {});
    expect(withToken).toMatchObject({ repo: "https://x:tok3n@github.com/a/b" });
    expect("note" in withToken ? withToken.note : "").not.toContain("tok3n");
    // a url among other words stays the idea, and one plain word is an idea
    expect(parseNewArgs(["redo", "https://example.com/post"], {})).toMatchObject({ text: "redo https://example.com/post", urls: [] });
    expect(parseNewArgs(["calculator"], {})).toMatchObject({ text: "calculator", urls: [] });
  });
  test("a link to the project in the page", () => {
    expect(sproutLink("http://mini:7850", "sp_0123456789ab")).toBe("http://mini:7850/?view=incubator&sprout=sp_0123456789ab");
  });
});
