import { describe, expect, test } from "bun:test";
import { parseNewArgs, sproutLink } from "./newargs";

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
  test("a link to the project in the page", () => {
    expect(sproutLink("http://mini:7850", "sp_0123456789ab")).toBe("http://mini:7850/?view=incubator&sprout=sp_0123456789ab");
  });
});
