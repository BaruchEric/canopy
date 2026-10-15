import { describe, expect, test } from "bun:test";
import { buildEntry, cellsOf, expandHome, hasSecrets, maskEntry, mcpCells, mcpDefOf, mcpHash, parseKit, parseMcpValue, planKit, planMcp, relPath, sameEntry, secretsOf, skillNames, sourcePath, targetsFor, wanted } from "./kit";
import type { KitAction, KitCell, KitManifest, KitMcpCtx, KitMcpOwned, KitSeen, KitSeenTarget, SecretKeyState, SecretsInfo } from "./types";

const RAW = {
  version: 1,
  machines: {
    mac: { backend: "mac" },
    mini: { backend: "mini" },
    gpd: { ssh: "gpd", via: "mac", dev: "/home/eric/dev" },
  },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store" },
    { agent: "codex", skills: "~/.codex/skills", mode: "link" },
    { agent: "hermes", skills: "~/.hermes/skills", mode: "link", machines: ["mini"] },
  ],
  skills: {
    default: { agents: ["*"], machines: ["*"] },
    only: { desk: { agents: ["claude"] }, craft: { source: "dev:dev-tools/craft/skill" } },
    exclude: ["*-workspace", "synced"],
  },
};

function kit(): KitManifest {
  const r = parseKit(RAW);
  if ("errors" in r) throw new Error(r.errors.join("; "));
  return r.kit;
}

const tgt = (agent: string, dir: string, over: Partial<KitSeenTarget> = {}): KitSeenTarget => ({
  agent, dir, exists: true, parentExists: true, entries: [], placed: {}, ...over,
});

function seen(over: Partial<KitSeen> = {}): KitSeen {
  return {
    machine: "mac", at: 1, away: null, home: "/Users/e",
    store: { tracked: ["ship", "desk", "book-workspace"], branch: "main", ahead: 0, behind: 0, dirty: 0, fetchFailed: false },
    targets: [
      tgt("claude", "/Users/e/.claude/skills", { entries: [
        { name: "ship", kind: "dir", link: null },
        { name: "desk", kind: "dir", link: null },
        { name: "book-workspace", kind: "dir", link: null },
      ] }),
      tgt("codex", "/Users/e/.codex/skills"),
    ],
    sources: { craft: false },
    ...over,
  };
}

describe("parseKit", () => {
  test("reads machines, targets and rules", () => {
    const k = kit();
    expect(k.machines.map((m) => m.name)).toEqual(["mac", "mini", "gpd"]);
    expect(k.machines[2]).toEqual({ name: "gpd", backend: null, ssh: "gpd", via: "mac", dev: "/home/eric/dev" });
    expect(k.targets[2]!.machines).toEqual(["mini"]);
    expect(k.only["craft"]!.source).toBe("dev:dev-tools/craft/skill");
  });
  test("refuses a missing store target, a second store, and a repeated agent", () => {
    const bad = (targets: unknown) => parseKit({ ...RAW, targets });
    expect(bad([{ agent: "codex", skills: "~/x", mode: "link" }])).toEqual({ errors: ["targets: exactly one target has mode store"] });
    expect("errors" in bad([...RAW.targets, { agent: "codex", skills: "~/y", mode: "link" }])).toBe(true);
  });
  test("refuses a store target limited to some machines: every machine's first target must be the store", () => {
    const targets = [{ agent: "claude", skills: "~/.claude/skills", mode: "store", machines: ["mac"] }, { agent: "codex", skills: "~/.codex/skills", mode: "link" }];
    expect(parseKit({ ...RAW, targets })).toEqual({ errors: ["targets[0]: the store target is on every machine, so it takes no machines"] });
  });
  test("refuses an ssh machine without via or dev, and a non-object", () => {
    expect("errors" in parseKit({ ...RAW, machines: { gpd: { ssh: "gpd" } } })).toBe(true);
    expect(parseKit(null)).toEqual({ errors: ["kit.json is not an object"] });
    expect(parseKit({ ...RAW, version: 2 })).toEqual({ errors: ["version: only 1 is known"] });
  });
});

