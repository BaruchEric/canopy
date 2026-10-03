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

test("any answer is open, even a 403 or a redirect; a refusal or a timeout is blocked", async () => {
  const t = { name: "x", url: "http://h/", expect: "blocked" as const };
  expect(await probe(t, async () => new Response("", { status: 403 }))).toBe("open");
  expect(await probe(t, async () => new Response("", { status: 302, headers: { location: "/x" } }))).toBe("open");
  expect(await probe(t, async () => { throw new TypeError("connection refused"); })).toBe("blocked");
});
