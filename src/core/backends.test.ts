import { describe, expect, test } from "bun:test";
import { normalizeBackends, selfName } from "./backends";

describe("normalizeBackends", () => {
  test("keeps well-formed entries in order", () => {
    const v = [
      { name: "mini", public: "https://canopy.beric.ca", tailnet: "https://macmini-2018.tail2d2c60.ts.net:7849" },
      { name: "mac", public: "https://canopy-mac.beric.ca" },
    ];
    expect(normalizeBackends(v)).toEqual(v);
  });
  test("a public url must be an https origin, a tailnet one http or https", () => {
    expect(normalizeBackends([{ name: "a", public: "http://x.example" }])).toEqual([]);
    expect(normalizeBackends([{ name: "a", public: "https://x.example/path" }])).toEqual([]);
    expect(normalizeBackends([{ name: "a", tailnet: "http://macmini-2018:7850" }])).toEqual([
      { name: "a", tailnet: "http://macmini-2018:7850" },
    ]);
    expect(normalizeBackends([{ name: "a", tailnet: "ftp://x" }])).toEqual([]);
  });
  test("drops an entry with no url, a bad name, or a name already taken", () => {
    expect(
      normalizeBackends([
        { name: "a" },
        { name: "Bad Name", public: "https://x.example" },
        { name: "a|b", public: "https://x.example" },
        { name: "b", public: "https://x.example" },
        { name: "b", public: "https://y.example" },
      ]),
    ).toEqual([{ name: "b", public: "https://x.example" }]);
  });
  test("anything but an array is no backends", () => {
    expect(normalizeBackends(null)).toEqual([]);
    expect(normalizeBackends({ name: "a" })).toEqual([]);
  });
});

describe("selfName", () => {
  test("the peer name when set", () => {
    expect(selfName("mini", "whatever.local")).toBe("mini");
  });
  test("else the hostname's first label as a slug", () => {
    expect(selfName(null, "Erics-MacBook-Pro.local")).toBe("erics-macbook-pro");
    expect(selfName(null, "macmini-2018")).toBe("macmini-2018");
  });
  test("a label that does not start with a letter gets one", () => {
    expect(selfName(null, "2018box")).toBe("b-2018box");
    expect(selfName(null, "")).toBe("canopy");
  });
});