describe("paths", () => {
  test("expandHome", () => {
    expect(expandHome("~/.codex/skills", "/h")).toBe("/h/.codex/skills");
    expect(expandHome("~", "/h")).toBe("/h");
    expect(expandHome("/opt/x", "/h")).toBe("/opt/x");
  });
  test("relPath from a target dir to the store", () => {
    expect(relPath("/h/.codex/skills", "/h/.claude/skills")).toBe("../../.claude/skills");
    expect(relPath("/h/.claude/skills", "/h/.claude/skills")).toBe(".");
    expect(relPath("/opt/stacks/x/skills", "/h/.claude/skills")).toBe("../../../../h/.claude/skills");
  });
  test("sourcePath takes dev: and absolute, nothing else", () => {
    expect(sourcePath("dev:dev-tools/craft/skill", "/home/eric/dev")).toBe("/home/eric/dev/dev-tools/craft/skill");
    expect(sourcePath("/abs/skill", "/d")).toBe("/abs/skill");
    expect(sourcePath("~/x", "/d")).toBeNull();
    expect(sourcePath("dev:../escape", "/d")).toBeNull();
  });
});

describe("rules", () => {
  test("targetsFor keeps the store first and drops targets for other machines", () => {
    expect(targetsFor(kit(), "mac").map((t) => t.agent)).toEqual(["claude", "codex"]);
    expect(targetsFor(kit(), "mini").map((t) => t.agent)).toEqual(["claude", "codex", "hermes"]);
  });
  test("skillNames: tracked, minus excluded, plus sources", () => {
    expect(skillNames(kit(), seen())).toEqual(["craft", "desk", "ship"]);
  });
  test("wanted follows only over default", () => {
    expect(wanted(kit(), "desk", "codex", "mac")).toBe(false);
    expect(wanted(kit(), "desk", "claude", "mac")).toBe(true);
    expect(wanted(kit(), "ship", "codex", "gpd")).toBe(true);
  });
});

describe("planKit", () => {
  test("links what is missing, relatively", () => {
    expect(planKit(kit(), seen(), "/Users/e/dev")).toEqual([
      { kind: "link", agent: "codex", name: "ship", link: "../../.claude/skills/ship" },
    ]);
  });
  test("leaves a foreign entry alone (review focus 1)", () => {
    const s = seen();
    s.targets[1]!.entries = [{ name: "ship", kind: "dir", link: null }];
    expect(planKit(kit(), s, "/d")).toEqual([]);
  });
  test("relinks a placed link still as placed whose wanted text moved, never a placed name that became a folder (review focus 4)", () => {
    const s = seen();
    s.targets[1]!.placed = { ship: "../old/skills/ship", gone: "../../.claude/skills/gone" };
    s.targets[1]!.entries = [{ name: "ship", kind: "link", link: "../old/skills/ship" }, { name: "gone", kind: "dir", link: null }];
    expect(planKit(kit(), s, "/d")).toEqual([
      { kind: "relink", agent: "codex", name: "ship", link: "../../.claude/skills/ship" },
    ]);
  });
  test("a placed link someone pointed elsewhere by hand is drift, left for a person: never relinked or removed", () => {
    const s = seen();
    s.targets[1]!.placed = { ship: "../../.claude/skills/ship", desk: "../../.claude/skills/desk" };
    s.targets[1]!.entries = [
      { name: "desk", kind: "link", link: "/mine/desk" },
      { name: "ship", kind: "link", link: "/elsewhere" },
    ];
    expect(planKit(kit(), s, "/d")).toEqual([]);
    expect(cellsOf(kit(), [{ seen: s, dev: "/d" }]).find((c) => c.agent === "codex" && c.skill === "ship")?.state).toBe("drift");
  });
  test("removes a placed link no longer wanted", () => {
    const s = seen();
    s.targets[1]!.placed = { desk: "../../.claude/skills/desk", ship: "../../.claude/skills/ship" };
    s.targets[1]!.entries = [
      { name: "desk", kind: "link", link: "../../.claude/skills/desk" },
      { name: "ship", kind: "link", link: "../../.claude/skills/ship" },
    ];
    expect(planKit(kit(), s, "/d")).toEqual([{ kind: "remove", agent: "codex", name: "desk" }]);
  });
  test("makes a missing target dir only when its parent exists", () => {
    const s = seen();
    s.targets[1] = tgt("codex", "/Users/e/.codex/skills", { exists: false });
    expect(planKit(kit(), s, "/d")[0]).toEqual({ kind: "mkdir", agent: "codex" });
    s.targets[1] = tgt("codex", "/Users/e/.codex/skills", { exists: false, parentExists: false });
    expect(planKit(kit(), s, "/d")).toEqual([]);
  });
  test("links a present source into the store, absolutely", () => {
    const s = seen({ sources: { craft: true } });
    expect(planKit(kit(), s, "/Users/e/dev")).toContainEqual(
      { kind: "link", agent: "claude", name: "craft", link: "/Users/e/dev/dev-tools/craft/skill" },
    );
  });
  test("offers a pull when behind and not ahead, nothing for an away machine", () => {
    const s = seen();
    s.store!.behind = 5;
    expect(planKit(kit(), s, "/d")[0]).toEqual({ kind: "pull" });
    s.store!.ahead = 1;
    expect(planKit(kit(), s, "/d").some((a) => a.kind === "pull")).toBe(false);
    expect(planKit(kit(), seen({ away: "ssh: needs a browser check", targets: [], store: null }), "/d")).toEqual([]);
  });
});

