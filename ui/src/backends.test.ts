import { describe, expect, test } from "bun:test";
import {
  backendState,
  hasOtherBackend,
  isLaunchSource,
  onPublicSide,
  pickUrl,
  qualify,
  signinUrl,
  sliceIn,
  split,
  wsUrl,
  type BackendStatus,
  type Reg,
} from "./backends";
import type { BackendEntry } from "../../src/core/types";

const reg: Reg = { home: "mini", names: ["mini", "mac"] };
const entries: BackendEntry[] = [
  { name: "mini", public: "https://canopy.beric.ca", tailnet: "https://macmini-2018.tail2d2c60.ts.net:7849" },
  { name: "mac", public: "https://canopy-mac.beric.ca", tailnet: "https://erics-macbook-pro.tail2d2c60.ts.net:7850" },
];
const mini = entries[0]!;
const mac = entries[1]!;

describe("qualify and split", () => {
  test("home ids stay bare", () => {
    expect(qualify(reg, "mini", "dev-tools/canopy")).toBe("dev-tools/canopy");
    expect(split(reg, "dev-tools/canopy")).toEqual(["mini", "dev-tools/canopy"]);
  });
  test("another backend's ids carry its name", () => {
    const id = qualify(reg, "mac", "dev-tools/canopy");
    expect(id).toBe("mac|dev-tools/canopy");
    expect(split(reg, id)).toEqual(["mac", "dev-tools/canopy"]);
  });
  test("round trips ids holding slashes, colons, dots and bars", () => {
    for (const plain of [".", "work:a/b", "x|y", "a.b/c", "0123456789abcdef0123456789abcdef"]) {
      for (const b of reg.names) expect(split(reg, qualify(reg, b, plain))).toEqual([b, plain]);
    }
  });
  test("a home id with a bar stays home unless the prefix names another backend", () => {
    expect(split(reg, "notes|2026")).toEqual(["mini", "notes|2026"]);
    expect(split(reg, "mini|x")).toEqual(["mini", "mini|x"]);
  });
  test("a backend no longer in the registry reads as home", () => {
    expect(split({ home: "mini", names: ["mini"] }, "mac|a")).toEqual(["mini", "mac|a"]);
  });
});

describe("which url", () => {
  test("public side by host or parent domain", () => {
    expect(onPublicSide("canopy.beric.ca", entries)).toBe(true);
    expect(onPublicSide("canopy-wsl.beric.ca", entries)).toBe(true);
    expect(onPublicSide("erics-macbook-pro.tail2d2c60.ts.net", entries)).toBe(false);
    expect(onPublicSide("127.0.0.1", entries)).toBe(false);
    expect(onPublicSide("localhost", entries)).toBe(false);
    expect(onPublicSide("macmini-2018", entries)).toBe(false);
  });
  test("a page on the public side uses public urls", () => {
    expect(pickUrl("https://canopy.beric.ca", mac, entries)).toEqual({ first: "https://canopy-mac.beric.ca", fallback: null });
  });
  test("a tailnet page uses the tailnet url and falls back to public", () => {
    expect(pickUrl("https://macmini-2018.tail2d2c60.ts.net:7849", mac, entries)).toEqual({
      first: "https://erics-macbook-pro.tail2d2c60.ts.net:7850",
      fallback: "https://canopy-mac.beric.ca",
    });
  });
  test("the Mac's loopback page takes the tailnet url", () => {
    expect(pickUrl("http://127.0.0.1:7850", mini, entries)).toEqual({
      first: "https://macmini-2018.tail2d2c60.ts.net:7849",
      fallback: "https://canopy.beric.ca",
    });
  });
  test("an https page never picks an http url", () => {
    const nb: BackendEntry = { name: "nb", tailnet: "http://notebook:7850", public: "https://canopy-nb.beric.ca" };
    expect(pickUrl("https://macmini-2018.tail2d2c60.ts.net:7849", nb, [...entries, nb])).toEqual({
      first: "https://canopy-nb.beric.ca",
      fallback: null,
    });
  });
  test("an http page may take an http tailnet url", () => {
    const nb: BackendEntry = { name: "nb", tailnet: "http://notebook:7850" };
    expect(pickUrl("http://macmini-2018:7850", nb, [...entries, nb])).toEqual({ first: "http://notebook:7850", fallback: null });
  });
  test("a url that is the page's own origin is skipped", () => {
    expect(pickUrl("https://erics-macbook-pro.tail2d2c60.ts.net:7850", mac, entries)).toEqual({
      first: "https://canopy-mac.beric.ca",
      fallback: null,
    });
  });
  test("no usable url", () => {
    expect(pickUrl("https://canopy.beric.ca", { name: "x", tailnet: "http://x:1" }, entries)).toEqual({ first: null, fallback: null });
  });
  test("a trailing slash or path is dropped", () => {
    expect(pickUrl("https://canopy.beric.ca", { name: "x", public: "https://canopy-x.beric.ca/" }, entries).first).toBe(
      "https://canopy-x.beric.ca",
    );
  });
});

