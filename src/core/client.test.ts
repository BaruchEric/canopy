import { describe, expect, test } from "bun:test";
import { clientCaps, clientKey, isLoopback, isLoopbackHost } from "./client";

describe("isLoopback and clientKey", () => {
  test("loopback in both families", () => {
    expect(isLoopback("127.0.0.1")).toBe(true);
    expect(isLoopback("127.0.0.2")).toBe(true);
    expect(isLoopback("::1")).toBe(true);
    expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
    expect(isLoopback("100.68.139.95")).toBe(false);
    expect(isLoopback("fd7a::1")).toBe(false);
  });

  test("a loopback name for the host, which a tunnel's public name is not", () => {
    expect(isLoopbackHost("localhost")).toBe(true);
    expect(isLoopbackHost("127.0.0.1")).toBe(true);
    expect(isLoopbackHost("[::1]")).toBe(true);
    expect(isLoopbackHost("canopy.beric.ca")).toBe(false);
    expect(isLoopbackHost("macmini-2018")).toBe(false);
    expect(isLoopbackHost("127.0.0.1.evil.example")).toBe(false);
  });

  test("a mapped IPv4 keys the same as the plain one", () => {
    expect(clientKey("::ffff:100.68.139.95")).toBe("100.68.139.95");
    expect(clientKey("100.68.139.95")).toBe("100.68.139.95");
    expect(clientKey("fd7a::1")).toBe("fd7a::1");
  });
});

describe("clientCaps", () => {
  const mbp = { name: "mbp", platform: "darwin", openers: ["kitty", "code"] as const, since: 1, address: "100.72.29.68" };
  const box = { name: "box", platform: "linux", openers: ["kitty"] as const, since: 2, address: "100.1.1.1" };
  const helpers = [{ ...mbp, openers: [...mbp.openers] }, { ...box, openers: [...box.openers] }];
  const far = { address: "192.168.48.1", local: false, shared: false };

  test("the browser's own choice wins", () => {
    const c = clientCaps(far, helpers, "box");
    expect(c.via).toBe("helper");
    expect(c.helper?.name).toBe("box");
    expect(c.openers).toEqual(["kitty"]);
  });

  test("a choice that is not attached opens nothing, and does not fall to another helper", () => {
    expect(clientCaps({ address: "100.72.29.68", local: false, shared: false }, helpers, "gone")).toEqual({ openers: [], via: null, helper: null });
  });

  test("with no choice, the one helper at the browser's address is adopted", () => {
    const c = clientCaps({ address: "100.72.29.68", local: false, shared: false }, helpers, null);
    expect(c.helper?.name).toBe("mbp");
    expect(clientCaps(far, helpers, null)).toEqual({ openers: [], via: null, helper: null });
  });

  test("a shared address (docker's proxy in front of the backend) adopts nothing, even one helper there", () => {
    const behind = [{ ...helpers[0]!, address: "192.168.48.1" }];
    expect(clientCaps({ address: "192.168.48.1", local: false, shared: true }, behind, null).via).toBeNull();
    expect(clientCaps({ address: "192.168.48.1", local: false, shared: true }, behind, "mbp").via).toBe("helper");
  });

  test("two helpers at one address adopt neither", () => {
    const twins = [helpers[0]!, { ...helpers[0]!, name: "mbp2" }];
    expect(clientCaps({ address: "100.72.29.68", local: false, shared: false }, twins, null).via).toBeNull();
  });

  test("a loopback helper is never adopted, but can be chosen", () => {
    const here = [{ ...helpers[0]!, address: "127.0.0.1" }];
    expect(clientCaps({ address: "127.0.0.1", local: false, shared: false }, here, null).via).toBeNull();
    expect(clientCaps({ address: "127.0.0.1", local: false, shared: false }, here, "mbp").via).toBe("helper");
  });

  test("a browser on the backend's own Mac opens through it, unless it chose a helper", () => {
    const local = { address: "127.0.0.1", local: true, shared: false };
    expect(clientCaps(local, [], null).via).toBe("backend");
    expect(clientCaps(local, [], null).openers.length).toBeGreaterThan(0);
    expect(clientCaps(local, helpers, "box").via).toBe("helper");
  });
});
