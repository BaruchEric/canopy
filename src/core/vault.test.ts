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

describe("put", () => {
  test("no rev creates; the rev it returns replaces", async () => {
    const r1 = await vault().put("a.md", "one", undefined);
    expect(notes.get("a.md")?.text).toBe("one");
    const r2 = await vault().put("a.md", "two", r1);
    expect(notes.get("a.md")?.text).toBe("two");
    expect(r2).not.toBe(r1);
  });
  test("a stale rev takes the head's and still writes", async () => {
    await vault().put("a.md", "one", undefined);
    const rev = await vault().put("a.md", "mine", "999");
    expect(notes.get("a.md")?.text).toBe("mine");
    expect(rev).toBe(String(notes.get("a.md")?.rev));
  });
  test("no rev on a note that exists (a lost record) replaces it", async () => {
    await vault().put("a.md", "old", undefined);
    await vault().put("a.md", "new", undefined);
    expect(notes.get("a.md")?.text).toBe("new");
  });
  test("a rev for a note that went away creates it again", async () => {
    await vault().put("gone.md", "back", "5");
    expect(notes.get("gone.md")?.text).toBe("back");
  });
  test("queued is no rev", async () => {
    queueNext = true;
    expect(await vault().put("q.md", "x", undefined)).toBeUndefined();
  });
  test("a refused token throws with its status", async () => {
    const err = await vault("wrong").put("a.md", "x", undefined).catch((e: unknown) => e);
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
