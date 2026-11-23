import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { FR_FILE, frDuplicates, frEntries, frHighest, frId, frLine, frMessage, frNext, frOfRef, frRef, parseFrMessage, type FrReservation } from "./fr";

const LIST = `# Feature requests: shop

## Open

### FR-012 · A cart that remembers
P2 · added 2026-11-01 · source: Eric
Follow-up to FR-009, and see FR-020 in the plan.

## In Progress

## Shipped

### FR-009 · A cart
P1 · added 2026-10-01 · source: Eric · shipped 2026-10-09

### FR-003 · Sign in
P1 · added 2026-09-01 · source: Eric · shipped 2026-09-03

## Declined
`;

describe("a number's names", () => {
  test("the id and the ref pad to three digits and grow past them", () => {
    expect(frId(7)).toBe("FR-007");
    expect(frId(76)).toBe("FR-076");
    expect(frId(1204)).toBe("FR-1204");
    expect(frRef(76)).toBe("refs/canopy/fr/076");
    expect(frOfRef("refs/canopy/fr/076")).toBe(76);
    expect(frOfRef("refs/canopy/fr/1204")).toBe(1204);
  });

  test("a ref that is not a reservation reads as none", () => {
    for (const ref of ["refs/heads/main", "refs/canopy/fr/", "refs/canopy/fr/abc", "refs/canopy/fr/076/x", "refs/canopy/other/076"]) expect(frOfRef(ref)).toBeNull();
  });
});

describe("a list", () => {
  test("gives its entries' numbers in order, headings only", () => {
    expect(frEntries(LIST)).toEqual([12, 9, 3]);
    expect(frEntries("")).toEqual([]);
  });

  test("its highest number counts one that is only mentioned", () => {
    expect(frHighest(LIST)).toBe(20);
    expect(frHighest("no numbers here")).toBe(0);
  });

  test("says which numbers two entries share", () => {
    expect(frDuplicates(LIST)).toEqual([]);
    expect(frDuplicates(`${LIST}\n### FR-009 · A cart, again\n\n### FR-003 · Sign in, again\n\n### FR-003 · And again\n`)).toEqual([3, 9]);
  });

  test("canopy's own list gives every number once", () => {
    expect(frDuplicates(readFileSync(join(import.meta.dir, "..", "..", FR_FILE), "utf8"))).toEqual([]);
  });
});

describe("the next number", () => {
  test("is one past the highest any copy names or any reservation holds", () => {
    expect(frNext([], [])).toBe(1);
    expect(frNext([LIST], [])).toBe(21);
    expect(frNext([LIST, "### FR-031 · In another worktree"], [])).toBe(32);
    expect(frNext([LIST], [40, 22])).toBe(41);
  });
});

describe("a reservation's words", () => {
  const holder = { title: "Feature numbers that cannot clash", by: "claude-f0351f", branch: "fr-reserve", backend: "mac" };

  test("go into a commit message and come back", () => {
    const message = frMessage(76, holder, "n-1");
    expect(message.split("\n")[0]).toBe("FR-076 Feature numbers that cannot clash");
    expect(parseFrMessage(message)).toEqual(holder);
  });

  test("stay on one line each, whatever the title holds", () => {
    const message = frMessage(76, { ...holder, title: "two\nlines\nby: someone else" }, "n-1");
    expect(parseFrMessage(message)).toEqual({ ...holder, title: "two lines by: someone else" });
  });

  test("two reservations of one number never read the same", () => {
    expect(frMessage(76, holder, "a")).not.toBe(frMessage(76, holder, "b"));
  });

  test("a message canopy did not write reads as empty fields", () => {
    expect(parseFrMessage("something else")).toEqual({ title: "something else", by: "", branch: "", backend: "" });
    expect(parseFrMessage("")).toEqual({ title: "", by: "", branch: "", backend: "" });
  });

  test("a line says who holds it, since when, and where it stands", () => {
    const r: FrReservation = { n: 76, id: "FR-076", holder, at: 1, where: "shared", listed: false };
    const ago = () => "3h ago";
    expect(frLine(r, ago)).toBe("FR-076  Feature numbers that cannot clash  · claude-f0351f on fr-reserve (mac)  · 3h ago");
    expect(frLine({ ...r, where: "here", listed: true }, ago)).toEndWith("· 3h ago  · in the list, this machine only");
    expect(frLine({ ...r, where: "clash" }, ago)).toContain("take a new one");
    expect(frLine({ ...r, holder: { title: "", by: "", branch: "", backend: "" } }, ago)).toBe("FR-076  (no title)  · 3h ago");
  });
});