describe("cellsOf", () => {
  test("states per machine and agent", () => {
    const s = seen();
    s.targets[1]!.entries = [{ name: "desk", kind: "dir", link: null }];
    s.targets[0]!.entries.push({ name: "omarchy", kind: "link", link: "/usr/share/omarchy/x" });
    const cells = cellsOf(kit(), [{ seen: s, dev: "/d" }]);
    const at = (agent: string, skill: string) => cells.find((c) => c.agent === agent && c.skill === skill)?.state;
    expect(at("claude", "ship")).toBe("ok");
    expect(at("codex", "ship")).toBe("missing");
    expect(at("codex", "desk")).toBe("local");
    expect(at("claude", "omarchy")).toBe("local");
    expect(at("claude", "craft")).toBe("no-source");
  });
  test("an entry that is no kit skill reads local, never foreign (Omarchy's own links, Codex's own skills)", () => {
    const s = seen();
    s.targets[1]!.entries = [{ name: "diagnose-crash", kind: "link", link: "/usr/share/omarchy/x" }, { name: "qnap-nas-control", kind: "dir", link: null }];
    const cells = cellsOf(kit(), [{ seen: s, dev: "/d" }]);
    const at = (skill: string) => cells.find((c) => c.agent === "codex" && c.skill === skill);
    expect(at("diagnose-crash")).toMatchObject({ state: "local", why: "not in the store; canopy leaves it alone" });
    expect(at("qnap-nas-control")?.state).toBe("local");
  });
  test("an away machine is one away cell per agent", () => {
    const cells = cellsOf(kit(), [{ seen: seen({ machine: "gpd", away: "ssh exited 255", targets: [], store: null }), dev: "/d" }]);
    expect(cells.every((c) => c.state === "away" && c.skill === "*")).toBe(true);
    expect(cells.map((c) => c.agent)).toEqual(["claude", "codex"]);
  });
});

describe("mcpHash", () => {
  const DEF = { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] };
  test("is SHA-256 over the canonical JSON, the same for any key order", async () => {
    const text = '{"args":["-y","@modelcontextprotocol/server-github"],"command":"bunx","env":["GITHUB_PERSONAL_ACCESS_TOKEN"],"headers":[],"url":null}';
    const want = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    expect(await mcpHash(DEF)).toBe(want);
    expect(await mcpHash({ headers: [], env: DEF.env, url: null, args: DEF.args, command: "bunx" })).toBe(want);
  });
  test("sorts the env and header names itself, so the caller need not", async () => {
    const a = { ...DEF, env: ["B_TOKEN", "A_TOKEN"], headers: ["X-B", "Authorization"] };
    const b = { ...DEF, env: ["A_TOKEN", "B_TOKEN"], headers: ["Authorization", "X-B"] };
    expect(await mcpHash(a)).toBe(await mcpHash(b));
    expect(a.env).toEqual(["B_TOKEN", "A_TOKEN"]);
  });
  test("changes with each hashed field", async () => {
    const base = await mcpHash(DEF);
    for (const d of [
      { ...DEF, command: "npx" },
      { ...DEF, args: ["-y"] },
      { ...DEF, command: null, args: [], url: "https://example.invalid/mcp" },
      { ...DEF, env: ["GITHUB_TOKEN"] },
      { ...DEF, headers: ["Authorization"] },
    ]) expect(await mcpHash(d)).not.toBe(base);
  });
});

