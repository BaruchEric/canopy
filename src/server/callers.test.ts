import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallerBook } from "./callers";

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

  test("revoke ends a token", () => {
    const book = open();
    const { token, caller } = book.mint("cli", { label: "cli a" });
    expect(book.revoke(caller.id)).toBe(true);
    expect(book.revoke(caller.id)).toBe(false);
    expect(book.check(token)).toBeNull();
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
});
