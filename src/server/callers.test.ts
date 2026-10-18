import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallerBook, CallerGate } from "./callers";

const DAY = 24 * 60 * 60 * 1000;
const MIN = 60 * 1000;

let dir: string;
let file: string;
let t: number;
const now = () => t;
let books: CallerBook[] = [];
const open = () => {
  const book = new CallerBook({ file, now });
  books.push(book);
  return book;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "canopy-callers-"));
  file = join(dir, "callers.json");
  t = 1_000_000;
  books = [];
});
// let queued writes land before the scratch dir goes
afterEach(async () => {
  await Promise.all(books.map((b) => b.flush()));
  rmSync(dir, { recursive: true, force: true });
});

describe("mint and check", () => {
  test("a minted token checks to its caller, anything else is null", () => {
    const book = open();
    const { token, caller } = book.mint("shell", { label: "sh", term: "t1" });
    expect(token.startsWith("cnp_shell_")).toBe(true);
    expect(book.check(token)?.kind).toBe("shell");
    expect(book.check(token)?.id).toBe(caller.id);
    expect(book.check("cnp_shell_x")).toBeNull();
    expect(book.check(null)).toBeNull();
  });

  test("revoke ends a token", async () => {
    const book = open();
    const { token, caller } = book.mint("cli", { label: "cli a" });
    expect(await book.revoke(caller.id)).toBe(true);
    expect(await book.revoke(caller.id)).toBe(false);
    expect(book.check(token)).toBeNull();
  });
});