const MCP_TARGETS = [
  { agent: "claude", skills: "~/.claude/skills", mode: "store", mcp: { file: "~/.claude.json", format: "claude-json" } },
  { agent: "codex", skills: "~/.codex/skills", mode: "link", mcp: { file: "~/.codex/config.toml", format: "codex-toml" } },
  { agent: "hermes", skills: "~/.hermes/skills", mode: "link", machines: ["mini"] },
];

describe("the mcp block", () => {
  const parse = (mcp: unknown, over: Record<string, unknown> = {}) => parseKit({ ...RAW, targets: MCP_TARGETS, mcp, ...over });
  const ok = (mcp: unknown) => {
    const r = parse(mcp);
    if ("errors" in r) throw new Error(r.errors.join("; "));
    return r.kit;
  };
  const errs = (mcp: unknown, over: Record<string, unknown> = {}) => {
    const r = parse(mcp, over);
    return "errors" in r ? r.errors.join("; ") : "";
  };

  test("values are a literal, an env reference or a secret reference, and nothing in between", () => {
    expect(parseMcpValue("info")).toEqual({ literal: "info" });
    expect(parseMcpValue("${env:PATH}")).toEqual({ env: "PATH" });
    expect(parseMcpValue("${secret:gh_token}")).toEqual({ secret: "gh_token" });
    expect(parseMcpValue("Bearer ${secret:gh_token}")).toContain("not one whole");
    expect(parseMcpValue("${secret:../x}")).toContain("not a secret name");
    expect(parseMcpValue(5)).toBe("is not a string");
  });

  test("reads command and url servers, filters and options", () => {
    const k = ok({
      github: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:gh_token}", LOG: "info", PATH_X: "${env:PATH}" } },
      executor: { url: "https://mini.example/mcp", options: { claude: { headersHelper: "~/.config/executor/mcp-headers.sh" }, codex: { bearer_token_env_var: "EXECUTOR_API_KEY" } } },
      excalidraw: { command: "npx", args: ["-y", "excalidraw-render"], agents: ["claude"], machines: ["mac"] },
    });
    expect(k.targets.find((t) => t.agent === "claude")?.mcp).toEqual({ file: "~/.claude.json", format: "claude-json" });
    expect(k.targets.find((t) => t.agent === "hermes")?.mcp).toBeNull();
    const gh = k.mcp.find((s) => s.name === "github");
    if (!gh) throw new Error("no github");
    expect(gh.env).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: { secret: "gh_token" }, LOG: { literal: "info" }, PATH_X: { env: "PATH" } });
    expect(hasSecrets(gh)).toBe(true);
    expect(secretsOf(gh)).toEqual({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {} });
    expect(mcpDefOf(gh)).toEqual({ command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN", "LOG", "PATH_X"], headers: [] });
    expect(k.mcp.find((s) => s.name === "executor")?.options).toEqual({ claude: { headersHelper: "~/.config/executor/mcp-headers.sh" }, codex: { bearer_token_env_var: "EXECUTOR_API_KEY" } });
    expect(k.mcp.find((s) => s.name === "excalidraw")).toMatchObject({ agents: ["claude"], machines: ["mac"], args: ["-y", "excalidraw-render"] });
    expect(ok(undefined).mcp).toEqual([]);
  });

  test("refuses what it cannot write", () => {
    expect(errs({ x: { command: "a", url: "https://b" } })).toContain("needs command or url");
    expect(errs({ x: { url: "https://b", env: { A: "1" } } })).toContain("env is for a command");
    expect(errs({ x: { command: "a", headers: { A: "1" } } })).toContain("headers are for a url");
    expect(errs({ x: { url: "ftp://b" } })).toContain("http or https");
    expect(errs({ x: { command: "a", env: { A: "pre${secret:gh_token}" } } })).toContain("not one whole");
    expect(errs({ "x.y": { command: "a", env: { A: "${secret:gh_token}" } } })).toContain("a server with secrets");
    expect(errs({ x: { command: "a", env: { A: "${secret:gh_token}" }, options: { claude: { timeout: 5 } } } })).toContain("options are for servers without secrets");
    expect(errs({ x: { command: "a", options: { claude: { command: "b" } } } })).toContain("reserved");
    expect(errs({ x: { command: "a", options: { claude: { deep: { a: 1 } } } } })).toContain("a string, a number or a boolean");
    const long = { ...RAW.machines, "a-very-long-machine-name-xx": { backend: "far" } };
    expect(errs({ ["a".repeat(32)]: { command: "a", env: { A: "${secret:gh_token}" } } }, { machines: long })).toContain("too long");
  });

  test("an mcp target fits its agent, and Claude's is ~/.claude.json", () => {
    const one = (mcp: unknown) => {
      const r = parseKit({ ...RAW, targets: [{ agent: "claude", skills: "~/.claude/skills", mode: "store", mcp }] });
      return "errors" in r ? r.errors.join("; ") : "";
    };
    expect(one({ file: "~/.codex/config.toml", format: "codex-toml" })).toContain("claude-json for claude");
    expect(one({ file: "~/other.json", format: "claude-json" })).toContain("~/.claude.json");
  });
});

