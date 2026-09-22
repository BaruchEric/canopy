import { describe, expect, test } from "bun:test";
import { deviceName, devicesOf, newClientId, parseStream, platformOf } from "./presence";

const MAC = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Safari/537.36";
const FOLD = "Mozilla/5.0 (Linux; Android 17; SM-F971U1) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/151.0.0.0 Mobile Safari/537.36";
const IPHONE = "Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/26.0 Mobile/15E148 Safari/604.1";

describe("parseStream", () => {
  test("a registered stream", () => {
    const q = new URLSearchParams("client=0123456789abcdef&name=Eric%27s%20Mac&platform=mac");
    expect(parseStream(q, "100.72.29.68", 5)).toEqual({ id: "0123456789abcdef", name: "Eric's Mac", platform: "mac", address: "100.72.29.68", since: 5 });
  });

  test("a name is clipped and an unknown platform is other; no name is 'a browser'", () => {
    const q = new URLSearchParams(`client=0123456789abcdef&name=${"x".repeat(60)}&platform=amiga`);
    const s = parseStream(q, "a", 1)!;
    expect(s.name.length).toBe(40);
    expect(s.platform).toBe("other");
    expect(parseStream(new URLSearchParams("client=0123456789abcdef"), "a", 1)?.name).toBe("a browser");
  });

  test("no id, or a malformed one, is no device", () => {
    expect(parseStream(new URLSearchParams(""), "a")).toBeNull();
    expect(parseStream(new URLSearchParams("client=short"), "a")).toBeNull();
    expect(parseStream(new URLSearchParams("client=0123456789ABCDEF"), "a")).toBeNull();
  });
});

describe("devicesOf", () => {
  const s = (id: string, name: string, since: number) => ({ id, name, platform: "mac" as const, address: "a", since });

  test("one device per id, streams counted, oldest first", () => {
    const out = devicesOf([s("b".repeat(16), "phone", 5), s("a".repeat(16), "mac", 1), s("a".repeat(16), "mac", 3)]);
    expect(out.map((d) => [d.name, d.streams, d.since])).toEqual([["mac", 2, 1], ["phone", 1, 5]]);
  });

  test("the newest stream's name is the device's", () => {
    const out = devicesOf([s("a".repeat(16), "old name", 1), s("a".repeat(16), "new name", 2)]);
    expect(out[0]!.name).toBe("new name");
    expect(out[0]!.since).toBe(1);
  });

  test("nothing in, nothing out", () => {
    expect(devicesOf([])).toEqual([]);
  });
});

describe("deviceName and platformOf", () => {
  test("a Mac in Chrome, the Fold in Chrome, an iPhone in Safari", () => {
    expect(deviceName(MAC)).toBe("Mac, Chrome");
    expect(platformOf(MAC)).toBe("mac");
    expect(deviceName(FOLD)).toBe("Android, Chrome");
    expect(platformOf(FOLD)).toBe("android");
    expect(deviceName(IPHONE)).toBe("iPhone, Safari");
    expect(platformOf(IPHONE)).toBe("ios");
  });

  test("something else", () => {
    expect(deviceName("curl/8.0")).toBe("Browser");
    expect(platformOf("curl/8.0")).toBe("other");
  });
});

describe("newClientId", () => {
  test("16 hex digits", () => {
    expect(newClientId()).toMatch(/^[0-9a-f]{16}$/);
    expect(newClientId(() => 0.999)).toBe("f".repeat(16));
  });
});
