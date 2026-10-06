import { describe, expect, test } from "bun:test";
import { PREFLIGHT_HEADERS, corsHeaders, parseOrigins } from "./cors";

describe("parseOrigins", () => {
  test("keeps exact http and https origins, trimmed, in order", () => {
    expect(parseOrigins(" https://canopy.beric.ca , http://macmini-2018:7850 ")).toEqual([
      "https://canopy.beric.ca",
      "http://macmini-2018:7850",
    ]);
  });
  test("drops a path, a wildcard, another scheme, and empties", () => {
    expect(parseOrigins("https://a.example/x,*,ftp://b.example,,https://c.example")).toEqual(["https://c.example"]);
  });
  test("nothing set is no origins", () => {
    expect(parseOrigins(undefined)).toEqual([]);
    expect(parseOrigins("")).toEqual([]);
  });
});

describe("corsHeaders", () => {
  const origins = ["https://canopy.beric.ca"];
  test("a listed origin gets itself back, with credentials", () => {
    expect(corsHeaders("https://canopy.beric.ca", origins)).toEqual({
      "Access-Control-Allow-Origin": "https://canopy.beric.ca",
      "Access-Control-Allow-Credentials": "true",
      Vary: "Origin",
    });
  });
  test("an unlisted or missing origin gets nothing", () => {
    expect(corsHeaders("https://evil.example", origins)).toBeNull();
    expect(corsHeaders(null, origins)).toBeNull();
  });
  test("the preflight answer never names a wildcard", () => {
    expect(Object.values(PREFLIGHT_HEADERS).some((v) => v.includes("*"))).toBe(false);
  });
  test("the preflight allows every method the API answers, PATCH included", () => {
    expect(PREFLIGHT_HEADERS["Access-Control-Allow-Methods"]?.split(", ")).toEqual(["GET", "POST", "DELETE", "PATCH"]);
  });
});