const MCP_RAW = {
  ...RAW,
  targets: MCP_TARGETS,
  mcp: {
    github: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:gh_token}" } },
    excalidraw: { command: "npx", args: ["-y", "excalidraw-render"], agents: ["claude"], machines: ["mac"] },
    executor: { url: "https://mini.example/mcp", options: { claude: { headersHelper: "~/.config/executor/mcp-headers.sh" }, codex: { bearer_token_env_var: "EXECUTOR_API_KEY" } } },
    hook: { url: "https://hook.example/mcp", headers: { Authorization: "${secret:hook_key}" } },
  },
};
function mkit(): KitManifest {
  const r = parseKit(MCP_RAW);
  if ("errors" in r) throw new Error(r.errors.join("; "));
  return r.kit;
}
const WRAP = "/Users/e/.claude/bin/canopy-mcp-env";
const GH_ARGS = ["github", "--", "bunx", "-y", "@modelcontextprotocol/server-github"];

const STAMP_K = "2026-10-14T12:00:00.000Z";
function secretsInfo(allow: string[], state: SecretKeyState | null): SecretsInfo {
  const meta = { description: "", tags: [], created: STAMP_K, rotated: STAMP_K, to: ["mac", "mini"], usedBy: [] };
  return {
    ok: true, error: null, backend: "mac", role: "reader", head: "abc", refused: null, lock: "open", recipient: null,
    secrets: [{ name: "gh_token", allow, ...meta }, { name: "hook_key", allow: [], ...meta }],
    sinks: state === null ? [] : [{ id: "mcp-github-mac", machine: "mac", path: "/Users/e/.claude/mcp-env/github.env", format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, state: { GITHUB_PERSONAL_ACCESS_TOKEN: state }, error: null }],
    proposals: [], passkeys: [], session: false, firstPasskey: false, gate: "", unpushed: 0,
  };
}

interface CtxOver {
  allow?: "current" | "old" | "none";
  sink?: SecretKeyState | null;
  claude?: Record<string, Record<string, unknown>> | null;
  codex?: Record<string, Record<string, unknown>> | null;
  owned?: Partial<KitMcpOwned>;
  ignored?: boolean;
  wrapper?: boolean;
  ssh?: boolean;
  env?: Record<string, string>;
}
async function mctx(k: KitManifest, o: CtxOver = {}): Promise<KitMcpCtx> {
  const hashes: Record<string, string> = {};
  for (const s of k.mcp) hashes[s.name] = await mcpHash(mcpDefOf(s));
  const allow = o.allow === "none" ? [] : [`mcp:github#${o.allow === "old" ? "0".repeat(64) : hashes["github"]}`, "sink:mcp-github-mac"];
  const file = (agent: string, path: string, entries: Record<string, Record<string, unknown>> | null | undefined) =>
    ({ agent, path, stamp: "1 2", exists: true, text: "", entries: entries === undefined ? {} : entries, error: entries === null ? "config.toml does not parse" : null });
  return {
    mcp: {
      claude: "/Users/e/.local/bin/claude", ignored: o.ignored ?? true, wrapper: o.wrapper ?? true,
      owned: { placed: {}, adoptedFrom: {}, ...o.owned },
      files: [file("claude", "/Users/e/.claude.json", o.claude), file("codex", "/Users/e/.codex/config.toml", o.codex)],
    },
    hashes, secrets: secretsInfo(allow, o.sink === undefined ? "same" : o.sink), home: "/Users/e", env: o.env ?? {}, ssh: o.ssh ?? false,
  };
}
const kinds = (r: { actions: KitAction[] }) => r.actions.map((a) => ("name" in a ? `${a.kind} ${a.agent}/${a.name}` : a.kind));
const mcell = (cells: KitCell[], agent: string, name: string) => cells.find((c) => c.agent === agent && c.skill === name);

