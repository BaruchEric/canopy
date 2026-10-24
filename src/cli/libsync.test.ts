import { describe, expect, test } from "bun:test";
import type { LibrarySyncStatus } from "../core/libsync";
import { isLibrarySync, syncLines } from "./libsync";

describe("canopy library sync", () => {
  test("is this command only as the first word after the flags", () => {
    expect(isLibrarySync(["sync"])).toBe(true);
    expect(isLibrarySync(["--root", "/x", "sync", "--status"])).toBe(true);
    expect(isLibrarySync(["--backend", "http://mini:7850", "sync"])).toBe(true);
    expect(isLibrarySync(["git", "sync"])).toBe(false);
    expect(isLibrarySync(["--root", "sync", "index"])).toBe(false);
  });

  test("the status in lines", () => {
    const st: LibrarySyncStatus = {
      mode: "on",
      self: "mini",
      joined: { how: "adopt", from: "mac", at: 1 },
      error: null,
      peers: [
        { name: "mac", url: "https://mac.example", at: 100_000 - 30_000, ok: 70_000, away: null, held: null, taken: 3, deleted: 1, kept: ["cat:apps"], dry: false },
        { name: "gpd", url: null, at: null, ok: null, away: null, held: null, taken: 0, deleted: 0, kept: [], dry: false },
      ],
    };
    expect(syncLines(st, 100_000)).toEqual([
      "library sync on mini: on, joined by adopt from mac",
      "  mac: pulled 30s ago, took 3, deleted 1",
      "    kept while their folders have projects: apps",
      "  gpd: not pulled yet, took 0, deleted 0",
    ]);
    const held = { ...st, joined: null, peers: [{ ...st.peers[0]!, kept: [], held: "mac would delete 30 of 30 entries; --accept mac", dry: true }] };
    expect(syncLines(held, 100_000)).toEqual([
      "library sync on mini: on, not joined (--seed on the first backend, --adopt BACKEND on the rest)",
      "  mac: pulled 30s ago, mac would delete 30 of 30 entries; --accept mac",
    ]);
  });
});
