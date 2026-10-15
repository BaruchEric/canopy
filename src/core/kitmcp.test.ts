import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, onHost } from "./exec";
import { fakeClaude } from "./kitfake";
import { claudeRemove, claudeSet, codexBlocks, codexServers, inplaceWrite, MARKER, spliceCodex, STAT_FN, type McpIO } from "./kitmcp";

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
const scratch = (): string => {
  const d = mkdtempSync(join(tmpdir(), "kitmcp-"));
  dirs.push(d);
  return d;
};
const one = (r: { text: string } | { error: string }): string => {
  if ("error" in r) throw new Error(r.error);
  return r.text;
};

const ORIG = `# my codex config
model = "gpt-5"   # trailing comment
approval_policy="never"

[mcp_servers.node_repl]
command = "node"
args = ["repl.js"]

[mcp_servers.node_repl.env]
NODE_OPTIONS = "--max-old-space-size=4096"

[[profiles.list]]
name = 'a'

[projects."/Users/e/dev"]
trust_level = "trusted"
`;

describe("spliceCodex", () => {
  test("every byte outside the managed tables stays; add, change, remove gives the file back", () => {
    const a = one(spliceCodex(ORIG, "wiki-memory", { command: "bash", args: ["/x/wiki.sh"], startup_timeout_sec: 30, env: { A: "x y" } }));
    expect(a.startsWith(ORIG)).toBe(true);
    expect(a.slice(ORIG.length)).toBe(`\n${MARKER}\n[mcp_servers.wiki-memory]\ncommand = "bash"\nargs = ["/x/wiki.sh"]\nstartup_timeout_sec = 30\nenv = { A = "x y" }\n`);
    expect(codexServers(a)?.["wiki-memory"]).toEqual({ command: "bash", args: ["/x/wiki.sh"], startup_timeout_sec: 30, env: { A: "x y" } });
    const b = one(spliceCodex(a, "wiki-memory", { command: "bash", args: ["/y.sh"] }));
    expect(b.startsWith(ORIG)).toBe(true);
    const c = one(spliceCodex(b, "executor", { url: "https://e.example/mcp", bearer_token_env_var: "K" }));
    expect(codexBlocks(c).map((x) => x.name)).toEqual(["wiki-memory", "executor"]);
    expect(one(spliceCodex(one(spliceCodex(c, "wiki-memory", null)), "executor", null))).toBe(ORIG);
  });

  test("adopt marks a hand-made table in place, and restore gives back the same server", () => {
    const hand = 'model = "gpt-5"\n\n[mcp_servers.wiki-memory]\ncommand = "bash"\nargs = ["/x/wiki.sh"]\nstartup_timeout_sec = 30.0\n\n[mcp_servers.node_repl]\ncommand = "node"\n';
    const old = codexServers(hand)?.["wiki-memory"] ?? null;
    const adopted = one(spliceCodex(hand, "wiki-memory", { command: "bash", args: ["/y.sh"] }, "adopt"));
    expect(adopted).toBe('model = "gpt-5"\n\n# canopy-kit: managed\n[mcp_servers.wiki-memory]\ncommand = "bash"\nargs = ["/y.sh"]\n\n[mcp_servers.node_repl]\ncommand = "node"\n');
    const back = one(spliceCodex(adopted, "wiki-memory", old, "restore"));
    expect(codexServers(back)?.["wiki-memory"]).toEqual(old ?? {});
    expect(codexBlocks(back)).toEqual([]);
  });

  test("a comment heading the next table stays when canopy's table is updated, removed or adopted", () => {
    const tail = '\n# my profiles\n[profiles.x]\nmodel = "m"\n';
    const added = one(spliceCodex(ORIG, "wiki-memory", { command: "bash" }));
    const withUser = added + tail;
    const updated = one(spliceCodex(withUser, "wiki-memory", { command: "bash", args: ["/y.sh"] }));
    expect(updated).toBe(`${one(spliceCodex(ORIG, "wiki-memory", { command: "bash", args: ["/y.sh"] }))}${tail}`);
    expect(one(spliceCodex(withUser, "wiki-memory", null))).toBe(`${ORIG}${tail}`);
    const hand = '[mcp_servers.w]\ncommand = "bash"\n\n# my profiles\n[profiles.x]\nmodel = "m"\n';
    expect(one(spliceCodex(hand, "w", { command: "bash", args: ["/y.sh"] }, "adopt"))).toBe(`${MARKER}\n[mcp_servers.w]\ncommand = "bash"\nargs = ["/y.sh"]\n\n# my profiles\n[profiles.x]\nmodel = "m"\n`);
  });

  test("refuses a file that does not parse, a hand-made table of the same name, and a split table", () => {
    expect(spliceCodex("a = [", "x", { command: "c" })).toEqual({ error: "config.toml does not parse; left as it is" });
    expect(spliceCodex(ORIG, "node_repl", { command: "x" })).toEqual({ error: "config.toml has a [mcp_servers.node_repl] canopy did not write; adopt it instead" });
    expect(spliceCodex("[mcp_servers.x]\na = 1\n[other]\nb = 2\n[mcp_servers.x.env]\nC = 'd'\n", "x", { command: "c" }, "adopt")).toEqual({ error: "config.toml splits [mcp_servers.x] across the file; adopt it by hand" });
  });
});