describe("MCP entries", () => {
  test("a server with secrets runs through the wrapper; options and ~ land as written", () => {
    const k = mkit();
    const s = (n: string) => k.mcp.find((x) => x.name === n)!;
    expect(buildEntry(s("github"), "claude", "claude-json", "/Users/e", {})).toEqual({ entry: { type: "stdio", command: WRAP, args: GH_ARGS } });
    expect(buildEntry(s("github"), "codex", "codex-toml", "/Users/e", {})).toEqual({ entry: { command: WRAP, args: GH_ARGS } });
    expect(buildEntry(s("executor"), "claude", "claude-json", "/Users/e", {})).toEqual({ entry: { type: "http", url: "https://mini.example/mcp", headersHelper: "/Users/e/.config/executor/mcp-headers.sh" } });
    expect(buildEntry(s("executor"), "codex", "codex-toml", "/Users/e", {})).toEqual({ entry: { url: "https://mini.example/mcp", bearer_token_env_var: "EXECUTOR_API_KEY" } });
    expect(buildEntry(s("hook"), "claude", "claude-json", "/Users/e", {})).toEqual({ entry: { type: "http", url: "https://hook.example/mcp", headersHelper: `${WRAP} --headers hook` } });
    expect(buildEntry(s("hook"), "codex", "codex-toml", "/Users/e", {})).toEqual({ state: "unsupported", why: "not supported for codex: a url server with secret headers" });
  });

  test("an ${env:} the canopy process lacks keeps the server out", () => {
    const r = parseKit({ ...MCP_RAW, mcp: { x: { command: "a", env: { T: "${env:NOT_SET_HERE}" } } } });
    if ("errors" in r) throw new Error(r.errors.join());
    expect(buildEntry(r.kit.mcp[0]!, "claude", "claude-json", "/Users/e", {})).toEqual({ state: "unresolved", why: "${env:NOT_SET_HERE} is not set for canopy here" });
    expect(buildEntry(r.kit.mcp[0]!, "claude", "claude-json", "/Users/e", { NOT_SET_HERE: "v" })).toEqual({ entry: { type: "stdio", command: "a", args: [], env: { T: "v" } } });
  });

  test("an env name that reads like the unset signal is just a name, and its value never reaches why", () => {
    const r = parseKit({ ...MCP_RAW, mcp: { x: { command: "a", env: { unset: "${env:SET_HERE}" } } } });
    if ("errors" in r) throw new Error(r.errors.join());
    const built = buildEntry(r.kit.mcp[0]!, "claude", "claude-json", "/Users/e", { SET_HERE: "value-0123" });
    expect(built).toEqual({ entry: { type: "stdio", command: "a", args: [], env: { unset: "value-0123" } } });
    expect("why" in built ? built.why : "").not.toContain("value-0123");
  });

  test("sameEntry ignores type stdio and empty lists and tables", () => {
    expect(sameEntry({ type: "stdio", command: "a", args: [], env: {} }, { command: "a" })).toBe(true);
    expect(sameEntry({ command: "a", args: ["x"] }, { command: "a" })).toBe(false);
  });

  test("maskEntry hides env and header values, url query values and token-like strings, and keeps names (review focus 3)", () => {
    const tok = "ghp_0123456789abcdefABCDEF0123456789";
    const m = maskEntry({ command: "bunx", args: [`--token=${tok}`, "-y"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: tok }, url: `https://x.example/mcp?key=${tok}&mode=b`, headers: { Authorization: `Bearer ${tok}` }, bearer_token_env_var: "EXECUTOR_API_KEY" });
    expect(JSON.stringify(m)).not.toContain(tok);
    expect(m).toEqual({ command: "bunx", args: ["--token=•••", "-y"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "•••" }, url: "https://x.example/mcp?key=•••&mode=•••", headers: { Authorization: "•••" }, bearer_token_env_var: "EXECUTOR_API_KEY" });
  });
});

