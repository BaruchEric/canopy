/** VaultNotes against a stand-in gateway with the real one's write rules. */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { VaultError, VaultNotes, vaultConfig } from "./vault";

const notes = new Map<string, { text: string; rev: number }>();
let revs = 0;
let queueNext = false;
let server: ReturnType<typeof Bun.serve>;

const reply = (body: unknown, status = 200) => Response.json(body, { status });

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer t0k") return reply({ error: "no token" }, 401);
      const url = new URL(req.url);
      if (url.pathname === "/file" && req.method === "GET") {
        const n = notes.get(url.searchParams.get("path") ?? "");
        if (!n) return reply({ error: "not found" }, 404);
        return new Response(n.text, { headers: { "x-vault-rev": String(n.rev) } });
      }
      if (url.pathname !== "/write" || req.method !== "POST") return reply({ error: "no route" }, 404);
      const b = (await req.json()) as { op: string; path: string; content: string; base_rev?: string };
      if (queueNext) {
        queueNext = false;
        return reply({ outboxId: 1 }, 202);
      }
      const n = notes.get(b.path);
      const commit = (text: string) => {
        revs += 1;
        notes.set(b.path, { text, rev: revs });
        return reply({ rev: String(revs), seq: revs, hash: "h", path: b.path });
      };
      if (b.op === "create") return n ? reply({ error: "exists", headRev: String(n.rev) }, 409) : commit(b.content);
      if (!n) return reply({ error: `${b.path} does not exist` }, 404);
      if (b.op === "append") return commit(n.text + b.content);
      if (b.op === "replace") {
        if (b.base_rev === undefined) return reply({ error: "replace needs base_rev" }, 400);
        return b.base_rev === String(n.rev) ? commit(b.content) : reply({ error: "stale-base", headRev: String(n.rev) }, 409);
      }
      return reply({ error: "bad op" }, 400);
    },
  });
});

afterAll(() => server.stop(true));

beforeEach(() => {
  notes.clear();
  queueNext = false;
});

const vault = (token = "t0k") => new VaultNotes({ url: `http://127.0.0.1:${server.port}`, token });

/** a note of project `id`'s, as the incubator writes one: its mark in the frontmatter */
const noteOf = (id: string, body: string): string => `---\ntype: project\nsprout: ${id}\n---\n# ${body}\n`;
const MINE = "sp_aaaaaaaaaaaa";
const THEIRS = "sp_bbbbbbbbbbbb";
const mine = { mark: `sprout: ${MINE}`, elsewhere: "a-aaaaaaaaaaaa.md" };

