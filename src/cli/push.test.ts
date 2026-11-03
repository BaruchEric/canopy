import { describe, expect, test } from "bun:test";
import { pushLines, testLine } from "./push";

const entry = { client: "0123456789abcdef", device: "Eric's iPhone", backend: "mini", createdAt: 0, usedAt: 1_000_000 - 90_000, failures: 0, stale: false };

describe("canopy push ls", () => {
  test("says the key's standing, then one line per browser", () => {
    expect(pushLines({ vapid: true, subject: "mailto:a@b", entries: [] }, 1_000_000)).toEqual(["push key: ready (mailto:a@b)", "no browser has turned push on"]);
    const lines = pushLines({ vapid: true, subject: "mailto:a@b", entries: [entry, { ...entry, client: "fedcba9876543210", device: "", backend: "mac", failures: 3, stale: true }] }, 1_000_000);
    expect(lines[1]).toMatch(/^Eric's iPhone\s+mini\s+used 2m ago\s+ok$/);
    expect(lines[2]).toMatch(/^fedcba9876543210\s+mac\s+used 2m ago\s+stale \(3 failures\)$/);
    expect(pushLines({ vapid: false, subject: "mailto:a@b", why: "read-only", entries: [] }, 0)[0]).toBe("push key: none (read-only)");
  });
});

describe("canopy push test", () => {
  test("counts what went where", () => {
    expect(testLine({ sent: 0, failed: 0, gone: 0, entries: [] })).toBe("no browser has turned push on");
    expect(testLine({ sent: 2, failed: 0, gone: 0, entries: [] })).toBe("sent to 2 of 2");
    expect(testLine({ sent: 1, failed: 1, gone: 1, entries: [] })).toBe("sent to 1 of 3, 1 failed, 1 gone (dropped)");
  });
});