describe("inplaceWrite", () => {
  const io: McpIO = { run: onHost, host: null };
  const stamp = async (f: string) => (await exec(["sh", "-c", `${STAT_FN}\nst "$1"`, "st", f])).stdout.trim();

  test("writes over the same inode, 0600 when it makes the file", async () => {
    const d = scratch();
    const f = join(d, "config.toml");
    writeFileSync(f, ORIG);
    const ino = statSync(f).ino;
    expect(await inplaceWrite(io, f, await stamp(f), `${ORIG}x = 1\n`)).toBeNull();
    expect(statSync(f).ino).toBe(ino);
    expect(readFileSync(f, "utf8")).toBe(`${ORIG}x = 1\n`);
    const fresh = join(d, "new.toml");
    expect(await inplaceWrite(io, fresh, "", "a = 1\n")).toBeNull();
    expect(statSync(fresh).mode & 0o777).toBe(0o600);
  });

  test("a file that moved since the scan is left exactly as it now is (review focus 4)", async () => {
    const d = scratch();
    const f = join(d, "config.toml");
    writeFileSync(f, ORIG);
    const seen = await stamp(f);
    appendFileSync(f, "# codex wrote this\n");
    expect(await inplaceWrite(io, f, seen, "clobbered\n")).toBe("config.toml changed since the scan; rescan and apply again");
    expect(readFileSync(f, "utf8")).toBe(`${ORIG}# codex wrote this\n`);
  });

  test("a same-size rewrite within the same second is caught too, by the checksum", async () => {
    const d = scratch();
    const f = join(d, "config.toml");
    writeFileSync(f, ORIG);
    const was = statSync(f);
    const seen = await stamp(f);
    const other = ORIG.replace("gpt-5", "gpt-6");
    expect(other.length).toBe(ORIG.length);
    writeFileSync(f, other);
    utimesSync(f, was.atime, was.mtime);
    const now = await stamp(f);
    // mtime and size read the same, so only the checksum can tell
    expect(now.split(" ").slice(0, 2)).toEqual(seen.split(" ").slice(0, 2));
    expect(now).not.toBe(seen);
    expect(await inplaceWrite(io, f, seen, "clobbered\n")).toBe("config.toml changed since the scan; rescan and apply again");
    expect(readFileSync(f, "utf8")).toBe(other);
  });
});

describe("the claude CLI writer", () => {
  function setup() {
    const h = scratch();
    const claude = fakeClaude(h);
    const log = join(h, "argv.log");
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { github: { type: "stdio", command: "bash", args: ["-c", "x"] } } }));
    const io = (fail?: "add-once" | "add"): McpIO => ({ run: onHost, host: null, env: { HOME: h, FAKE_CLAUDE_LOG: log, ...(fail ? { FAKE_CLAUDE_FAIL: fail } : {}) } });
    const servers = () => (JSON.parse(readFileSync(join(h, ".claude.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;
    const argv = () => readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as string[]);
    return { h, claude, io, servers, argv };
  }

  test("a set over an existing name removes it first; a remove removes", async () => {
    const { claude, io, servers, argv } = setup();
    const old = servers()["github"] as Record<string, unknown>;
    const want = { type: "stdio", command: "/h/.claude/bin/canopy-mcp-env", args: ["github", "--", "bunx"] };
    expect(await claudeSet(io(), claude, "github", want, old)).toBeNull();
    expect(servers()["github"]).toEqual(want);
    expect(argv()).toEqual([["mcp", "remove", "--scope", "user", "github"], ["mcp", "add-json", "--scope", "user", "github", JSON.stringify(want)]]);
    expect(await claudeRemove(io(), claude, "github", want)).toBeNull();
    expect(servers()["github"]).toBeUndefined();
  });

  test("a failed add puts the old entry back, and its error never quotes a value", async () => {
    const { claude, io, servers } = setup();
    const old = servers()["github"] as Record<string, unknown>;
    const want = { type: "stdio", command: "x", args: [], env: { TOKEN: "literal-value-0x41" } };
    const why = await claudeSet(io("add-once"), claude, "github", want, old);
    expect(why).toContain("Invalid configuration");
    expect(why).not.toContain("literal-value-0x41");
    expect(servers()["github"]).toEqual(old);
  });

  test("a put back that fails too is said, without the old entry's values", async () => {
    const { h, claude, io, servers } = setup();
    const old = { type: "stdio", command: "bash", env: { OLD: "old-literal-0x42" } };
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { github: old } }));
    const want = { type: "stdio", command: "x", env: { TOKEN: "literal-value-0x41" } };
    const why = await claudeSet(io("add"), claude, "github", want, old);
    expect(why).toStartWith("Invalid configuration");
    expect(why).toContain("; the old entry could not be put back: Invalid configuration");
    expect(why).not.toContain("literal-value-0x41");
    expect(why).not.toContain("old-literal-0x42");
    expect(servers()["github"]).toBeUndefined();
  });

  test("a value the CLI echoes as JSON, quotes and backslashes escaped, is taken out too", async () => {
    const { claude, io, servers } = setup();
    const old = servers()["github"] as Record<string, unknown>;
    const want = { type: "stdio", command: "x", env: { TOKEN: 'ab"cd\\efgh-PROBE' } };
    const why = await claudeSet(io("add-once"), claude, "github", want, old);
    expect(why).toContain("Invalid configuration");
    expect(why).not.toContain("efgh-PROBE");
  });
});