describe("put", () => {
  test("no rev creates; the rev it returns replaces", async () => {
    const r1 = await vault().put("a.md", noteOf(MINE, "one"), undefined, mine);
    expect(notes.get("a.md")?.text).toBe(noteOf(MINE, "one"));
    expect(r1.path).toBe("a.md");
    const r2 = await vault().put("a.md", noteOf(MINE, "two"), r1.rev, mine);
    expect(notes.get("a.md")?.text).toBe(noteOf(MINE, "two"));
    expect(r2.rev).not.toBe(r1.rev);
  });
  test("a stale rev on its own note takes the head's and still writes", async () => {
    await vault().put("a.md", noteOf(MINE, "one"), undefined, mine);
    const r = await vault().put("a.md", noteOf(MINE, "mine"), "999", mine);
    expect(notes.get("a.md")?.text).toBe(noteOf(MINE, "mine"));
    expect(r).toEqual({ rev: String(notes.get("a.md")?.rev), path: "a.md" });
  });
  test("no rev on its own note (a lost record) replaces it", async () => {
    await vault().put("a.md", noteOf(MINE, "old"), undefined, mine);
    await vault().put("a.md", noteOf(MINE, "new"), undefined, mine);
    expect(notes.get("a.md")?.text).toBe(noteOf(MINE, "new"));
  });
  test("a note another project holds is left alone, and the write goes to the owner's own path", async () => {
    await vault().put("a.md", noteOf(THEIRS, "theirs"), undefined, { mark: `sprout: ${THEIRS}`, elsewhere: "a-bbbbbbbbbbbb.md" });
    const r = await vault().put("a.md", noteOf(MINE, "mine"), undefined, mine);
    expect(notes.get("a.md")?.text).toBe(noteOf(THEIRS, "theirs"));
    expect(notes.get("a-aaaaaaaaaaaa.md")?.text).toBe(noteOf(MINE, "mine"));
    expect(r).toEqual({ rev: String(notes.get("a-aaaaaaaaaaaa.md")?.rev), path: "a-aaaaaaaaaaaa.md" });
  });
  test("a stale rev at a path another project took over is not written over either", async () => {
    const first = await vault().put("a.md", noteOf(MINE, "one"), undefined, mine);
    notes.set("a.md", { text: noteOf(THEIRS, "theirs"), rev: 77 });
    const r = await vault().put("a.md", noteOf(MINE, "two"), first.rev, mine);
    expect(notes.get("a.md")?.text).toBe(noteOf(THEIRS, "theirs"));
    expect(r.path).toBe("a-aaaaaaaaaaaa.md");
    expect(notes.get("a-aaaaaaaaaaaa.md")?.text).toBe(noteOf(MINE, "two"));
  });
  test("a note with no mark at all is not taken for the owner's", async () => {
    notes.set("a.md", { text: "# a note someone wrote by hand\nsprout: sp_aaaaaaaaaaaa\n", rev: 5 });
    const r = await vault().put("a.md", noteOf(MINE, "mine"), undefined, mine);
    expect(notes.get("a.md")?.text).toBe("# a note someone wrote by hand\nsprout: sp_aaaaaaaaaaaa\n");
    expect(r.path).toBe("a-aaaaaaaaaaaa.md");
  });
  test("with its own path held by another project too, it throws and writes nothing", async () => {
    notes.set("a.md", { text: noteOf(THEIRS, "theirs"), rev: 5 });
    notes.set("a-aaaaaaaaaaaa.md", { text: noteOf(THEIRS, "theirs too"), rev: 6 });
    const err = await vault().put("a.md", noteOf(MINE, "mine"), undefined, mine).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).status).toBe(409);
    expect(notes.get("a.md")?.text).toBe(noteOf(THEIRS, "theirs"));
    expect(notes.get("a-aaaaaaaaaaaa.md")?.text).toBe(noteOf(THEIRS, "theirs too"));
  });
  test("a rev for a note that went away creates it again", async () => {
    await vault().put("gone.md", noteOf(MINE, "back"), "5", mine);
    expect(notes.get("gone.md")?.text).toBe(noteOf(MINE, "back"));
  });
  test("queued is no rev, at the path it asked for", async () => {
    queueNext = true;
    expect(await vault().put("q.md", "x", undefined, mine)).toEqual({ rev: undefined, path: "q.md" });
  });
  test("a refused token throws with its status", async () => {
    const err = await vault("wrong").put("a.md", "x", undefined, mine).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(VaultError);
    expect((err as VaultError).status).toBe(401);
    expect(String(err)).not.toContain("wrong");
    expect(JSON.stringify(err)).not.toContain("wrong");
  });
  test("the token never shows when the notes object is printed or serialized", () => {
    const v = new VaultNotes({ url: "http://gw", token: "s3cret-t0ken" });
    expect(JSON.stringify(v)).not.toContain("s3cret-t0ken");
    expect(Bun.inspect(v)).not.toContain("s3cret-t0ken");
    expect(JSON.stringify({ notes: v })).toBe('{"notes":{"url":"http://gw"}}');
  });
});

describe("append", () => {
  test("a missing daily note is made with its head, then appended to", async () => {
    await vault().append("d.md", "\n- one\n", "# Day\n");
    expect(notes.get("d.md")?.text).toBe("# Day\n\n- one\n");
    await vault().append("d.md", "\n- two\n", "# Day\n");
    expect(notes.get("d.md")?.text).toBe("# Day\n\n- one\n\n- two\n");
  });
});

describe("vaultConfig", () => {
  test("off without a token and under bun test; the default gateway otherwise", () => {
    expect(vaultConfig({})).toBeNull();
    expect(vaultConfig({ CANOPY_VAULT_TOKEN: "x", NODE_ENV: "test" })).toBeNull();
    expect(vaultConfig({ CANOPY_VAULT_TOKEN: " x " })).toEqual({ url: "https://mem.beric.ca", token: "x" });
    expect(vaultConfig({ CANOPY_VAULT_TOKEN: "x", CANOPY_VAULT_URL: "http://gw:8787/" })).toEqual({ url: "http://gw:8787", token: "x" });
  });
});
