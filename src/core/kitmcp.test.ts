import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, onHost } from "./exec";
import { applyKit } from "./kitapply";
import { fakeClaude } from "./kitfake";
import { applyMcp, claudeRemove, claudeSet, codexBlocks, codexServers, inplaceWrite, MARKER, spliceCodex, STAT_FN, type McpIO } from "./kitmcp";
import { MCP_SCAN_SCRIPT, OWNED_ERROR, parseMcpScan } from "./kitscan";
import type { KitAction, KitMcpAction, KitMcpEntry, KitMcpSeen, KitSeen } from "./types";

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

  test("a final copy that fails names the staged copy, which holds the whole new text (final review 8)", async () => {
    const d = scratch();
    const f = join(d, "config.toml");
    writeFileSync(f, ORIG);
    const seen = await stamp(f);
    // chmod moves only ctime, so the stamp still matches and the copy over the file is what fails
    chmodSync(f, 0o444);
    const why = await inplaceWrite(io, f, seen, `${ORIG}x = 1\n`);
    const staged = /the new text is in (\S+); copy it over config\.toml/.exec(why ?? "")?.[1] ?? "";
    expect(why).toBe(`config.toml was not written in full; the new text is in ${staged}; copy it over config.toml to restore it`);
    expect(staged.startsWith(`${f}.canopy-`)).toBe(true);
    expect(readFileSync(staged, "utf8")).toBe(`${ORIG}x = 1\n`);
    expect(statSync(staged).mode & 0o777).toBe(0o600);
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

describe("applyMcp", () => {
  const HAND = { type: "stdio", command: "bash", args: ["-c", "GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) exec bunx -y @modelcontextprotocol/server-github"] };
  const KIT_GH = { type: "stdio", command: "/h/.claude/bin/canopy-mcp-env", args: ["github", "--", "bunx", "-y", "@modelcontextprotocol/server-github"] };
  const FORMATS = { claude: "claude-json", codex: "codex-toml" } as const;

  async function machine(hand: KitMcpEntry = HAND): Promise<{ h: string; io: McpIO; log: string; rescan: () => Promise<KitMcpSeen> }> {
    const h = scratch();
    const claude = fakeClaude(h);
    const log = join(h, "argv.log");
    mkdirSync(join(h, ".claude"));
    mkdirSync(join(h, ".codex"));
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { github: hand } }));
    writeFileSync(join(h, ".codex", "config.toml"), ORIG);
    const io: McpIO = { run: onHost, host: null, env: { HOME: h, KIT_CLAUDE: claude, FAKE_CLAUDE_LOG: log } };
    const rescan = async () => {
      const r = await exec(["sh", "-c", MCP_SCAN_SCRIPT, "s", "m", "claude", "~/.claude.json", "m", "codex", "~/.codex/config.toml"], { env: io.env });
      return parseMcpScan(r.stdout, FORMATS);
    };
    return { h, io, log, rescan };
  }
  const servers = (h: string) => (JSON.parse(readFileSync(join(h, ".claude.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;
  const ownedPath = (h: string) => join(h, ".claude", ".canopy-kit-mcp.json");
  const owned = (h: string) => JSON.parse(readFileSync(ownedPath(h), "utf8")) as unknown;

  test("set writes both agents and records ownership, 0600", async () => {
    const { h, io, rescan } = await machine();
    const ex = { type: "stdio", command: "npx", args: ["-y", "excalidraw-render"] };
    const r = await applyMcp(await rescan(), h, [
      { kind: "mcp-set", agent: "claude", name: "excalidraw" },
      { kind: "mcp-set", agent: "codex", name: "wiki-memory" },
    ], { "claude/excalidraw": ex, "codex/wiki-memory": { command: "bash", args: ["/w.sh"] } }, FORMATS, io);
    expect(r.failed).toEqual([]);
    expect(servers(h)["excalidraw"]).toEqual(ex);
    expect(readFileSync(join(h, ".codex", "config.toml"), "utf8").startsWith(ORIG)).toBe(true);
    expect(owned(h)).toEqual({ placed: { claude: ["excalidraw"], codex: ["wiki-memory"] }, adoptedFrom: {} });
    expect(statSync(ownedPath(h)).mode & 0o777).toBe(0o600);
  });

  test("adopt keeps the hand-made entry, and put back restores it exactly", async () => {
    const { h, io, rescan } = await machine();
    const adopt = await applyMcp(await rescan(), h, [{ kind: "mcp-adopt", agent: "claude", name: "github" }], { "claude/github": KIT_GH }, FORMATS, io);
    expect(adopt.failed).toEqual([]);
    expect(servers(h)["github"]).toEqual(KIT_GH);
    expect(owned(h)).toEqual({ placed: { claude: ["github"] }, adoptedFrom: { claude: { github: HAND } } });
    // the kept entry stays on that machine: the result names the action only
    expect(JSON.stringify(adopt)).not.toContain("adoptedFrom");
    expect(JSON.stringify(adopt)).not.toContain("gh auth token");
    const back = await applyMcp(await rescan(), h, [{ kind: "mcp-restore", agent: "claude", name: "github" }], {}, FORMATS, io);
    expect(back.failed).toEqual([]);
    expect(servers(h)["github"]).toEqual(HAND);
    expect(owned(h)).toEqual({ placed: { claude: [] }, adoptedFrom: { claude: {} } });
  });

  test("an ownership file that does not parse fails every action and writes nothing (final review 3)", async () => {
    const { h, io, log, rescan } = await machine();
    writeFileSync(ownedPath(h), '{"placed": {"claude": ["git');
    const seen = await rescan();
    const before = readFileSync(join(h, ".claude.json"), "utf8");
    const r = await applyMcp(seen, h, [
      { kind: "mcp-adopt", agent: "claude", name: "github" },
      { kind: "mcp-set", agent: "codex", name: "wiki-memory" },
    ], { "claude/github": KIT_GH, "codex/wiki-memory": { command: "bash" } }, FORMATS, io);
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.why)).toEqual([OWNED_ERROR, OWNED_ERROR]);
    expect(readFileSync(join(h, ".claude.json"), "utf8")).toBe(before);
    expect(readFileSync(join(h, ".codex", "config.toml"), "utf8")).toBe(ORIG);
    expect(readFileSync(ownedPath(h), "utf8")).toBe('{"placed": {"claude": ["git');
    expect(existsSync(log)).toBe(false);
  });

  test("a config.toml that moved fails its actions and records nothing for them (review focus 4)", async () => {
    const { h, io, rescan } = await machine();
    const seen = await rescan();
    appendFileSync(join(h, ".codex", "config.toml"), "# codex wrote this\n");
    const r = await applyMcp(seen, h, [{ kind: "mcp-set", agent: "codex", name: "wiki-memory" }], { "codex/wiki-memory": { command: "bash" } }, FORMATS, io);
    expect(r.failed.map((f) => f.why)).toEqual(["config.toml changed since the scan; rescan and apply again"]);
    expect(readFileSync(join(h, ".codex", "config.toml"), "utf8")).toBe(`${ORIG}# codex wrote this\n`);
    expect(existsSync(ownedPath(h))).toBe(false);
  });

  test("a file the scan could not read is never written, whichever agent's (review focus 4)", async () => {
    const { h, io, log, rescan } = await machine();
    const seen = await rescan();
    // what STAT_FN prints when cksum cannot read the file
    for (const f of seen.files) f.stamp = f.stamp.replace(/\S+$/, "?");
    const before = readFileSync(join(h, ".claude.json"), "utf8");
    const r = await applyMcp(seen, h, [
      { kind: "mcp-set", agent: "codex", name: "wiki-memory" },
      { kind: "mcp-set", agent: "claude", name: "excalidraw" },
    ], { "codex/wiki-memory": { command: "bash" }, "claude/excalidraw": { command: "npx" } }, FORMATS, io);
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.why)).toEqual(["config.toml is not readable here; left as it is", "~/.claude.json is not readable here; left as it is"]);
    expect(readFileSync(join(h, ".codex", "config.toml"), "utf8")).toBe(ORIG);
    expect(readFileSync(join(h, ".claude.json"), "utf8")).toBe(before);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(ownedPath(h))).toBe(false);
  });

  test("set, remove and adopt keep to what canopy owns: a hand-made entry stays", async () => {
    const { h, io, log, rescan } = await machine();
    const r = await applyMcp(await rescan(), h, [
      { kind: "mcp-set", agent: "claude", name: "github" },
      { kind: "mcp-remove", agent: "claude", name: "github" },
      { kind: "mcp-restore", agent: "claude", name: "github" },
    ], { "claude/github": KIT_GH }, FORMATS, io);
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.why)).toEqual([
      "a hand-made entry canopy did not write; adopt it instead",
      "a hand-made entry canopy did not write; left as it is",
      "canopy keeps no hand-made entry for it",
    ]);
    expect(servers(h)["github"]).toEqual(HAND);
    expect(existsSync(log)).toBe(false);
    const adopted = await applyMcp(await rescan(), h, [{ kind: "mcp-adopt", agent: "claude", name: "github" }], { "claude/github": KIT_GH }, FORMATS, io);
    expect(adopted.failed).toEqual([]);
    // a second adopt would keep canopy's own entry as the hand-made one
    const again = await applyMcp(await rescan(), h, [{ kind: "mcp-adopt", agent: "claude", name: "github" }], { "claude/github": KIT_GH }, FORMATS, io);
    expect(again.failed.map((f) => f.why)).toEqual(["canopy manages it already"]);
    expect(owned(h)).toEqual({ placed: { claude: ["github"] }, adoptedFrom: { claude: { github: HAND } } });
  });

  test("a put back that fails says so without the kept entry's values, and keeps it for another try", async () => {
    const lit = { type: "stdio", command: "bash", env: { TOKEN: "literal-value-0x43" } };
    const { h, io, rescan } = await machine(lit);
    expect((await applyMcp(await rescan(), h, [{ kind: "mcp-adopt", agent: "claude", name: "github" }], { "claude/github": KIT_GH }, FORMATS, io)).failed).toEqual([]);
    const failing: McpIO = { ...io, env: { ...io.env, FAKE_CLAUDE_FAIL: "add" } };
    const back = await applyMcp(await rescan(), h, [{ kind: "mcp-restore", agent: "claude", name: "github" }], {}, FORMATS, failing);
    expect(back.done).toEqual([]);
    expect(back.failed.map((f) => f.why)[0]).toStartWith("Invalid configuration");
    expect(JSON.stringify(back)).not.toContain("literal-value-0x43");
    expect(owned(h)).toEqual({ placed: { claude: ["github"] }, adoptedFrom: { claude: { github: lit } } });
  });

  test("a table canopy marked stays canopy's when the ownership file is lost, so set and remove still work", async () => {
    const { h, io, rescan } = await machine();
    const toml = join(h, ".codex", "config.toml");
    const set: KitMcpAction = { kind: "mcp-set", agent: "codex", name: "wiki-memory" };
    expect((await applyMcp(await rescan(), h, [set], { "codex/wiki-memory": { command: "bash" } }, FORMATS, io)).failed).toEqual([]);
    rmSync(ownedPath(h));
    const lost = await rescan();
    // what planning reads too: the marked table counts, the hand-made node_repl does not
    expect(lost.owned.placed["codex"]).toEqual(["wiki-memory"]);
    const again = await applyMcp(lost, h, [set], { "codex/wiki-memory": { command: "bash", args: ["/y.sh"] } }, FORMATS, io);
    expect(again.failed).toEqual([]);
    expect(codexServers(readFileSync(toml, "utf8"))?.["wiki-memory"]).toEqual({ command: "bash", args: ["/y.sh"] });
    rmSync(ownedPath(h));
    const gone = await applyMcp(await rescan(), h, [{ kind: "mcp-remove", agent: "codex", name: "wiki-memory" }], {}, FORMATS, io);
    expect(gone.failed).toEqual([]);
    expect(readFileSync(toml, "utf8")).toBe(ORIG);
    expect(owned(h)).toEqual({ placed: { codex: [] }, adoptedFrom: {} });
  });

  test("an adopt that cannot keep the hand-made entry first replaces nothing", async () => {
    const { h, io, log, rescan } = await machine();
    const seen = await rescan();
    chmodSync(join(h, ".claude"), 0o500);
    let r: Awaited<ReturnType<typeof applyMcp>>;
    try {
      r = await applyMcp(seen, h, [
        { kind: "mcp-adopt", agent: "claude", name: "github" },
        { kind: "mcp-adopt", agent: "codex", name: "node_repl" },
      ], { "claude/github": KIT_GH, "codex/node_repl": { command: "node", args: ["r2.js"] } }, FORMATS, io);
    } finally {
      chmodSync(join(h, ".claude"), 0o700);
    }
    expect(r.done).toEqual([]);
    expect(r.failed.map((f) => f.why.split(":")[0])).toEqual(["the hand-made entry could not be kept in ~/.claude/.canopy-kit-mcp.json; left as it is", "the hand-made entry could not be kept in ~/.claude/.canopy-kit-mcp.json; left as it is"]);
    expect(servers(h)["github"]).toEqual(HAND);
    expect(readFileSync(join(h, ".codex", "config.toml"), "utf8")).toBe(ORIG);
    expect(existsSync(log)).toBe(false);
    expect(existsSync(ownedPath(h))).toBe(false);
  });

  test("a successful adopt writes the kept entry before the agent's config, and placed after", async () => {
    const { h, io, rescan } = await machine();
    const calls: unknown[] = [];
    const run: typeof onHost = (host, argv, o) => {
      calls.push(argv[3] === "kit-owned" ? JSON.parse(o?.input ?? "null") : argv.slice(1, 3).join(" "));
      return onHost(host, argv, o);
    };
    const r = await applyMcp(await rescan(), h, [{ kind: "mcp-adopt", agent: "claude", name: "github" }], { "claude/github": KIT_GH }, FORMATS, { ...io, run });
    expect(r.failed).toEqual([]);
    expect(calls).toEqual([
      { placed: {}, adoptedFrom: { claude: { github: HAND } } },
      "mcp remove",
      "mcp add-json",
      { placed: { claude: ["github"] }, adoptedFrom: { claude: { github: HAND } } },
    ]);
  });

  test("an ownership write that fails leaves no staged copy behind", async () => {
    const { h, io, rescan } = await machine();
    // a folder in the file's place that cannot be written: the mv fails
    mkdirSync(ownedPath(h), { mode: 0o500 });
    let r: Awaited<ReturnType<typeof applyMcp>>;
    try {
      r = await applyMcp(await rescan(), h, [{ kind: "mcp-set", agent: "claude", name: "excalidraw" }], { "claude/excalidraw": { command: "npx" } }, FORMATS, io);
    } finally {
      chmodSync(ownedPath(h), 0o700);
    }
    expect(r.failed.map((f) => f.why)[0]).toStartWith("written, but ~/.claude/.canopy-kit-mcp.json was not");
    expect(readdirSync(join(h, ".claude")).filter((n) => n.includes(".tmp-"))).toEqual([]);
    expect(readdirSync(ownedPath(h))).toEqual([]);
  });

  test("applyKit sends skills to the skills script and MCP actions here, merged in the order asked", async () => {
    const { h, io, rescan } = await machine();
    mkdirSync(join(h, ".claude", "skills", "ship"), { recursive: true });
    const seen: KitSeen = { machine: "mac", at: 1, away: null, home: h, store: null, targets: [{ agent: "claude", dir: join(h, ".claude", "skills"), exists: true, parentExists: true, entries: [], placed: {} }], sources: {} };
    const setClaude: KitAction = { kind: "mcp-set", agent: "claude", name: "excalidraw" };
    const linkShip: KitAction = { kind: "link", agent: "claude", name: "ship", link: "../../x/ship" };
    const setCodex: KitAction = { kind: "mcp-set", agent: "codex", name: "wiki-memory" };
    const linkOther: KitAction = { kind: "link", agent: "claude", name: "other", link: "../../x/other" };
    const r = await applyKit(seen, null, [setClaude, linkShip, setCodex, linkOther], {
      env: io.env,
      mcp: { seen: await rescan(), entries: { "claude/excalidraw": { command: "npx" }, "codex/wiki-memory": { command: "bash" } }, formats: FORMATS },
    });
    expect(r).toEqual({ machine: "mac", done: [setClaude, setCodex, linkOther], failed: [{ action: linkShip, why: "exists" }] });
    expect(readlinkSync(join(h, ".claude", "skills", "other"))).toBe("../../x/other");
    expect(servers(h)["excalidraw"]).toEqual({ command: "npx" });
    expect(owned(h)).toEqual({ placed: { claude: ["excalidraw"], codex: ["wiki-memory"] }, adoptedFrom: {} });
  });

  test("applyKit without an MCP scan fails only the MCP actions", async () => {
    const { h, io } = await machine();
    mkdirSync(join(h, ".claude", "skills"));
    const seen: KitSeen = { machine: "mac", at: 1, away: null, home: h, store: null, targets: [{ agent: "claude", dir: join(h, ".claude", "skills"), exists: true, parentExists: true, entries: [], placed: {} }], sources: {} };
    const set: KitAction = { kind: "mcp-set", agent: "claude", name: "excalidraw" };
    const link: KitAction = { kind: "link", agent: "claude", name: "other", link: "../../x/other" };
    const r = await applyKit(seen, null, [set, link], { env: io.env });
    expect(r).toEqual({ machine: "mac", done: [link], failed: [{ action: set, why: "no MCP scan for this machine; rescan" }] });
  });
});