describe("backendState", () => {
  const connecting: BackendStatus = { state: "connecting" };
  test("an answer or an open stream is online", () => {
    expect(backendState(connecting, { kind: "answered" })).toEqual({ state: "online" });
    expect(backendState({ state: "offline", reason: "x" }, { kind: "stream-open" })).toEqual({ state: "online" });
  });
  test("no answer is offline with the reason", () => {
    expect(backendState({ state: "online" }, { kind: "unreachable", reason: "no answer" })).toEqual({
      state: "offline",
      reason: "no answer",
    });
    expect(backendState({ state: "online" }, { kind: "stream-lost" }).state).toBe("offline");
  });
  test("the gate's 401 is signin, and a dropped stream after it stays signin", () => {
    const s = backendState(connecting, { kind: "signin", login: "https://beric.ca/login" });
    expect(s).toEqual({ state: "signin", login: "https://beric.ca/login" });
    expect(backendState(s, { kind: "stream-lost" })).toBe(s);
    expect(backendState(s, { kind: "unreachable", reason: "x" })).toBe(s);
    expect(backendState(s, { kind: "answered" })).toEqual({ state: "online" });
  });
  test("a retry is connecting", () => {
    expect(backendState({ state: "offline", reason: "x" }, { kind: "retry" })).toEqual({ state: "connecting" });
  });
  test("nothing changed hands back the same object", () => {
    const on: BackendStatus = { state: "online" };
    expect(backendState(on, { kind: "answered" })).toBe(on);
    const off: BackendStatus = { state: "offline", reason: "x" };
    expect(backendState(off, { kind: "unreachable", reason: "x" })).toBe(off);
    expect(backendState(off, { kind: "stream-lost" })).toBe(off);
    expect(backendState(connecting, { kind: "retry" })).toBe(connecting);
  });
});

describe("sliceIn", () => {
  const ids = (xs: { id: string }[]) => xs.map((x) => x.id);
  test("replaces one backend's part and keeps registry order", () => {
    const list = [{ id: "a" }, { id: "mac|a" }, { id: "b" }];
    const out = sliceIn(reg, list, "mac", [{ id: "mac|c" }, { id: "mac|d" }], (x) => x.id);
    expect(ids(out)).toEqual(["a", "b", "mac|c", "mac|d"]);
    expect(ids(sliceIn(reg, out, "mini", [{ id: "z" }], (x) => x.id))).toEqual(["z", "mac|c", "mac|d"]);
  });
  test("with one backend the next list is the list", () => {
    const next = [{ id: "a" }];
    expect(sliceIn({ home: "mini", names: ["mini"] }, [{ id: "b" }], "mini", next, (x) => x.id)).toBe(next);
  });
});

describe("wsUrl", () => {
  test("home is the page's own host", () => {
    expect(wsUrl("", { protocol: "https:", host: "canopy.beric.ca" }, "/api/term?x=1")).toBe("wss://canopy.beric.ca/api/term?x=1");
    expect(wsUrl("", { protocol: "http:", host: "127.0.0.1:7850" }, "/api/term")).toBe("ws://127.0.0.1:7850/api/term");
  });
  test("another backend is its own base", () => {
    expect(wsUrl("https://canopy-mac.beric.ca", { protocol: "http:", host: "x" }, "/api/term")).toBe("wss://canopy-mac.beric.ca/api/term");
    expect(wsUrl("http://notebook:7850", { protocol: "http:", host: "x" }, "/api/term")).toBe("ws://notebook:7850/api/term");
  });
});

describe("signinUrl", () => {
  test("adds next to a login url with no query", () => {
    expect(signinUrl("https://beric.ca/login", "https://canopy-mac.beric.ca")).toBe(
      "https://beric.ca/login?next=https%3A%2F%2Fcanopy-mac.beric.ca",
    );
  });
  test("adds next alongside an existing query, with &", () => {
    expect(signinUrl("https://beric.ca/login?a=1", "https://canopy-mac.beric.ca")).toBe(
      "https://beric.ca/login?a=1&next=https%3A%2F%2Fcanopy-mac.beric.ca",
    );
  });
});

describe("hasOtherBackend", () => {
  test("a registry that lists only self has nothing to show", () => {
    expect(hasOtherBackend([{ name: "mini" }], "mini")).toBe(false);
    expect(hasOtherBackend([], "mini")).toBe(false);
  });
  test("any entry besides home is another backend", () => {
    expect(hasOtherBackend([{ name: "mini" }, { name: "mac" }], "mini")).toBe(true);
    expect(hasOtherBackend([{ name: "mac" }], "mini")).toBe(true);
  });
});

test("isLaunchSource", () => {
  expect(isLaunchSource("launch")).toBe(true);
  expect(isLaunchSource("mac|launch")).toBe(true);
  expect(isLaunchSource("work")).toBe(false);
  expect(isLaunchSource("mac|work")).toBe(false);
});
