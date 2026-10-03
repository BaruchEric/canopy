import { expect, test } from "bun:test";
import { fenceTargets, probe } from "./fencecheck";

test("the fence probes canopy, the broker, the gateway and the LAN, and expects the internet open", () => {
  const t = fenceTargets({ CANOPY_FENCE_TAILNET_IP: "100.88.1.2", CANOPY_FENCE_LAN_IP: "192.168.1.10" });
  expect(t).toEqual([
    { name: "canopy on the tailnet", url: "http://100.88.1.2:7850/api/about", expect: "blocked" },
    { name: "tailchan broker", url: "http://100.88.1.2:7855/", expect: "blocked" },
    { name: "the bridge gateway", url: "http://10.250.13.1:7850/", expect: "blocked" },
    { name: "the LAN", url: "http://192.168.1.10/", expect: "blocked" },
    { name: "the internet", url: "https://api.anthropic.com/", expect: "open" },
  ]);
  expect(fenceTargets({}).filter((x) => x.expect === "blocked").map((x) => x.name)).toEqual(["the bridge gateway"]);
});

// what Bun's fetch throws, measured: a refusal, a reset, a lookup that
// failed, a certificate it would not take, and AbortSignal.timeout firing
const fail = (code: string, message = code) => Object.assign(new TypeError(message), { code });
const timeout = () => new DOMException("The operation timed out.", "TimeoutError");

test("any answer is open, even a 403 or a redirect", async () => {
  const t = { name: "x", url: "http://h/", expect: "blocked" as const };
  expect(await probe(t, async () => new Response("", { status: 403 }))).toBe("open");
  expect(await probe(t, async () => new Response("", { status: 302, headers: { location: "/x" } }))).toBe("open");
});

test("a refusal or a reset is open too: the packet reached a host", async () => {
  const t = { name: "x", url: "http://h/", expect: "blocked" as const };
  for (const code of ["ConnectionRefused", "ECONNREFUSED", "ECONNRESET", "ConnectionClosed"]) {
    expect(await probe(t, async () => { throw fail(code); })).toBe("open");
  }
});

test("only the timeout is blocked, since the fence drops and never answers", async () => {
  const t = { name: "x", url: "http://h/", expect: "blocked" as const };
  expect(await probe(t, async () => { throw timeout(); })).toBe("blocked");
});

test("a lookup, a certificate or anything unknown is an error, which matches no expectation", async () => {
  const t = { name: "x", url: "https://h/", expect: "open" as const };
  expect(await probe(t, async () => { throw fail("ENOTFOUND", "getaddrinfo ENOTFOUND h"); })).toBe("error");
  expect(await probe(t, async () => { throw fail("UNKNOWN_CERTIFICATE_VERIFICATION_ERROR"); })).toBe("error");
  expect(await probe(t, async () => { throw new TypeError("connection refused"); })).toBe("error");
  expect(await probe(t, async () => { throw new DOMException("aborted", "AbortError"); })).toBe("error");
});

test("the real probe gives up at 4 s and calls that blocked", async () => {
  let signal: AbortSignal | undefined;
  const got = await probe({ name: "x", url: "http://h/", expect: "blocked" }, (_url, init) => {
    signal = init?.signal ?? undefined;
    return new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal?.reason)));
  });
  expect(got).toBe("blocked");
  expect(signal?.aborted).toBe(true);
}, 6000);
