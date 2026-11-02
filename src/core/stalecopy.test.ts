import { describe, expect, test } from "bun:test";
import {
  isFullHash,
  isStaleOffer,
  judgeCopies,
  linesLeftOut,
  newestStale,
  offerAction,
  offerWords,
  pairCopies,
  parseCommits,
  type CommitFacts,
  type StaleOffer,
} from "./stalecopy";

const h = (c: string): string => c.repeat(40);
const commit = (hash: string, message: string, more: Partial<CommitFacts> = {}): CommitFacts => ({
  hash,
  parents: 1,
  at: 1_790_000_000,
  email: "e@x.invalid",
  message,
  ...more,
});
const clean = (...hashes: string[]) => new Map(hashes.map((x) => [x, [] as string[]]));

describe("parseCommits", () => {
  test("reads the log format back, body and all", () => {
    const out = [
      `${h("a")}\x1f${h("0")}\x1f1790000000\x1fe@x.invalid\x1ffix nav\n\nthe body\n\x1e`,
      `\n${h("b")}\x1f${h("a")} ${h("c")}\x1f1790000060\x1fo@x.invalid\x1fmerge\n\x1e\n`,
    ].join("");
    expect(parseCommits(out)).toEqual([
      { hash: h("a"), parents: 1, at: 1_790_000_000, email: "e@x.invalid", message: "fix nav\n\nthe body" },
      { hash: h("b"), parents: 2, at: 1_790_000_060, email: "o@x.invalid", message: "merge" },
    ]);
  });
  test("a root commit has no parents, and nothing reads as nothing", () => {
    expect(parseCommits(`${h("a")}\x1f\x1f1\x1fe\x1fone\n\x1e`)[0]?.parents).toBe(0);
    expect(parseCommits("")).toEqual([]);
  });
});

describe("pairCopies", () => {
  test("an amend keeps the message, the author time and the email", () => {
    const local = [commit(h("a"), "fix nav\n\nbody"), commit(h("b"), "mine")];
    const upstream = [commit(h("c"), "fix nav\n\nbody"), commit(h("d"), "theirs")];
    const p = pairCopies(local, upstream);
    expect("pairs" in p && p.pairs.map((x) => [x.stale.hash, x.copy.hash])).toEqual([[h("a"), h("c")]]);
  });
  test("a different body, time or author is another commit", () => {
    const a = commit(h("a"), "fix nav\n\nbody");
    for (const other of [commit(h("c"), "fix nav\n\nother body"), commit(h("c"), "fix nav\n\nbody", { at: 1 }), commit(h("c"), "fix nav\n\nbody", { email: "o@x.invalid" })]) {
      expect(pairCopies([a], [other])).toEqual({ pairs: [] });
    }
  });
  test("two candidates either way cannot say which is the amend", () => {
    const a = commit(h("a"), "same");
    expect(pairCopies([a], [commit(h("c"), "same"), commit(h("d"), "same")])).toHaveProperty("ambiguous");
    expect(pairCopies([a, commit(h("b"), "same")], [commit(h("c"), "same")])).toHaveProperty("ambiguous");
  });
});

describe("linesLeftOut", () => {
  test("a file the copy removes a line from, or changes as binary, is left out", () => {
    const numstat = ["3\t0\tkept.txt", "1\t1\tedited.txt", "-\t-\tlogo.png", "0\t4\tnot-ours.txt", ""].join("\0");
    expect(linesLeftOut(["kept.txt", "edited.txt", "logo.png"], numstat)).toEqual(["edited.txt", "logo.png"]);
  });
  test("a path with a tab or a newline in it is read whole", () => {
    expect(linesLeftOut(["a\tb\nc"], "0\t2\ta\tb\nc\0")).toEqual(["a\tb\nc"]);
  });
  test("files the copy leaves alone are not listed at all", () => {
    expect(linesLeftOut(["f.txt"], "")).toEqual([]);
  });
});