describe("MCP planning", () => {
  test("allowed, with its sink in step: every wanted server is set; hook waits for its allowance", async () => {
    const k = mkit();
    const r = planMcp(k, seen(), await mctx(k));
    expect(kinds(r).sort()).toEqual(["mcp-set claude/excalidraw", "mcp-set claude/executor", "mcp-set claude/github", "mcp-set codex/executor", "mcp-set codex/github"]);
    expect(r.entries["claude/github"]).toEqual({ type: "stdio", command: WRAP, args: GH_ARGS });
    const cells = mcpCells(k, seen(), await mctx(k));
    expect(mcell(cells, "claude", "hook")).toMatchObject({ state: "not-allowed", kind: "mcp" });
    expect(mcell(cells, "codex", "hook")?.state).toBe("unsupported");
    expect(mcell(cells, "codex", "excalidraw")?.state).toBe("off");
  });

  test("not allowed, or allowed for an older definition: no write, and a written one comes out (review focus 2)", async () => {
    const k = mkit();
    expect(kinds(planMcp(k, seen(), await mctx(k, { allow: "none" })))).not.toContain("mcp-set claude/github");
    const written = { github: { type: "stdio", command: WRAP, args: GH_ARGS } };
    const stale = await mctx(k, { allow: "old", claude: written, owned: { placed: { claude: ["github"] } } });
    expect(kinds(planMcp(k, seen(), stale))).toContain("mcp-remove claude/github");
    expect(mcell(mcpCells(k, seen(), stale), "claude", "github")).toMatchObject({ state: "stale-allowance", why: "allowed for an older definition; allow it again" });
  });

  test("a locked Mac: a server not yet written stays out, one already written stays in (review focus 1)", async () => {
    const k = mkit();
    const fresh = await mctx(k, { sink: "waiting" });
    expect(kinds(planMcp(k, seen(), fresh))).not.toContain("mcp-set claude/github");
    expect(mcell(mcpCells(k, seen(), fresh), "claude", "github")).toMatchObject({ state: "no-sink", why: "waiting for unlock" });
    const kept = await mctx(k, { sink: "waiting", claude: { github: { type: "stdio", command: WRAP, args: GH_ARGS } }, owned: { placed: { claude: ["github"] } } });
    expect(kinds(planMcp(k, seen(), kept)).filter((x) => x.endsWith("claude/github"))).toEqual([]);
    expect(mcell(mcpCells(k, seen(), kept), "claude", "github")?.state).toBe("ok");
  });

  test("no sink, no ignore line, no wrapper, and gpd each keep the server out and say why", async () => {
    const k = mkit();
    const why = async (o: CtxOver, machine = "mac") => mcell(mcpCells(k, seen({ machine }), await mctx(k, o)), "claude", "github");
    expect(await why({ sink: null })).toMatchObject({ state: "no-sink", why: "no sink mcp-github-mac; allow it again" });
    expect(await why({ ignored: false })).toMatchObject({ state: "no-sink", why: "dotclaude does not ignore mcp-env/ here; pull dotclaude" });
    expect(await why({ wrapper: false })).toMatchObject({ state: "no-sink", why: "~/.claude/bin/canopy-mcp-env is missing; pull dotclaude" });
    expect((await why({ ssh: true }, "gpd"))?.state).toBe("phase-3");
  });

  test("a hand-made entry of a kit name is adoptable and never planned; one the kit lacks is local", async () => {
    const k = mkit();
    const c = await mctx(k, { claude: { github: { type: "stdio", command: "bash", args: ["-c", "GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) exec bunx -y @modelcontextprotocol/server-github"] } }, codex: { node_repl: { command: "node" } } });
    const r = planMcp(k, seen(), c);
    expect(kinds(r).filter((x) => x.endsWith("/github"))).toEqual(["mcp-set codex/github"]);
    expect(r.entries["claude/github"]).toEqual({ type: "stdio", command: WRAP, args: GH_ARGS });
    const cells = mcpCells(k, seen(), c);
    expect(mcell(cells, "claude", "github")).toMatchObject({ state: "adoptable", why: "a hand-made entry; adopt shows both" });
    expect(mcell(cells, "codex", "node_repl")).toMatchObject({ state: "local", why: "hand-made; kit.json does not define it" });
  });

  test("a managed entry that differs is rewritten, one the kit dropped is removed, and an adopted one can be put back", async () => {
    const k = mkit();
    const c = await mctx(k, {
      claude: { github: { type: "stdio", command: "old" }, gone: { command: "x" } },
      owned: { placed: { claude: ["github", "gone"] }, adoptedFrom: { claude: { github: { command: "bash" } } } },
    });
    expect(kinds(planMcp(k, seen(), c))).toEqual(expect.arrayContaining(["mcp-set claude/github", "mcp-remove claude/gone"]));
    expect(mcell(mcpCells(k, seen(), c), "claude", "github")).toMatchObject({ state: "drift", restore: true });
  });

  test("apply all never adopts or puts back, even with an adoptable entry and one to restore", async () => {
    const k = mkit();
    const c = await mctx(k, {
      claude: { github: { command: "bash" } },
      codex: { github: { type: "stdio", command: "old" } },
      owned: { placed: { codex: ["github"] }, adoptedFrom: { codex: { github: { command: "bash" } } } },
    });
    const cells = mcpCells(k, seen(), c);
    expect(mcell(cells, "claude", "github")?.state).toBe("adoptable");
    expect(mcell(cells, "codex", "github")).toMatchObject({ restore: true });
    const all = [...planMcp(k, seen(), c).actions, ...planKit(k, seen(), "/Users/e/dev", c)];
    expect(all.some((a) => a.kind === "mcp-set")).toBe(true);
    expect(all.filter((a) => a.kind === "mcp-adopt" || a.kind === "mcp-restore")).toEqual([]);
  });

  test("adopt waits for the allowance: a hand-made entry gets no kit entry until the kit's could be written", async () => {
    const k = mkit();
    const hand = { github: { command: "bash" } };
    const none = await mctx(k, { allow: "none", claude: hand });
    expect(mcell(mcpCells(k, seen(), none), "claude", "github")).toMatchObject({ state: "not-allowed", why: "not allowed; allow it from the kit view; a hand-made entry is there" });
    expect(planMcp(k, seen(), none).entries["claude/github"]).toBeUndefined();
    const waiting = await mctx(k, { sink: "waiting", claude: hand });
    expect(mcell(mcpCells(k, seen(), waiting), "claude", "github")).toMatchObject({ state: "no-sink", why: "waiting for unlock" });
    expect(planMcp(k, seen(), waiting).entries["claude/github"]).toBeUndefined();
    expect(planMcp(k, seen(), await mctx(k, { claude: hand })).entries["claude/github"]).toEqual({ type: "stdio", command: WRAP, args: GH_ARGS });
  });

  test("a hand-made entry's literal value reaches no cell and no action, and its preview is masked", async () => {
    const k = mkit();
    const tok = "ghp_9876543210zyxwvuZYXWVU9876543210";
    const hand = { type: "stdio", command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: tok } };
    const c = await mctx(k, { claude: { github: hand, mine: { command: "x", env: { K: tok } } } });
    const cells = mcpCells(k, seen(), c);
    expect(mcell(cells, "claude", "github")?.state).toBe("adoptable");
    expect(mcell(cells, "claude", "mine")?.state).toBe("local");
    expect(JSON.stringify(cells)).not.toContain(tok);
    expect(JSON.stringify(planMcp(k, seen(), c).actions)).not.toContain(tok);
    expect(JSON.stringify(cellsOf(k, [{ seen: seen(), dev: "/Users/e/dev", ctx: c }]))).not.toContain(tok);
    expect(JSON.stringify(maskEntry(hand))).not.toContain(tok);
  });

  test("a file that does not parse plans nothing for that agent and says why", async () => {
    const k = mkit();
    const c = await mctx(k, { codex: null });
    expect(kinds(planMcp(k, seen(), c)).filter((x) => x.includes("codex/"))).toEqual([]);
    expect(mcell(mcpCells(k, seen(), c), "codex", "github")).toMatchObject({ state: "drift", why: "config.toml does not parse" });
  });

  test("planKit and cellsOf carry the MCP part when given a ctx, and only then", async () => {
    const k = mkit();
    const c = await mctx(k);
    expect(planKit(k, seen(), "/Users/e/dev").some((a) => a.kind.startsWith("mcp-"))).toBe(false);
    expect(planKit(k, seen(), "/Users/e/dev", c).some((a) => a.kind === "mcp-set")).toBe(true);
    expect(cellsOf(k, [{ seen: seen(), dev: "/Users/e/dev", ctx: c }]).some((x) => x.kind === "mcp")).toBe(true);
  });
});
