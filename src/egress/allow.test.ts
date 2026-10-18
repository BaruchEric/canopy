import { describe, expect, test } from "bun:test";
import { ALLOWED_HOSTS, allowedHost, isPublicV4, parseConnect } from "./allow";

describe("the egress allowlist", () => {
  test("Anthropic's names are in, each by its exact name", () => {
    for (const h of ["api.anthropic.com", "console.anthropic.com", "statsig.anthropic.com", "claude.ai", "platform.claude.com"]) {
      expect(ALLOWED_HOSTS).toContain(h);
      expect(allowedHost(h)).toBe(true);
    }
  });

  test("a name only near one is out: another subdomain, a longer name, a lookalike", () => {
    for (const h of [
      "anthropic.com",
      "evil.api.anthropic.com",
      "x.claude.ai",
      "evilanthropic.com",
      "api.anthropic.com.evil.com",
      "api-anthropic.com",
      "claude.ai.evil",
      "example.com",
      "",
    ]) {
      expect(allowedHost(h)).toBe(false);
    }
  });
});

describe("parseConnect", () => {
  const ok = (line: string) => parseConnect(`${line}\r\nHost: x\r\n\r\n`);

  test("CONNECT to an allowed name on 443 is a target, the name normalized", () => {
    expect(ok("CONNECT api.anthropic.com:443 HTTP/1.1")).toEqual({ host: "api.anthropic.com", port: 443 });
    expect(ok("CONNECT API.Anthropic.COM.:443 HTTP/1.0")).toEqual({ host: "api.anthropic.com", port: 443 });
  });

  test("any other method is a 405", () => {
    for (const m of ["GET http://api.anthropic.com/ HTTP/1.1", "POST / HTTP/1.1", "connect api.anthropic.com:443 HTTP/1.1"]) {
      const r = ok(m);
      expect("status" in r ? r.status : 0).toBe(405);
    }
  });

  test("any port but 443 is a 403", () => {
    for (const p of ["80", "8443", "0443", "", "443a"]) {
      const r = ok(`CONNECT api.anthropic.com:${p} HTTP/1.1`);
      expect("status" in r ? r.status : 0).toBe(403);
    }
  });

  test("an address instead of a name is a 403, v4 and v6", () => {
    for (const t of ["160.79.104.10:443", "[2607:6bc0::10]:443", "[::1]:443", "127.0.0.1:443"]) {
      const r = ok(`CONNECT ${t} HTTP/1.1`);
      expect(r).toMatchObject({ status: 403 });
      expect("reason" in r ? r.reason : "").toContain("address");
    }
  });

  test("a name off the list is a 403 naming it", () => {
    const r = ok("CONNECT example.com:443 HTTP/1.1");
    expect(r).toMatchObject({ status: 403, host: "example.com" });
  });

  test("a malformed line or name is a 400", () => {
    for (const line of [
      "CONNECT",
      "CONNECT api.anthropic.com:443",
      "CONNECT api.anthropic.com:443 HTTP/2",
      "CONNECT api..anthropic.com:443 HTTP/1.1",
      "CONNECT api.anthropic.com:443 HTTP/1.1 extra",
      "CONNECT ap i.anthropic.com:443 HTTP/1.1",
      "CONNECT :443 HTTP/1.1",
      "CONNECT api.anthropic.com..:443 HTTP/1.1",
      "CONNECT user@api.anthropic.com:443 HTTP/1.1",
    ]) {
      const r = ok(line);
      expect("status" in r ? r.status : 0).toBe(400);
    }
  });
});

describe("isPublicV4", () => {
  test("public addresses pass", () => {
    for (const a of ["160.79.104.10", "1.1.1.1", "8.8.8.8", "34.36.57.103"]) expect(isPublicV4(a)).toBe(true);
  });

  test("private, loopback, tailnet, link-local, reserved and multicast do not", () => {
    for (const a of [
      "0.0.0.0",
      "10.0.0.1",
      "10.250.14.1",
      "100.64.0.1",
      "100.88.84.71",
      "127.0.0.1",
      "169.254.169.254",
      "172.16.0.1",
      "172.31.255.255",
      "192.0.0.1",
      "192.0.2.1",
      "192.168.1.1",
      "192.168.48.1",
      "198.18.0.1",
      "198.51.100.1",
      "203.0.113.1",
      "224.0.0.1",
      "240.0.0.1",
      "255.255.255.255",
    ]) {
      expect(isPublicV4(a)).toBe(false);
    }
  });

  test("anything that is not a dotted quad does not", () => {
    for (const a of ["::1", "2607:6bc0::10", "::ffff:10.0.0.1", "1.2.3", "1.2.3.256", "01.2.3.4", "1.2.3.4 ", "", "x.y.z.w"]) {
      expect(isPublicV4(a)).toBe(false);
    }
  });

  test("the edges of the blocked ranges", () => {
    expect(isPublicV4("172.15.255.255")).toBe(true);
    expect(isPublicV4("172.32.0.0")).toBe(true);
    expect(isPublicV4("100.63.255.255")).toBe(true);
    expect(isPublicV4("100.128.0.0")).toBe(true);
    expect(isPublicV4("11.0.0.0")).toBe(true);
    expect(isPublicV4("9.255.255.255")).toBe(true);
  });
});