describe("a bad disk", () => {
  test("a failed write rejects the revoke's promise, bites in memory, and leaves no unhandled rejection", async () => {
    const unhandled: unknown[] = [];
    const seen = (e: unknown) => unhandled.push(e);
    process.on("unhandledRejection", seen);
    try {
      // the parent of the file is a regular file, so every write fails
      const blocker = join(dir, "blocker");
      writeFileSync(blocker, "x");
      const quiet = spyOn(console, "error").mockImplementation(() => {});
      const book = new CallerBook({ file: join(blocker, "callers.json"), now });
      books.push(book);
      const { token, caller } = book.mint("cli", { label: "cli a" });
      await book.flush();
      let failed = false;
      await book.revoke(caller.id).catch(() => {
        failed = true;
      });
      expect(failed).toBe(true);
      expect(quiet.mock.calls.some((c) => String(c[0]).startsWith("callers:"))).toBe(true);
      quiet.mockRestore();
      expect(book.check(token)).toBeNull();
      await new Promise((r) => setTimeout(r, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", seen);
    }
  });

  test("a corrupt file is moved aside with its content, and the book starts empty", () => {
    writeFileSync(file, "{corrupt");
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    const book = open();
    expect(String(quiet.mock.calls[0]?.[0])).toContain("every page, CLI and helper must sign in again");
    quiet.mockRestore();
    expect(book.list()).toEqual([]);
    const aside = readdirSync(dir).filter((f) => f.startsWith("callers.json.corrupt-"));
    expect(aside).toHaveLength(1);
    expect(readFileSync(join(dir, aside[0] as string), "utf8")).toBe("{corrupt");
    expect(existsSync(file)).toBe(false);
  });

  test("a file that is JSON but not an array is moved aside too, a missing file is just empty", () => {
    writeFileSync(file, '{"a":1}');
    const quiet = spyOn(console, "error").mockImplementation(() => {});
    open();
    quiet.mockRestore();
    expect(readdirSync(dir).some((f) => f.startsWith("callers.json.corrupt-"))).toBe(true);
    rmSync(join(dir, "callers.json.corrupt-x"), { force: true });
    const fresh = mkdtempSync(join(tmpdir(), "canopy-callers-"));
    const spy = spyOn(console, "error");
    new CallerBook({ file: join(fresh, "callers.json"), now });
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    rmSync(fresh, { recursive: true, force: true });
  });
});

describe("persistence", () => {
  test("the file holds no token, a second book reads it, mode 0600", async () => {
    const book = open();
    const { token } = book.mint("page", { label: "laptop" });
    await book.flush();
    expect(readFileSync(file, "utf8")).not.toContain(token);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(open().check(token)?.kind).toBe("page");
  });

  test("a bump of used is written after a minute, so expiry holds across restarts", async () => {
    const book = open();
    const { token } = book.mint("page", { label: "laptop" });
    await book.flush();
    t += 2 * MIN;
    book.check(token);
    await book.flush();
    expect(open().list()[0]?.used).toBe(t);
  });
});

describe("expiry", () => {
  test("a page session unused for 30 days is over, a shell token is not", () => {
    const book = open();
    const page = book.mint("page", { label: "p" });
    const shell = book.mint("shell", { label: "s", term: "t1" });
    t += 30 * DAY;
    expect(book.check(page.token)).not.toBeNull();
    t += 30 * DAY + 1;
    expect(book.check(page.token)).toBeNull();
    expect(book.check(shell.token)?.kind).toBe("shell");
  });

  test("use pushes the expiry out", () => {
    const book = open();
    const { token } = book.mint("cli", { label: "cli a" });
    t += 20 * DAY;
    expect(book.check(token)).not.toBeNull();
    t += 20 * DAY;
    expect(book.check(token)).not.toBeNull();
  });
});

describe("drops", () => {
  test("dropTerm and dropRun kill the tokens tied to them", () => {
    const book = open();
    const a = book.mint("shell", { label: "a", term: "t1" });
    const b = book.mint("shell", { label: "b", term: "t2" });
    const c = book.mint("ranger", { label: "c", run: "r1" });
    book.dropTerm("t1");
    book.dropRun("r1");
    expect(book.check(a.token)).toBeNull();
    expect(book.check(c.token)).toBeNull();
    expect(book.check(b.token)).not.toBeNull();
  });

  test("a coordinator's token carries its run, and dropRun revokes it", async () => {
    const book = open();
    const { token, caller } = book.mint("coordinator", { label: "coordinator web", run: "co1" });
    expect(caller).toMatchObject({ kind: "coordinator", run: "co1" });
    expect(book.check(token)?.run).toBe("co1");
    await book.dropRun("co1");
    expect(book.check(token)).toBeNull();
  });

  test("dropKind drops every caller of that kind, kept on disk too, and leaves the rest", async () => {
    const book = open();
    const a = book.mint("coordinator", { label: "coordinator web", run: "co1" });
    const b = book.mint("coordinator", { label: "coordinator api", run: "co2" });
    const c = book.mint("ranger", { label: "ranger", term: "t1" });
    await book.flush();
    const dropped: string[] = [];
    const again = open();
    again.onDrop = (ids) => dropped.push(...ids);
    await again.dropKind("coordinator");
    expect(dropped).toEqual([a.caller.id, b.caller.id]);
    expect(again.check(a.token)).toBeNull();
    expect(again.check(b.token)).toBeNull();
    expect(again.check(c.token)).not.toBeNull();
    expect(open().check(a.token)).toBeNull();
  });

  test("prune drops shell callers whose term is gone", () => {
    const book = open();
    const a = book.mint("shell", { label: "a", term: "t1" });
    const b = book.mint("shell", { label: "b", term: "t2" });
    book.prune(new Set(["t2"]));
    expect(book.check(a.token)).toBeNull();
    expect(book.check(b.token)).not.toBeNull();
  });
});

describe("tickets", () => {
  test("redeem works once", () => {
    const book = open();
    const { caller } = book.mint("page", { label: "p" });
    const ticket = book.ticket(caller.id, "shell");
    expect(book.redeem(ticket, "shell")?.id).toBe(caller.id);
    expect(book.redeem(ticket, "shell")).toBeNull();
  });

  test("redeem fails after 60 s, for the other right, and after a revoke", () => {
    const book = open();
    const { caller } = book.mint("page", { label: "p" });
    const late = book.ticket(caller.id, "shell");
    t += 60 * 1000 + 1;
    expect(book.redeem(late, "shell")).toBeNull();
    const wrong = book.ticket(caller.id, "shell");
    expect(book.redeem(wrong, "helper")).toBeNull();
    const gone = book.ticket(caller.id, "helper");
    book.revoke(caller.id);
    expect(book.redeem(gone, "helper")).toBeNull();
  });

  test("a ticket for no caller throws", () => {
    expect(() => open().ticket("nope", "shell")).toThrow();
  });
});

describe("pairing", () => {
  test("a fourth pair while three wait is an error", () => {
    const book = open();
    for (let i = 0; i < 3; i++) expect("id" in book.pair(`p${i}`, "1.2.3.4")).toBe(true);
    const fourth = book.pair("p3", "1.2.3.4");
    expect("error" in fourth).toBe(true);
  });

  test("a pair is gone after 10 min", () => {
    const book = open();
    const p = book.pair("p", "1.2.3.4");
    if ("error" in p) throw new Error(p.error);
    expect(book.pending()).toHaveLength(1);
    t += 10 * MIN + 1;
    expect(book.pending()).toHaveLength(0);
    expect(book.approve(p.id)).toBe(false);
    expect(book.claim(p.id, p.secret)).toBeNull();
  });

  test("codes are 6 characters from the alphabet", () => {
    const p = open().pair("p", "a");
    if ("error" in p) throw new Error(p.error);
    expect(p.code).toMatch(/^[ABCDEFGHJKLMNPQRSTUVWXYZ23456789]{6}$/);
  });

  test("claim: wrong secret null, waiting, then a token once", () => {
    const book = open();
    const p = book.pair("laptop", "1.2.3.4");
    if ("error" in p) throw new Error(p.error);
    expect(book.claim(p.id, "wrong")).toBeNull();
    expect(book.claim(p.id, p.secret)).toBe("waiting");
    expect(book.approve(p.id)).toBe(true);
    const token = book.claim(p.id, p.secret);
    expect(typeof token).toBe("string");
    expect(book.check(token as string)?.kind).toBe("page");
    expect(book.claim(p.id, p.secret)).toBeNull();
  });

  test("wrongSecret is a wrong guess at a live pair only", () => {
    const book = open();
    const p = book.pair("laptop", "1.2.3.4");
    if ("error" in p) throw new Error(p.error);
    expect(book.wrongSecret(p.id, "wrong")).toBe(true);
    expect(book.wrongSecret(p.id, p.secret)).toBe(false);
    expect(book.wrongSecret("nope", "wrong")).toBe(false);
    expect(book.deny(p.id)).toBe(true);
    // denied but not yet told: still a live pair to guess at
    expect(book.wrongSecret(p.id, "wrong")).toBe(true);
    expect(book.claim(p.id, p.secret)).toBeNull();
    // told, and gone
    expect(book.wrongSecret(p.id, "wrong")).toBe(false);
  });

  test("the label prefix picks the kind", () => {
    const book = open();
    const kinds: string[] = [];
    for (const label of ["cli mac", "helper mini", "laptop"]) {
      const p = book.pair(label, "a");
      if ("error" in p) throw new Error(p.error);
      book.approve(p.id);
      const token = book.claim(p.id, p.secret) as string;
      kinds.push(book.check(token)?.kind ?? "none");
    }
    expect(kinds).toEqual(["cli", "helper", "page"]);
  });

  test("the asked kind is minted, whatever the label says", () => {
    const book = open();
    const kinds: string[] = [];
    for (const [label, kind] of [["cli mac", "page"], ["laptop", "cli"], ["page x", "helper"]] as const) {
      const p = book.pair(label, "a", kind);
      if ("error" in p) throw new Error(p.error);
      expect(book.pending().find((x) => x.id === p.id)?.kind).toBe(kind);
      book.approve(p.id);
      kinds.push(book.check(book.claim(p.id, p.secret) as string)?.kind ?? "none");
    }
    expect(kinds).toEqual(["page", "cli", "helper"]);
  });

  test("a renewal with the waiting pair's own id and secret replaces it", () => {
    const book = open();
    const a = book.pair("laptop", "1.2.3.4", "page");
    if ("error" in a) throw new Error(a.error);
    const b = book.pair("laptop", "1.2.3.4", "page", { id: a.id, secret: a.secret });
    if ("error" in b) throw new Error(b.error);
    expect(book.pending().map((x) => x.id)).toEqual([b.id]);
    expect(book.claim(a.id, a.secret)).toBeNull();
    expect(book.replaced(a.id, a.secret)).toBe(true);
    expect(book.replaced(a.id, "wrong")).toBe(false);
    expect(book.replaced(b.id, b.secret)).toBe(false);
    expect(book.claim(b.id, b.secret)).toBe("waiting");
  });

  test("the same label and address without the secret does not replace", () => {
    const book = open();
    const a = book.pair("laptop", "1.2.3.4", "page");
    const b = book.pair("laptop", "1.2.3.4", "page");
    if ("error" in a || "error" in b) throw new Error("pair");
    expect(book.pending().map((x) => x.id)).toEqual([a.id, b.id]);
    expect(book.claim(a.id, a.secret)).toBe("waiting");
  });

  test("a renewal with a wrong secret makes a new pair and replaces nothing", () => {
    const book = open();
    const a = book.pair("laptop", "1.2.3.4", "page");
    if ("error" in a) throw new Error(a.error);
    const b = book.pair("laptop", "1.2.3.4", "page", { id: a.id, secret: "wrong" });
    expect("id" in b).toBe(true);
    expect(book.pending()).toHaveLength(2);
    expect(book.claim(a.id, a.secret)).toBe("waiting");
  });

  test("a renewal leaves room under the waiting cap", () => {
    const book = open();
    const first = book.pair("p0", "a", "page");
    if ("error" in first) throw new Error(first.error);
    for (let i = 1; i < 3; i++) expect("id" in book.pair(`p${i}`, "a", "page")).toBe(true);
    expect("error" in book.pair("p3", "a", "page")).toBe(true);
    expect("id" in book.pair("p0", "a", "page", first)).toBe(true);
    expect(book.pending()).toHaveLength(3);
  });

  test("the 7th new pair inside a minute is refused, and one is allowed after it", () => {
    const book = open();
    for (let i = 0; i < 6; i++) {
      t += 1000;
      const p = book.pair("loop", "a", "page");
      if ("error" in p) throw new Error(p.error);
      // denying frees the slot, so only the rate cap is in the way
      book.deny(p.id);
    }
    t += 1000;
    const seventh = book.pair("loop", "a", "page");
    expect("error" in seventh).toBe(true);
    expect(book.pending()).toHaveLength(0);
    t += MIN;
    expect("id" in book.pair("loop", "a", "page")).toBe(true);
  });

  test("both refusals say how to free the slots", () => {
    const book = open();
    for (let i = 0; i < 3; i++) book.pair(`p${i}`, "a", "page");
    const full = book.pair("p3", "a", "page");
    expect("error" in full && full.error).toContain("deny");
    const burst = open();
    for (let i = 0; i < 6; i++) {
      const p = burst.pair("x", "a", "page");
      if ("id" in p) burst.deny(p.id);
    }
    const limited = burst.pair("x", "a", "page");
    expect("error" in limited && limited.error).toContain("deny");
  });

  test("deny makes claim null", () => {
    const book = open();
    const p = book.pair("p", "a");
    if ("error" in p) throw new Error(p.error);
    expect(book.deny(p.id)).toBe(true);
    expect(book.claim(p.id, p.secret)).toBeNull();
  });
});

describe("first code", () => {
  test("an empty book has one, and using it approves the pair", () => {
    const book = open();
    const code = book.firstCode();
    expect(code).not.toBeNull();
    const p = book.pair("laptop", "a");
    if ("error" in p) throw new Error(p.error);
    expect(book.useFirst("WRONG1", p.id)).toBe(false);
    expect(book.useFirst(code as string, p.id)).toBe(true);
    const token = book.claim(p.id, p.secret);
    expect(typeof token).toBe("string");
    expect(book.firstCode()).toBeNull();
  });

  test("the code is burned by use", () => {
    const book = open();
    const code = book.firstCode() as string;
    const a = book.pair("a", "x");
    const b = book.pair("b", "x");
    if ("error" in a || "error" in b) throw new Error("pair");
    expect(book.useFirst(code, a.id)).toBe(true);
    expect(book.useFirst(code, b.id)).toBe(false);
  });

  test("a book that holds a page session from disk has none", async () => {
    const book = open();
    book.mint("page", { label: "p" });
    await book.flush();
    expect(open().firstCode()).toBeNull();
  });

  test("an expired session does not count, so the first code is offered", async () => {
    const book = open();
    book.mint("page", { label: "p" });
    book.mint("cli", { label: "cli a" });
    await book.flush();
    t += 30 * DAY + 1;
    const code = open().firstCode();
    expect(code).not.toBeNull();
    expect(book.firstCode()).not.toBeNull();
  });
});

describe("a coordinator at the gate", () => {
  test("its token posts a plan and reads, and is refused on every route that starts, stops or answers", () => {
    const book = open();
    const caller = book.check(book.mint("coordinator", { label: "coordinator web", run: "co1" }).token);
    const gate = new CallerGate({ book, mode: "enforce", log: () => {} });
    const at = (method: string, path: string): number | null => gate.gate(new Request(`http://x${path}`, { method }), new URL(`http://x${path}`), caller)?.status ?? null;
    expect(at("POST", "/api/coordinator/plan")).toBeNull();
    expect(at("GET", "/api/tree")).toBeNull();
    for (const [m, p] of [
      ["POST", "/api/coordinator/tasks"],
      ["POST", "/api/coordinator/start"],
      ["POST", "/api/repos/run"],
      ["POST", "/api/runs/say"],
      ["POST", "/api/runs/stop"],
      ["POST", "/api/runs/answer"],
      ["POST", "/api/asks/answer"],
      ["POST", "/api/landing/land"],
      ["POST", "/api/auth/approve"],
    ] as const) {
      expect([m, p, at(m, p)]).toEqual([m, p, 403]);
    }
  });

  test("a page may post a plan too, and a bare caller may not", () => {
    const book = open();
    const page = book.check(book.mint("page", { label: "a page" }).token);
    const gate = new CallerGate({ book, mode: "enforce", log: () => {} });
    const post = (caller: typeof page): number | null =>
      gate.gate(new Request("http://x/api/coordinator/plan", { method: "POST" }), new URL("http://x/api/coordinator/plan"), caller)?.status ?? null;
    expect(post(page)).toBeNull();
    expect(post(null)).toBe(401);
  });
});
