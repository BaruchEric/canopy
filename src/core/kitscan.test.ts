import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseKit, planKit } from "./kit";
import { parseMcpScan, parseScan, parseTools, seeKit, seeMcp, seeTools } from "./kitscan";
import { exec } from "./exec";
import { fakeClaude } from "./kitfake";

const RAW = {
  version: 1,
  machines: { mac: { backend: "mac" } },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store" },
    { agent: "codex", skills: "~/.codex/skills", mode: "link" },
    { agent: "hermes", skills: "~/.hermes/skills", mode: "link" },
  ],
  skills: { only: { craft: { source: "dev:tools/craft" } } },
};
const kit = () => { const r = parseKit(RAW); if ("errors" in r) throw new Error(); return r.kit; };

let dirs: string[] = [];
afterEach(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); dirs = []; });

async function home(): Promise<string> {
  const h = mkdtempSync(join(tmpdir(), "kit-"));
  dirs.push(h);
  const origin = join(h, "origin.git");
  await exec(["git", "init", "-q", "--bare", "-b", "main", origin]);
  const store = join(h, ".claude");
  await exec(["git", "init", "-q", "-b", "main", store]);
  mkdirSync(join(store, "skills/ship"), { recursive: true });
  writeFileSync(join(store, "skills/ship/SKILL.md"), "x");
  await exec(["git", "-C", store, "add", "."]);
  await exec(["git", "-C", store, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
  await exec(["git", "-C", store, "remote", "add", "origin", origin]);
  await exec(["git", "-C", store, "push", "-q", "-u", "origin", "main"]);
  mkdirSync(join(store, "skills/.hidden"));
  mkdirSync(join(h, ".codex/skills/.system"), { recursive: true });
  mkdirSync(join(h, ".codex/skills/qnap-nas-control"));
  symlinkSync("../../.claude/skills/ship", join(h, ".codex/skills/ship"));
  writeFileSync(join(h, ".codex/skills/.canopy-kit.json"), JSON.stringify({ placed: { ship: "../../.claude/skills/ship" } }));
  mkdirSync(join(h, "dev/tools/craft"), { recursive: true });
  return h;
}

describe("seeKit on a scratch home", () => {
  test("reads the store, the targets, the placed lists and the sources", async () => {
    const h = await home();
    const s = await seeKit(kit(), { name: "mac", host: null, dev: join(h, "dev") }, { env: { HOME: h }, now: () => 7 });
    expect(s.away).toBeNull();
    expect(s.home).toBe(h);
    expect(s.store).toMatchObject({ tracked: ["ship"], branch: "main", ahead: 0, behind: 0, fetchFailed: false });
    expect(s.targets.map((t) => t.agent)).toEqual(["claude", "codex", "hermes"]);
    const codex = s.targets[1]!;
    expect(codex.entries).toEqual([
      { name: "qnap-nas-control", kind: "dir", link: null },
      { name: "ship", kind: "link", link: "../../.claude/skills/ship" },
    ]);
    expect(codex.placed).toEqual({ ship: "../../.claude/skills/ship" });
    expect(s.targets[2]).toMatchObject({ exists: false, parentExists: false });
    expect(s.targets[0]!.entries.map((e) => e.name)).toEqual(["ship"]);
    expect(s.sources).toEqual({ craft: true });
  });
  test("an unreachable machine reads away with the reason (review focus 2)", async () => {
    const run = async () => ({ code: 255, stdout: "", stderr: "# Tailscale SSH requires an additional check.\n" });
    const s = await seeKit(kit(), { name: "gpd", host: "gpd", dev: "/d" }, { run, now: () => 1 });
    expect(s.away).toBe("Tailscale SSH requires an additional check.");
    expect(s.store).toBeNull();
  });
  test("a host ssh cannot reach is asked once, not fetched and then scanned", async () => {
    let calls = 0;
    const run = async () => { calls++; return { code: 255, stdout: "", stderr: "ssh: connect to host gpd port 22: Connection refused\n" }; };
    const s = await seeKit(kit(), { name: "gpd", host: "gpd", dev: "/d" }, { run, now: () => 1 });
    expect(calls).toBe(1);
    expect(s.away).toBe("ssh: connect to host gpd port 22: Connection refused");
  });
  test("a fetch that never reached the host reads away without a second try", async () => {
    let calls = 0;
    const run = async () => { calls++; return { code: 143, stdout: "", stderr: "" }; };
    const s = await seeKit(kit(), { name: "gpd", host: "gpd", dev: "/d" }, { run, now: () => 1 });
    expect(calls).toBe(1);
    expect(s.away).toMatch(/no answer/);
  });
  test("a store git cannot read reads away, so nothing is planned against an empty list", async () => {
    const h = await home();
    writeFileSync(join(h, ".claude/.git/HEAD"), "garbage\n");
    const s = await seeKit(kit(), { name: "mac", host: null, dev: join(h, "dev") }, { env: { HOME: h }, now: () => 7 });
    expect(s.away).toMatch(/^store: /);
    expect(planKit(kit(), s, join(h, "dev"))).toEqual([]);
  });
  test("the store path from the manifest is never evaluated by the shell", async () => {
    const h = await home();
    const raw = structuredClone(RAW);
    raw.targets[0]!.skills = `~/.claude$(touch ${h}/pwned)/skills`;
    const r = parseKit(raw);
    if ("errors" in r) throw new Error(r.errors.join());
    await seeKit(r.kit, { name: "mac", host: null, dev: join(h, "dev") }, { env: { HOME: h }, now: () => 7 });
    expect(existsSync(join(h, "pwned"))).toBe(false);
  });
});

describe("parseScan", () => {
  test("skips names that are not slugs and counts dirty lines", () => {
    const out = [
      "H\t/h",
      "K\tship",
      "K\tBad Name",
      "G\t# branch.head main",
      "G\t# branch.ab +1 -2",
      "G\t1 .M N... 100644 100644 100644 a b CLAUDE.md",
      "G\t? notes.md",
      "D\tclaude\t/h/.claude/skills\t1\t1",
      "E\tclaude\tship\tdir\t",
      "E\tclaude\tWeird One\tdir\t",
    ].join("\n");
    const s = parseScan("mac", out, 3);
    expect(s.store).toEqual({ tracked: ["ship"], branch: "main", ahead: 1, behind: 2, dirty: 2, fetchFailed: false });
    expect(s.targets[0]!.entries).toEqual([{ name: "ship", kind: "dir", link: null }]);
  });
  test("reads adoptedFrom beside placed, and only string paths", () => {
    const s = parseScan("mac", [
      "D\tcodex\t/h/.codex/skills\t1\t1",
      `P\tcodex\t${JSON.stringify({ placed: { ship: "L" }, adoptedFrom: { ship: "/h/.codex/.canopy-kit-adopted/ship", bad: 3 } })}`,
    ].join("\n"), 3);
    expect(s.targets[0]).toMatchObject({ placed: { ship: "L" }, adoptedFrom: { ship: "/h/.codex/.canopy-kit-adopted/ship" } });
  });
});

describe("the tools scan", () => {
  const toolKit = (tools: unknown) => { const r = parseKit({ ...RAW, tools }); if ("errors" in r) throw new Error(r.errors.join("; ")); return r.kit; };
  test("reads the os and each check's exit: 0 ok, 127 not found, anything else with its first stderr line", async () => {
    const h = mkdtempSync(join(tmpdir(), "kit-tools-"));
    dirs.push(h);
    const k = toolKit({
      sh: { check: "sh -c true" },
      gone: { check: "kit-no-such-tool-x9 --version" },
      bad: { check: "echo; echo boom >&2; echo more >&2; exit 3" },
      noisy: { check: "echo out; true" },
    });
    const r = await seeTools(k, { host: null }, { env: { HOME: h, SHELL: "/bin/sh", PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    expect(r.os).not.toBe("");
    expect(r.tools).toEqual([
      { name: "sh", code: 0, err: "" },
      { name: "gone", code: 127, err: expect.stringContaining("kit-no-such-tool-x9") as unknown as string },
      { name: "bad", code: 3, err: "boom" },
      { name: "noisy", code: 0, err: "" },
    ]);
  });
  test("a check is a word to sh, never part of the script", async () => {
    const h = mkdtempSync(join(tmpdir(), "kit-tools-"));
    dirs.push(h);
    const k = toolKit({ x: { check: `touch ${join(h, "ran")}; exit 0` } });
    const r = await seeTools(k, { host: null }, { env: { HOME: h, SHELL: "/bin/sh", PATH: process.env["PATH"] ?? "/usr/bin:/bin" } });
    expect(r.tools[0]!.code).toBe(0);
    expect(existsSync(join(h, "ran"))).toBe(true);
  });
  test("parseTools: a slow check, ID_LIKE words, and lines that are not tools", () => {
    expect(parseTools(["O\tubuntu\tdebian", "T\tjq\tt\t", "T\tBad Name\t0\t", "T\tsops\tx\t", "junk"].join("\n"))).toEqual({
      os: "ubuntu", osLike: ["debian"], container: false, tools: [{ name: "jq", code: null, err: "" }],
    });
    expect(parseTools("O\tdebian\t\t1\n").container).toBe(true);
  });
  test("the script says whether it ran in a container, as KIT_CONTAINER says when set", async () => {
    const k = toolKit({ fine: { check: "true" } });
    const run = (v: string) => async (_h: string | null, cmd: string[]) => exec(cmd, { env: { KIT_CONTAINER: v } });
    expect((await seeTools(k, { host: null }, { run: run("1") })).container).toBe(true);
    expect((await seeTools(k, { host: null }, { run: run("0") })).container).toBe(false);
  });
  test("a script that fails throws its reason", async () => {
    const k = toolKit({ jq: { check: "jq --version" } });
    const run = async () => ({ code: 255, stdout: "", stderr: "ssh: connect to host gpd port 22: Connection refused" });
    await expect(seeTools(k, { host: "gpd" }, { run })).rejects.toThrow("the tools check failed: ssh: connect to host gpd port 22: Connection refused");
  });
});

describe("the MCP scan", () => {
  const KIT = {
    version: 1,
    machines: { mac: { backend: "mac" } },
    targets: [
      { agent: "claude", skills: "~/.claude/skills", mode: "store", mcp: { file: "~/.claude.json", format: "claude-json" } },
      { agent: "codex", skills: "~/.codex/skills", mode: "link", mcp: { file: "~/.codex/config.toml", format: "codex-toml" } },
    ],
    mcp: { excalidraw: { command: "npx" } },
  };
  const mkKit = () => {
    const r = parseKit(KIT);
    if ("errors" in r) throw new Error(r.errors.join());
    return r.kit;
  };

  test("reads the claude path, the ignore line, the wrapper, the ownership file and both config files", async () => {
    const h = mkdtempSync(join(tmpdir(), "mcpscan-"));
    try {
      const claude = fakeClaude(h);
      await exec(["git", "init", "-q", join(h, ".claude")]);
      writeFileSync(join(h, ".claude", ".gitignore"), "mcp-env/\n");
      mkdirSync(join(h, ".claude", "bin"));
      writeFileSync(join(h, ".claude", "bin", "canopy-mcp-env"), "#!/bin/sh\n", { mode: 0o755 });
      writeFileSync(join(h, ".claude", ".canopy-kit-mcp.json"), JSON.stringify({ placed: { claude: ["excalidraw"] }, adoptedFrom: { claude: { excalidraw: { command: "old" } } } }));
      writeFileSync(join(h, ".claude.json"), JSON.stringify({ numStartups: 1, mcpServers: { excalidraw: { type: "stdio", command: "npx" } } }));
      mkdirSync(join(h, ".codex"));
      writeFileSync(join(h, ".codex", "config.toml"), '[mcp_servers.node_repl]\ncommand = "node"\n');
      const m = await seeMcp(mkKit(), { name: "mac", host: null }, { env: { HOME: h, KIT_CLAUDE: claude } });
      expect(m?.claude).toBe(claude);
      expect(m?.ignored).toBe(true);
      expect(m?.wrapper).toBe(true);
      expect(m?.owned).toEqual({ placed: { claude: ["excalidraw"] }, adoptedFrom: { claude: { excalidraw: { command: "old" } } } });
      const [c, x] = m?.files ?? [];
      expect(c).toMatchObject({ agent: "claude", path: join(h, ".claude.json"), exists: true, entries: { excalidraw: { type: "stdio", command: "npx" } }, error: null });
      expect(c?.stamp).toMatch(/^\d+ \d+ \d+$/);
      expect(x).toMatchObject({ agent: "codex", entries: { node_repl: { command: "node" } } });
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("an ownership file that does not parse, is not an object or cannot be read is an error; J is the ignore probe (final review 3, 9)", () => {
    const b64 = (x: string) => Buffer.from(x).toString("base64");
    const scan = (o: string | null, j = "1") => parseMcpScan(["C\t", "I\t1", "W\t1", `J\t${j}`, ...(o === null ? [] : [`O\t${o}`])].join("\n"), {});
    const why = "~/.claude/.canopy-kit-mcp.json cannot be read or does not parse; fix or remove it by hand, since a write would lose what it records";
    for (const bad of [b64('{"placed": {"claude": ["git'), b64("[]"), b64("null"), b64(""), "?"]) expect(scan(bad).ownedError).toBe(why);
    expect(scan(b64('{"placed": {}, "adoptedFrom": {}}')).ownedError ?? null).toBeNull();
    expect(scan(null).ownedError ?? null).toBeNull();
    expect(scan(null).ownedIgnored).toBe(true);
    expect(scan(null, "0").ownedIgnored).toBe(false);
  });

  test("the scan probes git's ignore for the ownership file, and marks one it cannot read", async () => {
    const h = mkdtempSync(join(tmpdir(), "mcpscan-"));
    try {
      await exec(["git", "init", "-q", join(h, ".claude")]);
      writeFileSync(join(h, ".claude", ".gitignore"), "mcp-env/\n");
      const o = join(h, ".claude", ".canopy-kit-mcp.json");
      writeFileSync(o, JSON.stringify({ placed: {}, adoptedFrom: {} }));
      const env = { HOME: h, KIT_CLAUDE: fakeClaude(h) };
      const open = await seeMcp(mkKit(), { name: "mac", host: null }, { env });
      expect(open?.ownedIgnored).toBe(false);
      expect(open?.ownedError ?? null).toBeNull();
      writeFileSync(join(h, ".claude", ".gitignore"), "mcp-env/\n.canopy-kit-mcp.json\n");
      chmodSync(o, 0o000);
      const shut = await seeMcp(mkKit(), { name: "mac", host: null }, { env });
      expect(shut?.ownedIgnored).toBe(true);
      expect(shut?.ownedError).toContain("cannot be read or does not parse");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("~/.local/bin/claude is found before a login shell is started, and a failed scan throws its reason (final review 5)", async () => {
    const h = mkdtempSync(join(tmpdir(), "mcpscan-"));
    try {
      mkdirSync(join(h, ".local", "bin"), { recursive: true });
      writeFileSync(join(h, ".local", "bin", "claude"), "#!/bin/sh\n", { mode: 0o755 });
      const marker = join(h, "login-shell-ran");
      const shell = join(h, "shell");
      writeFileSync(shell, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
      const m = await seeMcp(mkKit(), { name: "mac", host: null }, { env: { HOME: h, PATH: "/usr/bin:/bin", SHELL: shell, KIT_CLAUDE: "" } });
      expect(m?.claude).toBe(join(h, ".local", "bin", "claude"));
      expect(existsSync(marker)).toBe(false);
      const fail = async () => ({ code: 2, stdout: "", stderr: "sh: base64: not found\n" });
      await expect(seeMcp(mkKit(), { name: "mac", host: null }, { run: fail })).rejects.toThrow("the MCP scan failed: sh: base64: not found");
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("a file that does not parse reads null with canopy's words, never the file's text", () => {
    const b64 = (s: string) => Buffer.from(s).toString("base64");
    const out = [
      "C\t", "I\t0", "W\t0",
      `M\tclaude\t/h/.claude.json\t1 9\t${b64('{"mcpServers": {"x": {"env": {"T": "tok-0x55"')}`,
      `M\tcodex\t/h/.codex/config.toml\t\t`,
    ].join("\n");
    const m = parseMcpScan(out, { claude: "claude-json", codex: "codex-toml" });
    expect(m.claude).toBeNull();
    expect(m.files[0]).toMatchObject({ entries: null, error: "~/.claude.json does not parse" });
    expect(JSON.stringify(m.files[0]?.error)).not.toContain("tok-0x55");
    expect(m.files[1]).toMatchObject({ exists: false, entries: {}, stamp: "", text: "" });
    expect(m.owned).toEqual({ placed: {}, adoptedFrom: {} });
  });
});