describe("judgeCopies", () => {
  const a = commit(h("a"), "fix nav");
  const b = commit(h("b"), "mine");
  const c = commit(h("c"), "fix nav");
  test("no copy upstream is no offer", () => {
    expect(judgeCopies([b], { pairs: [] }, new Map())).toEqual({ kind: "none" });
  });
  test("the oldest local commit with a superset copy is dropped, the rest kept", () => {
    expect(judgeCopies([a, b], { pairs: [{ stale: a, copy: c }] }, clean(h("a")))).toEqual({
      kind: "drop",
      copies: [{ stale: h("a"), copy: h("c"), subject: "fix nav" }],
      kept: 1,
    });
  });
  test("a copy that leaves lines out is refused, naming the files", () => {
    const v = judgeCopies([a], { pairs: [{ stale: a, copy: c }] }, new Map([[h("a"), ["f.txt"]]]));
    expect(v.kind).toBe("refuse");
    expect("why" in v && v.why).toContain("leaves out lines aaaaaaa has in f.txt");
  });
  test("a pair whose files were not read is not taken on trust", () => {
    expect(judgeCopies([a], { pairs: [{ stale: a, copy: c }] }, new Map()).kind).toBe("refuse");
  });
  test("a stale copy above a commit upstream lacks would drop that commit too", () => {
    const v = judgeCopies([b, a], { pairs: [{ stale: a, copy: c }] }, clean(h("a")));
    expect("why" in v && v.why).toContain("sits on 1 commit of your own");
  });
  test("local merges and an ambiguous match are refused", () => {
    const m = commit(h("e"), "merge", { parents: 2 });
    expect(judgeCopies([a, m], { pairs: [{ stale: a, copy: c }] }, clean(h("a"))).kind).toBe("refuse");
    expect(judgeCopies([a], { ambiguous: "two of them" }, new Map())).toEqual({ kind: "refuse", why: "two of them" });
  });
});

describe("the offer", () => {
  const offer: StaleOffer = {
    branch: "main",
    upstream: "origin/main",
    onto: h("f"),
    copies: [{ stale: h("a"), copy: h("c"), subject: "fix nav" }],
    kept: 1,
  };
  test("says which commit, which amend, and what dropping it does", () => {
    expect(offerWords(offer)).toBe(
      "Upstream holds an amended copy of aaaaaaa fix nav (ccccccc: same message and author time, and every line aaaaaaa left in its files). Dropping the stale copy moves main onto origin/main with git rebase --onto and keeps the 1 commit after it.",
    );
    expect(offerAction(offer)).toBe("drop the stale copy and push");
    expect(offerAction({ ...offer, kept: 0 })).toBe("drop the stale copy");
    expect(offerWords({ ...offer, kept: 0 })).toEndWith("with git rebase --onto.");
  });
  test("several copies are named in a row, the newest last", () => {
    const two = { ...offer, copies: [...offer.copies, { stale: h("b"), copy: h("d"), subject: "more" }] };
    expect(offerWords(two)).toContain("amended copies of 2 commits: aaaaaaa fix nav (ccccccc), bbbbbbb more (ddddddd)");
    expect(offerAction(two)).toBe("drop the stale copies and push");
    expect(newestStale(two)).toBe(h("b"));
  });
  test("only a whole offer over the wire is one", () => {
    expect(isStaleOffer(offer)).toBe(true);
    expect(isStaleOffer({ ...offer, copies: [] })).toBe(false);
    expect(isStaleOffer({ ...offer, onto: "f".repeat(7) })).toBe(false);
    expect(isStaleOffer({ ...offer, copies: [{ stale: "--output=x", copy: h("c"), subject: "" }] })).toBe(false);
    expect(isStaleOffer(null)).toBe(false);
    expect(isFullHash("a".repeat(64))).toBe(true);
    expect(isFullHash("A".repeat(40))).toBe(false);
  });
});
