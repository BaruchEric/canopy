# Kit and secrets phase 2 implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `~/.claude/kit.json` defines every MCP server for Claude and Codex on every machine; a server with secrets gets them from the store through `~/.claude/bin/canopy-mcp-env` after one gated allowance, so no agent config file holds a value; foreign servers can be adopted and put back; rotating a secret shows its full reach before the write.

**Architecture:** The pure core grows on both sides. `src/core/kit.ts` parses the `mcp` block, hashes a server's definition, builds the entry each agent should hold, and plans and paints MCP cells from a scan plus the secret store's metadata (`SecretsInfo`). `src/core/kitmcp.ts` is the only code that writes an agent's MCP config: Claude's through `claude mcp add-json` and `claude mcp remove`, Codex's by splicing marked tables into `config.toml` in place. `src/core/kitscan.ts` reads both files and the ownership file into memory only; nothing raw ever reaches `KitInfo`. On the secrets side, `src/core/secretmcp.ts` turns one `mcp-allow` or `mcp-revoke` act into one next file (allow entries and env sinks together), and `impactOf` in `src/core/secretfile.ts` lists a secret's reach. `KitHub` reads the store's metadata through `SecretsHub.info(null)`, so every backend tells "allowed", "not allowed" and "allowed for an older definition" without a session.

**Tech Stack:** Bun 1.4, TypeScript strict, React 19, Zustand, `bun:test`, `Bun.TOML.parse`. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-14-kit-secrets-phase-2-design.md` (read it first). It amends `docs/superpowers/specs/2026-10-14-kit-design.md` and `docs/superpowers/specs/2026-10-14-secrets-design.md`; read both, and where they differ the phase 2 file wins. The section "Calls this plan makes" below settles what the spec left open or got wrong against the code.

## Global Constraints

- Gates before calling anything done: `bun run typecheck && bun run lint && bun test && bun run build`.
- No secret value reaches a route, an event, a log line, an audit entry, an error message, an agent config file, a test's output or the transcript. No hash of a value either. The only files that hold a value are the store, a sink file and the `reveal` answer.
- Raw MCP config (the text of `~/.claude.json` and `config.toml`, the parsed entries, the ownership file) stays in `KitHub`'s memory. `KitInfo`, `KitApplyResult`, the `kit` event and every kit route carry names, states and masked previews only.
- `src/core/types.ts`, `src/core/kit.ts`, `src/core/secretfile.ts`, `src/core/secretmcp.ts` and `src/core/secretwire.ts` stay browser-safe: no Bun or node imports. `mcpHash` uses WebCrypto (`crypto.subtle.digest`), which Bun and the browser both have.
- `secrets.json`'s shape does not change in this phase. A reader parses the file, drops what it does not know, and verifies the signature over what it kept, so a new field written by an updated mini would fail every older reader. MCP sinks are found by their id (`mcp-<server>-<machine>`, `mcp-<server>-<machine>-headers`), not by a new field.
- The definition hash is SHA-256 over the canonical JSON (sorted keys, no spaces) of `{command, args, url, env: <sorted env names>, headers: <sorted header names>}` exactly as the manifest writes them, before `~` or any reference resolves. `command` and `url` are `null` when absent, `args` is `[]` when absent. Literal values, `options` and the `agents` and `machines` filters are left out.
- Claude's servers are written only with `claude mcp add-json --scope user <name> <json>` and `claude mcp remove --scope user <name>` (Task 1 confirms this through the mini's bind mount). The scan still reads `~/.claude.json` directly.
- Codex's `config.toml` is written in place (decode the new text to a temp file, check the file's mtime and size have not moved since the scan, then `cat` over it), never by rename. Every byte outside managed tables stays as it was.
- `mcp-allow` and `mcp-revoke` are gated acts and land as one signed commit each. Adopt and put back need a confirm in the view, not a passkey. Neither ever runs as part of "apply all", which never touches a foreign entry.
- New fields on `KitInfo`, `KitMachineView`, `KitCell` and `SecretMeta` are optional, so a page talking to a backend from before this plan still renders while the Mac and the mini update at different times.
- Prose (comments, docs, UI copy, commit messages) follows the unslop rules: no em dashes, sentence case, plain words.
- Every commit message ends with the line `Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8` after a blank line, and has no backticks.
- Commits: Eric commits only when he asks. Each task's last step is "commit" and runs only if Eric approved commits for this execution; otherwise leave the change staged and say so. Never push canopy. `main` deploys.
- Stage only the paths a task names. Other sessions leave unrelated edits in this tree, and dotclaude (`~/.claude`) has unrelated uncommitted edits (desk, memory) most days: never stage, stash or reset them.
- dotclaude changes are their own commits in that repo (Task 17). The Mac commits dotclaude; the mini and gpd only pull it (the mini's deploy key is read-only).
- Tests never touch `~/.claude`, `~/.claude.json`, `~/.codex`, `/opt/stacks` or `~/.config/canopy`. They run against a scratch `HOME`, with the fake `claude` from `src/core/kitfake.ts` passed as `KIT_CLAUDE`.
- A step marked `**Eric's hands:**` waits for Eric: a passkey prompt, an approval in the UI, the Mac's unlock, a commit or push approval, or a redeploy that ends every shell. Ask once, wait, then go on.
- Never read a secret value while implementing or verifying: no `cat`, `jq .` or `grep` that prints lines of a `.env`, `.credentials.json`, `~/.claude.json`, `~/.codex/config.toml`, anything under `~/.claude/mcp-env` or `/opt/stacks`. Names, counts, modes and exit codes only (`grep -c`, `test -s`, `stat`, `jq -e 'has(...)'`, `jq 'keys'`).

## Calls this plan makes

The spec is approved; these are the places where it is silent, or where the code and the live config say something it did not foresee. Each one is carried by the task named.

1. **The `mcp-allow` act needs more than `{server, hash, secrets, machines}`.** To make the sinks the service needs each env name's secret, each header's secret and each machine's home. The act is `{a: "mcp-allow", server, hash, def, env, headers, homes}`: `def` is the hashed shape (`KitMcpDef`), the service recomputes `mcpHash(def)` and refuses a mismatch, `env` and `headers` map names to secrets, and `homes` maps each machine to its home, from which the service derives `<home>/.claude/mcp-env/<server>.env` itself. No path travels in the act. gpd is refused by name (its sinks are secrets phase 3). Tasks 3, 4.
2. **Server names.** Any server name matches `^[a-z0-9][a-z0-9._-]{0,63}$` (the server part of `ALLOW`). A server with secrets needs `^[a-z][a-z0-9-]{0,31}$`, and every `mcp-<server>-<machine>-headers` id it could make must pass `SINK_ID`; `parseKit` refuses one that does not. Task 6.
3. **Per-agent options.** The live config has fields the spec's block cannot hold: executor's Claude entry carries `headersHelper` and its Codex table `bearer_token_env_var`; Codex's `wiki-memory` has `startup_timeout_sec` and `tool_timeout_sec`. Adopting without them would break executor's auth, against "unchanged in behaviour". A server takes `options: { claude: {...}, codex: {...} }`, literal strings, numbers and booleans written into that agent's entry, with a leading `~/` expanded. Options are refused on a server with secrets, so they never need to be in the hash and the spec's hash formula stands as written. Task 6.
4. **The mini's home.** canopy scans from inside a container whose `$HOME` is `/home/bun`, while `~/.claude.json` is shared with the host, where the hand-made executor helper is `/home/eric/.config/executor/mcp-headers.sh` and the dev tree is `/home/eric/dev` (mounted at that same path in the containers). A server written with `/home/bun/...` would break on the host and `~/dev` would not exist in the containers. So `~` in a server and every sink path take the machine's host home: the canopy service gets `CANOPY_HOST_HOME=${HOST_HOME:-/home/eric}`, and `canopy` and `shells` mount `${HOST_HOME}/.claude` at that host path too (beside `/home/bun/.claude`), so `/home/eric/.claude/bin/canopy-mcp-env` runs in the containers and on the host. The wrapper itself reads `$HOME/.claude/mcp-env`, which is the same folder on both sides. Tasks 12, 16.
5. **The git-ignore check on the mini.** The `secrets` service cannot run git in `~/.claude`, and a single-file mount of `.gitignore` would go stale (git replaces a file on checkout, and a single-file bind mount keeps the old inode, the same trap as `~/.claude.json`). Decision: canopy's relay on the mini runs `git -C /home/bun/.claude check-ignore -q mcp-env/<server>.env` (the existing `repoRefusal`) before it forwards an `mcp-allow`, and answers 409 with the reason when git does not ignore it; and every machine's kit scan checks the same and keeps a server with secrets out of the agent's config ("dotclaude does not ignore mcp-env/ here; pull dotclaude"). The service does not check again at each sync. This is an accident guard, not a security control: the passkey is the gate, a sink is a plaintext file by nature, and the mini's dotclaude cannot push (read-only deploy key). The Mac's writer adds `~/.claude` to the roots `repoRefusal` checks, as the spec says. Tasks 5, 10.
6. **dotclaude already ignores `mcp-env/`** (line 142 of `.gitignore`, commit 316669c, pulled on the Mac and the mini). The ignore dotclaude still needs is `.canopy-kit-mcp.json`, the ownership file at the repo root, whose `adoptedFrom` can hold an old entry with a literal value in it. It is written 0600. Task 17.
7. **The store's secret is `gh_token`**, not the spec's `github-token` (`canopy secrets list`, names only, 2026-10-14). The manifest names `${secret:gh_token}`. Task 17.
8. **Revoke takes the value off disk.** Removing a sink from the store leaves its file. For the folder canopy owns outright, each writer deletes any `*.env` or `*.headers.json` in its machine's `mcp-env` folder that no sink names any more, after every pass. Task 5.
9. **A waiting sink keeps a written server.** "An env sink not yet written (Mac locked): the server stays out." A server already written whose sink reads `waiting` (the Mac restarted and is locked; its file still holds the last value) stays in the config, so a restart does not remove and re-add it. Task 7.
10. **Adopt waits for the allowance.** Adopting a server with secrets before it is allowed would remove the working hand-made entry and write nothing. Adopt is refused (409, with the reason) until the kit's version could be written. Allow first, then adopt. Tasks 7, 12.
11. **The wrapper's source lives in canopy** at `scripts/canopy-mcp-env`, where its test runs against a scratch home; dotclaude's `bin/canopy-mcp-env` is a copy, checked with `cmp`. The scan reports a missing wrapper, and a server with secrets stays out until it is there. Tasks 8, 17.
12. **Codex http headers.** A literal or `${env:}` header on an http server is written as Codex's `http_headers`. A secret header or env on an http server reads "not supported for codex", as the spec says.
13. **`quoteDotenv` refuses a value with a quote or a newline together with a `$`.** Such a secret cannot reach an MCP server through `mcp-env` (its sink reads the writer's error). The wrapper test uses only values the writer accepts. A note in `docs/architecture.md` says so.

## Review Focus

1. The Mac is locked (after a restart) when an allowance lands, or when canopy starts with a server already written: the server not yet written reads "waiting for unlock" and stays out; one already written stays in; after the unlock, the `secrets` event republishes the kit and the next apply writes it. Tests in Task 7 (both cases) and Task 12 (republish).
2. `kit.json`'s `github` args are edited after the allowance: the cell reads "allowed for an older definition", the managed entry is planned for removal, the env sink and its file stay, and allowing again brings the server back. Test in Task 7.
3. A foreign entry holding a value in its `env` or a token in its url's query (a hand-made server before adoption): the adopt preview masks it, `KitInfo` and the apply result never hold it, and after adoption it lives only in the 0600, git-ignored ownership file. Tests in Task 7, Task 12 and Task 13.
4. Codex rewrites `config.toml` between canopy's scan and its write, or the file does not parse: the write is refused, the file is byte for byte as Codex left it, and the action reads why. Tests in Task 9 and Task 11.
5. `mcp-revoke`: the allow entries and the sinks go in one commit, the server leaves both agents' config on the next apply, and the env file is deleted on each writer's next pass, locked Mac included. Tests in Task 4 and Task 5.

Each line has its test in the task named.

---

### Task 1: Spike: `claude mcp add-json` through the mini's bind mount

No code changes. This decides how Task 9 writes Claude's servers.

**Eric's hands:** ask Eric before running Step 1 on the mini. It adds and removes two throwaway user servers in the mini's `~/.claude.json`, which every canopy shell there shares.

**Files:** none.

- [ ] **Step 1: Run the spike on the mini, inside the canopy container**

Write the script on the mini and run it there; nothing in it prints a value (the spike servers are `/bin/true` and an `example.invalid` url, and `jq` prints only those two entries).

```bash
ssh macmini-2018 'cat > /tmp/kit-spike.sh' <<'EOF'
set -eu
cd ~/dev/dev-tools/canopy
in_c() { docker compose exec -T -u bun canopy sh -c "$1"; }
ino() { stat -c '%i' "$HOME/.claude.json"; }
# the canopy image is built FROM shells, which installs claude; prove it
in_c 'command -v claude && claude --version'
echo "host inode before: $(ino)"
in_c 'echo "container inode before: $(stat -c %i /home/bun/.claude.json)"; grep -c " /home/bun/.claude.json " /proc/self/mountinfo'
in_c 'claude mcp add-json --scope user canopy-spike "{\"type\":\"stdio\",\"command\":\"/bin/true\",\"args\":[]}"'
in_c 'claude mcp add-json --scope user canopy-spike "{\"type\":\"stdio\",\"command\":\"/bin/true\",\"args\":[\"again\"]}"; echo "second add-json on the same name exited $?"'
in_c 'claude mcp add-json --scope user canopy-spike-http "{\"type\":\"http\",\"url\":\"https://example.invalid/mcp\",\"headersHelper\":\"/bin/echo {}\"}"'
jq -c '.mcpServers | {spike: .["canopy-spike"], http: .["canopy-spike-http"]}' "$HOME/.claude.json"
echo "host inode after: $(ino)"
in_c 'echo "container inode after: $(stat -c %i /home/bun/.claude.json)"; grep -c " /home/bun/.claude.json " /proc/self/mountinfo'
in_c 'claude mcp remove --scope user canopy-spike; claude mcp remove --scope user canopy-spike-http'
jq -e '.mcpServers | (has("canopy-spike") or has("canopy-spike-http")) | not' "$HOME/.claude.json"
echo "host inode at the end: $(ino)"
EOF
ssh macmini-2018 'sh /tmp/kit-spike.sh; rc=$?; rm -f /tmp/kit-spike.sh; exit $rc'
```

Expected:
- the first line prints `/home/bun/.local/bin/claude` and a version (if it prints nothing, stop: every Claude write on the mini would fail, and the plan needs a different writer there, not the fallback below);
- the four inode lines print one number, the host's and the container's the same before and after;
- both `mountinfo` counts are `1` (the file is still a bind mount);
- the `jq` line shows `spike` with `args: []` or `["again"]` and `http` with its `headersHelper`;
- the `jq -e` after the removals prints `true`.

Write down what the second `add-json` did: exit 0 and replaced, or non-zero ("already exists"). Task 9's `claudeSet` removes an existing name before adding, which is right either way; if the second call replaced silently, add a line saying so to the comment above `claudeSet`.

- [ ] **Step 2: The same on the Mac**

```bash
claude mcp add-json --scope user canopy-spike-http '{"type":"http","url":"https://example.invalid/mcp","headersHelper":"/bin/echo {}"}'
jq -c '.mcpServers["canopy-spike-http"]' ~/.claude.json
claude mcp remove --scope user canopy-spike-http
jq -e '.mcpServers | has("canopy-spike-http") | not' ~/.claude.json
```

Expected: the entry with its `headersHelper`, then `true`.

- [ ] **Step 3: If the mini's run failed**

Failure looks like a non-zero exit with `EBUSY` or `EXDEV`, a changed inode, or a `mountinfo` count of `0`. In any of those cases stop and tell Eric before anything else, since the canopy container may now be holding a detached copy of the file (`docker compose up -d --force-recreate canopy shells` on his go brings the mount back). Then Task 9 replaces `claudeSet` and `claudeRemove` with an in-place writer, the same shape as the Codex one: rescan, change `mcpServers[name]` in the parsed JSON, and write the whole text through `CODEX_WRITE` (rename it `INPLACE_WRITE`) after the stamp check, retrying once on "moved", since Claude Code rewrites the file many times a session:

```ts
/** Fallback when Task 1 fails: ~/.claude.json written in place, like config.toml. */
export async function claudeInPlace(run: Run, host: string | null, f: KitMcpFileSeen, name: string, entry: unknown | null, env?: Record<string, string>): Promise<string | null> {
  let j: Record<string, unknown>;
  try {
    j = JSON.parse(f.text) as Record<string, unknown>;
  } catch {
    return "~/.claude.json does not parse";
  }
  const servers = { ...((j["mcpServers"] as Record<string, unknown> | undefined) ?? {}) };
  if (entry === null) delete servers[name];
  else servers[name] = entry;
  return codexWrite(run, host, f.path, f.stamp, `${JSON.stringify({ ...j, mcpServers: servers }, null, 2)}\n`, env);
}
```

The rest of the plan does not change. If both runs passed, note "spike passed, add-json keeps the bind mount" in the execution log and go on.

---

### Task 2: A secret's reach, and the MCP names the store knows

**Files:**
- Modify: `src/core/types.ts` (`SecretMeta`, a new `SecretImpact`, a new `KitMcpDef` beside the kit types)
- Modify: `src/core/secretfile.ts` (new exports after `usedBy`; `metaOf`)
- Test: `src/core/secretfile.test.ts`

**Interfaces:**
- Produces:
  - `MCP_SERVER: RegExp` (`^[a-z][a-z0-9-]{0,31}$`), `HEADER_NAME: RegExp` (`^[A-Za-z][A-Za-z0-9-]{0,63}$`)
  - `mcpSinkId(server: string, machine: string, headers?: boolean): string`
  - `mcpEnvPath(home: string, server: string, headers?: boolean): string`
  - `parseMcpAllow(entry: string): { server: string; hash: string } | null`
  - `impactOf(f: SecretFile, name: string): SecretImpact`
  - `reachText(name: string, r: SecretImpact): string`
  - `SecretMeta.impact?: SecretImpact`, and `KitMcpDef` in `types.ts`

- [ ] **Step 1: Write the failing tests**

Add to `src/core/secretfile.test.ts` (extend the import from `./secretfile` with `impactOf, mcpEnvPath, mcpSinkId, parseMcpAllow, reachText`):

```ts
describe("a secret's reach", () => {
  const H = "a".repeat(64);
  function reach(): SecretFile {
    const f = fixture();
    f.secrets["gh_token"] = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mac", "mini"], allow: [`mcp:github#${H}`, "sink:dev-env", "sink:mcp-github-mac", "sink:mcp-github-mini"], value: SEALED };
    f.sinks["dev-env"] = { machine: "mini", path: "/opt/stacks/dev/.env", format: "dotenv", keys: { GH_TOKEN: "gh_token", OTHER: "cloudflare_token" }, restart: "dev" };
    f.sinks["mcp-github-mac"] = { machine: "mac", path: mcpEnvPath("/Users/e", "github"), format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" } };
    f.sinks["mcp-github-mini"] = { machine: "mini", path: mcpEnvPath("/home/eric", "github"), format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" } };
    return f;
  }

  test("ids and paths for a server's sinks", () => {
    expect(mcpSinkId("github", "mac")).toBe("mcp-github-mac");
    expect(mcpSinkId("hook", "mini", true)).toBe("mcp-hook-mini-headers");
    expect(mcpEnvPath("/home/eric/", "github")).toBe("/home/eric/.claude/mcp-env/github.env");
    expect(mcpEnvPath("/Users/e", "hook", true)).toBe("/Users/e/.claude/mcp-env/hook.headers.json");
    expect(parseMcpAllow(`mcp:github#${H}`)).toEqual({ server: "github", hash: H });
    expect(parseMcpAllow("sink:dns")).toBeNull();
  });

  test("lists every sink by machine with its keys, every server with the machines holding its env sink, and the stacks", () => {
    expect(impactOf(reach(), "gh_token")).toEqual({
      sinks: [
        { id: "dev-env", machine: "mini", path: "/opt/stacks/dev/.env", keys: ["GH_TOKEN"] },
        { id: "mcp-github-mac", machine: "mac", path: "/Users/e/.claude/mcp-env/github.env", keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
        { id: "mcp-github-mini", machine: "mini", path: "/home/eric/.claude/mcp-env/github.env", keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] },
      ],
      servers: [{ server: "github", hash: H, machines: ["mac", "mini"] }],
      stacks: ["dev"],
    });
    expect(impactOf(reach(), "cloudflare_token").servers).toEqual([]);
    expect(impactOf(reach(), "gone")).toEqual({ sinks: [], servers: [], stacks: [] });
  });

  test("metadata carries the reach; the words name sinks and servers", () => {
    const r = impactOf(reach(), "gh_token");
    expect(metaOf(reach(), "gh_token")?.impact).toEqual(r);
    expect(reachText("gh_token", r)).toBe("gh_token is used by dev-env, mcp-github-mac, mcp-github-mini and the MCP server github");
    expect(reachText("x", { sinks: [], servers: [], stacks: [] })).toBe("x is used by nothing");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/secretfile.test.ts`
Expected: FAIL, `impactOf` (and the other new names) not exported.

- [ ] **Step 3: Add the types**

In `src/core/types.ts`, inside `SecretMeta` after `usedBy`:

```ts
  /** every sink, MCP server and stack a change to it reaches (phase 2); absent from a backend before it */
  impact?: SecretImpact;
```

and after `SecretMeta`:

```ts
/** A secret's reach (phase 2 spec, "Rotation's reach"): what a rotation
 *  writes, and what still uses it when a delete is refused. */
export interface SecretImpact {
  /** each sink that maps it, with the file keys that do */
  sinks: { id: string; machine: string; path: string; keys: string[] }[];
  /** each MCP server it is allowed for, with the machines holding that server's env sink */
  servers: { server: string; hash: string; machines: string[] }[];
  /** the distinct `restart` stacks of those sinks */
  stacks: string[];
}
```

Beside the kit types (after `KitApplyResult`):

```ts
/** The part of an MCP server the definition hash covers (phase 2 spec,
 *  "The definition hash"): names only, as the manifest writes them. */
export interface KitMcpDef {
  command: string | null;
  args: string[];
  url: string | null;
  /** sorted env names */
  env: string[];
  /** sorted header names */
  headers: string[];
}
```

- [ ] **Step 4: Write the implementation**

In `src/core/secretfile.ts`, extend the type import to `import type { SecretImpact, SecretMeta, SecretSinkFormat } from "./types";`, add after the other regexes:

```ts
/** a kit MCP server that may hold secrets: its sink ids must pass SINK_ID */
export const MCP_SERVER = /^[a-z][a-z0-9-]{0,31}$/;
/** an http header a secret can fill; also a one-segment JSON_PATH */
export const HEADER_NAME = /^[A-Za-z][A-Za-z0-9-]{0,63}$/;
const MCP_ALLOW = /^mcp:([a-z0-9][a-z0-9._-]{0,63})#([0-9a-f]{64})$/;
```

and after `usedBy`:

```ts
/** the sink that carries one MCP server's env, or its headers, on one machine */
export const mcpSinkId = (server: string, machine: string, headers = false): string => `mcp-${server}-${machine}${headers ? "-headers" : ""}`;

/** where that sink lives under a machine's home */
export const mcpEnvPath = (home: string, server: string, headers = false): string =>
  `${home.replace(/\/+$/, "")}/.claude/mcp-env/${server}${headers ? ".headers.json" : ".env"}`;

export function parseMcpAllow(entry: string): { server: string; hash: string } | null {
  const m = MCP_ALLOW.exec(entry);
  return m ? { server: m[1] ?? "", hash: m[2] ?? "" } : null;
}

const isServerSink = (id: string, server: string, machine: string): boolean => id === mcpSinkId(server, machine) || id === mcpSinkId(server, machine, true);

/** Everything a change to `name` reaches: its sinks, the MCP servers its
 *  allowlist names with the machines holding their env sinks, and the
 *  stacks those sinks restart. */
export function impactOf(f: SecretFile, name: string): SecretImpact {
  const sinks = usedBy(f, name).flatMap((id) => {
    const s = f.sinks[id];
    if (!s) return [];
    const keys = Object.entries(s.keys).filter(([, n]) => n === name).map(([k]) => k).sort();
    return [{ id, machine: s.machine, path: s.path, keys }];
  });
  const servers = (f.secrets[name]?.allow ?? []).flatMap((a) => {
    const p = parseMcpAllow(a);
    if (!p) return [];
    const machines = [...new Set(Object.entries(f.sinks).filter(([id, s]) => isServerSink(id, p.server, s.machine)).map(([, s]) => s.machine))].sort();
    return [{ server: p.server, hash: p.hash, machines }];
  });
  const stacks = [...new Set(sinks.flatMap((s) => (f.sinks[s.id]?.restart ? [f.sinks[s.id]?.restart ?? ""] : [])))].sort();
  return { sinks, servers, stacks };
}

/** the reach in one line, for a refused delete */
export function reachText(name: string, r: SecretImpact): string {
  const parts = [...r.sinks.map((s) => s.id), ...r.servers.map((s) => `the MCP server ${s.server}`)];
  if (parts.length === 0) return `${name} is used by nothing`;
  const last = parts.pop() ?? "";
  return `${name} is used by ${parts.length ? `${parts.join(", ")} and ${last}` : last}`;
}
```

In `metaOf`, add `impact: impactOf(f, name)` to the returned object (after `usedBy: usedBy(f, name)`).

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/secretfile.test.ts && bun run typecheck && bun test`
Expected: PASS. The existing "metadata carries no value" test still passes. No test compares a whole `SecretMeta` with `toEqual` (checked: `src/cli/secrets.test.ts` and `ui/src/secrets.test.ts` build literals, which may leave the optional `impact` out), so the full suite stays green.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/secretfile.ts src/core/secretfile.test.ts
git commit -m "feat(secrets): a secret's reach, and the ids and paths of MCP env sinks

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 3: The definition hash, and an allowance as one next file

**Files:**
- Create: `src/core/secretmcp.ts`
- Test: `src/core/secretmcp.test.ts`
- Modify: `src/core/kit.ts` (add `mcpHash`)
- Test: `src/core/kit.test.ts`

**Interfaces:**
- Consumes: `mcpSinkId`, `mcpEnvPath`, `parseMcpAllow`, `SINK_ID`, `canonical` from `src/core/secretfile.ts`; `KitMcpDef` from Task 2.
- Produces:
  - `mcpHash(def: KitMcpDef): Promise<string>` in `src/core/kit.ts` (64 hex characters)
  - `interface McpAllowance { server: string; hash: string; env: Record<string, string>; headers: Record<string, string>; homes: Record<string, string> }`
  - `mcpAllowFile(f: SecretFile, x: McpAllowance): { file: SecretFile } | { error: string }`
  - `mcpRevokeFile(f: SecretFile, server: string): { file: SecretFile } | { error: string }`

- [ ] **Step 1: Write the failing hash test**

Add to `src/core/kit.test.ts` (extend the import from `./kit` with `mcpHash`):

```ts
describe("mcpHash", () => {
  const DEF = { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] };
  test("is SHA-256 over the canonical JSON, the same for any key order", async () => {
    const text = '{"args":["-y","@modelcontextprotocol/server-github"],"command":"bunx","env":["GITHUB_PERSONAL_ACCESS_TOKEN"],"headers":[],"url":null}';
    const want = new Bun.CryptoHasher("sha256").update(text).digest("hex");
    expect(await mcpHash(DEF)).toBe(want);
    expect(await mcpHash({ headers: [], env: DEF.env, url: null, args: DEF.args, command: "bunx" })).toBe(want);
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
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test src/core/kit.test.ts`
Expected: FAIL, `mcpHash` is not exported.

- [ ] **Step 3: Add `mcpHash`**

In `src/core/kit.ts`, add `KitMcpDef` to the type import from `./types`, add `import { canonical } from "./secretfile";`, and after `expandHome`:

```ts
/** The definition hash (phase 2 spec): SHA-256 over the canonical JSON of
 *  the names-only definition, so the same on every machine. WebCrypto, so
 *  the page and the server compute it alike. */
export async function mcpHash(def: KitMcpDef): Promise<string> {
  const bytes = new TextEncoder().encode(canonical({ command: def.command, args: def.args, url: def.url, env: def.env, headers: def.headers }));
  const d = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  return [...d].map((b) => b.toString(16).padStart(2, "0")).join("");
}
```

Run: `bun test src/core/kit.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the failing allowance tests**

Create `src/core/secretmcp.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { AGE_HEAD, emptyFile, fileProblems, type SecretFile } from "./secretfile";
import { mcpAllowFile, mcpRevokeFile, type McpAllowance } from "./secretmcp";

const R = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";
const SEALED = `${AGE_HEAD}\nnot really sealed\n-----END AGE ENCRYPTED FILE-----\n`;
const STAMP = "2026-10-14T12:00:00.000Z";
const H1 = "1".repeat(64);
const H2 = "2".repeat(64);

function base(): SecretFile {
  const f = emptyFile({ mini: R, mac: R, breakglass: R });
  const e = { description: "", tags: [], created: STAMP, rotated: STAMP, to: ["breakglass", "mini"], value: SEALED };
  f.secrets["gh_token"] = { ...e, allow: [] };
  f.secrets["hook_key"] = { ...e, allow: [] };
  f.secrets["cf_token"] = { ...e, allow: ["sink:dns"] };
  f.sinks["dns"] = { machine: "mini", path: "/opt/stacks/dns/.env", format: "dotenv", keys: { CF_TOKEN: "cf_token" } };
  return f;
}
const github = (over: Partial<McpAllowance> = {}): McpAllowance => ({
  server: "github", hash: H1, env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, homes: { mac: "/Users/e", mini: "/home/eric" }, ...over,
});
const file = (r: { file: SecretFile } | { error: string }): SecretFile => {
  if ("error" in r) throw new Error(r.error);
  return r.file;
};

describe("mcpAllowFile", () => {
  test("adds the allow entry and one env sink per machine, tagged, in one file", () => {
    const f = file(mcpAllowFile(base(), github()));
    expect(f.secrets["gh_token"]?.allow).toEqual([`mcp:github#${H1}`, "sink:mcp-github-mac", "sink:mcp-github-mini"]);
    expect(f.sinks["mcp-github-mac"]).toEqual({ machine: "mac", path: "/Users/e/.claude/mcp-env/github.env", format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" } });
    expect(f.sinks["mcp-github-mini"]?.path).toBe("/home/eric/.claude/mcp-env/github.env");
    expect(f.sinks["dns"]).toEqual(base().sinks["dns"]);
    expect(f.secrets["cf_token"]?.allow).toEqual(["sink:dns"]);
    expect(fileProblems(f).filter((p) => !p.includes("sealed to"))).toEqual([]);
  });

  test("headers get a json sink of their own", () => {
    const f = file(mcpAllowFile(base(), { server: "hook", hash: H1, env: {}, headers: { Authorization: "hook_key" }, homes: { mini: "/home/eric" } }));
    expect(f.sinks["mcp-hook-mini-headers"]).toEqual({ machine: "mini", path: "/home/eric/.claude/mcp-env/hook.headers.json", format: "json", keys: { Authorization: "hook_key" } });
    expect(f.sinks["mcp-hook-mini"]).toBeUndefined();
  });

  test("allowing again replaces the old entry and drops a machine taken out", () => {
    const once = file(mcpAllowFile(base(), github()));
    const twice = file(mcpAllowFile(once, github({ hash: H2, homes: { mini: "/home/eric" } })));
    expect(twice.secrets["gh_token"]?.allow).toEqual([`mcp:github#${H2}`, "sink:mcp-github-mini"]);
    expect(twice.sinks["mcp-github-mac"]).toBeUndefined();
  });

  test("refuses gpd, a secret the store lacks, no secrets at all, and a path another sink writes", () => {
    const err = (r: { file: SecretFile } | { error: string }) => ("error" in r ? r.error : "");
    expect(err(mcpAllowFile(base(), github({ homes: { gpd: "/home/eric" } })))).toContain("phase 3");
    expect(err(mcpAllowFile(base(), github({ env: { X: "gone" } })))).toContain("gone");
    expect(err(mcpAllowFile(base(), github({ env: {} })))).toContain("names no secret");
    const f = base();
    f.sinks["other"] = { machine: "mini", path: "/home/eric/.claude/mcp-env/github.env", format: "dotenv", keys: { A: "cf_token" } };
    expect(err(mcpAllowFile(f, github()))).toContain("sink other already writes");
  });
});

describe("mcpRevokeFile", () => {
  test("takes out the allow entries and the sinks, and leaves the rest as it was", () => {
    const allowed = file(mcpAllowFile(base(), github()));
    const back = file(mcpRevokeFile(allowed, "github"));
    expect(back.sinks).toEqual(base().sinks);
    expect(back.secrets).toEqual(base().secrets);
  });
  test("a server with no allowance is an error", () => {
    expect(mcpRevokeFile(base(), "github")).toEqual({ error: "github has no allowance" });
  });
});
```

- [ ] **Step 5: Run them to see them fail**

Run: `bun test src/core/secretmcp.test.ts`
Expected: FAIL, cannot find module `./secretmcp`.

- [ ] **Step 6: Write `src/core/secretmcp.ts`**

```ts
/**
 * One MCP server's allowance as a change to secrets.json (phase 2 spec,
 * "Allowing a server its secrets"): the `mcp:` allow entries and the env
 * and headers sinks, built in one pass so the service lands them in one
 * commit. Pure and browser-safe; no value passes through here.
 */

import { mcpEnvPath, mcpSinkId, parseMcpAllow, SINK_ID, type SecretFile, type SinkDef } from "./secretfile";

export interface McpAllowance {
  server: string;
  hash: string;
  /** env name to secret name */
  env: Record<string, string>;
  /** header name to secret name */
  headers: Record<string, string>;
  /** machine to its home, where the sink files go */
  homes: Record<string, string>;
}

type Result = { file: SecretFile } | { error: string };

const ownSink = (id: string, server: string, machine: string): boolean => id === mcpSinkId(server, machine) || id === mcpSinkId(server, machine, true);

/** Each secret's allow list with this server's `mcp:` entry set (or taken
 *  out when `hash` is null) and the `sink:` tags of the touched sinks
 *  following what they map. Every other entry stays. */
function retag(secrets: SecretFile["secrets"], sinks: Record<string, SinkDef>, touched: readonly string[], server: string, hash: string | null, uses: ReadonlySet<string>): SecretFile["secrets"] {
  return Object.fromEntries(
    Object.entries(secrets).map(([n, e]) => {
      const kept = e.allow.filter((a) => !(a.startsWith("sink:") && touched.includes(a.slice(5))) && parseMcpAllow(a)?.server !== server);
      const tags = touched.filter((id) => Object.values(sinks[id]?.keys ?? {}).includes(n)).map((id) => `sink:${id}`);
      const mcp = hash !== null && uses.has(n) ? [`mcp:${server}#${hash}`] : [];
      return [n, { ...e, allow: [...new Set([...kept, ...tags, ...mcp])].sort() }];
    }),
  );
}

export function mcpAllowFile(f: SecretFile, x: McpAllowance): Result {
  const names = [...Object.values(x.env), ...Object.values(x.headers)];
  if (names.length === 0) return { error: `${x.server} names no secret; it needs no allowance` };
  const gone = names.find((n) => !f.secrets[n]);
  if (gone) return { error: `${x.server} names ${gone}, which the store does not hold` };
  const machines = Object.keys(x.homes).sort();
  if (machines.length === 0) return { error: `${x.server} is placed on no machine` };
  if (machines.includes("gpd")) return { error: "gpd's sinks are secrets phase 3; allow the server without gpd" };
  if (machines.includes("breakglass")) return { error: "breakglass is a key, not a machine with sinks" };
  const sinks: Record<string, SinkDef> = Object.fromEntries(Object.entries(f.sinks).filter(([id, s]) => !ownSink(id, x.server, s.machine)));
  const touched = new Set(Object.keys(f.sinks).filter((id) => !(id in sinks)));
  for (const m of machines) {
    for (const [headers, keys] of [[false, x.env], [true, x.headers]] as const) {
      if (Object.keys(keys).length === 0) continue;
      const id = mcpSinkId(x.server, m, headers);
      if (!SINK_ID.test(id)) return { error: `the sink id ${id} is too long; shorten the server's name` };
      const path = mcpEnvPath(x.homes[m] ?? "", x.server, headers);
      const clash = Object.entries(sinks).find(([, s]) => s.machine === m && s.path === path);
      if (clash) return { error: `sink ${clash[0]} already writes ${path} on ${m}` };
      sinks[id] = { machine: m, path, format: headers ? "json" : "dotenv", keys: { ...keys } };
      touched.add(id);
    }
  }
  return { file: { ...f, sinks, secrets: retag(f.secrets, sinks, [...touched], x.server, x.hash, new Set(names)) } };
}

export function mcpRevokeFile(f: SecretFile, server: string): Result {
  const sinks: Record<string, SinkDef> = Object.fromEntries(Object.entries(f.sinks).filter(([id, s]) => !ownSink(id, server, s.machine)));
  const touched = Object.keys(f.sinks).filter((id) => !(id in sinks));
  const allowed = Object.values(f.secrets).some((e) => e.allow.some((a) => parseMcpAllow(a)?.server === server));
  if (!allowed && touched.length === 0) return { error: `${server} has no allowance` };
  return { file: { ...f, sinks, secrets: retag(f.secrets, sinks, touched, server, null, new Set()) } };
}
```

- [ ] **Step 7: Run the tests**

Run: `bun test src/core/secretmcp.test.ts src/core/kit.test.ts && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/kit.ts src/core/kit.test.ts src/core/secretmcp.ts src/core/secretmcp.test.ts
git commit -m "feat(secrets): the MCP definition hash, and an allowance as one next file

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 4: The mcp-allow and mcp-revoke acts

**Files:**
- Modify: `src/core/secretwire.ts` (the union, `ACT_KINDS`, `parseAct`)
- Modify: `src/core/secretwire.samples.ts`
- Modify: `src/secrets/service.ts` (`subject`, `run`, `delete`)
- Test: `src/secrets/service.test.ts`

**Interfaces:**
- Consumes: `mcpHash` (Task 3), `mcpAllowFile`, `mcpRevokeFile` (Task 3), `impactOf`, `reachText`, `mcpEnvPath`, `MCP_SERVER`, `HEADER_NAME` (Task 2).
- Produces, in `SecretAct`:
  - `{ a: "mcp-allow"; server: string; hash: string; def: KitMcpDef; env: Record<string, string>; headers: Record<string, string>; homes: Record<string, string> }`
  - `{ a: "mcp-revoke"; server: string }`
  - the commit messages `secrets: allow MCP server <server>` and `secrets: revoke MCP server <server>`

- [ ] **Step 1: Add the samples**

In `src/core/secretwire.samples.ts`, add to `SAMPLES` (the wire test then checks that both parse and that the bad ones are refused, and the service test walks both without a session):

```ts
  "mcp-allow": {
    good: {
      a: "mcp-allow", server: "github", hash: "a".repeat(64),
      def: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] },
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, homes: { mac: "/Users/ericbaruch", mini: "/home/eric" },
    },
    bad: { a: "mcp-allow", server: "github", hash: "a".repeat(64), def: { command: "bunx", args: [], url: null, env: [], headers: [] }, env: { NOT_IN_DEF: "gh_token" }, headers: {}, homes: { mini: "/home/eric" } },
  },
  "mcp-revoke": { good: { a: "mcp-revoke", server: "github" }, bad: { a: "mcp-revoke", server: "Git Hub" } },
```

- [ ] **Step 2: Write the failing service tests**

In `src/secrets/service.test.ts`, add `mcpHash` to the imports (`import { mcpHash } from "../core/kit";`), change the service's `sinkRoots: [stacks]` in `beforeEach` to `sinkRoots: [stacks, join(dir, "home", ".claude", "mcp-env")]`, and add:

```ts
describe("MCP allowances", () => {
  const DEF = { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] };
  const home = () => join(dir, "home");
  const envFile = () => join(home(), ".claude", "mcp-env", "github.env");
  const allow = async (over: Partial<Extract<SecretAct, { a: "mcp-allow" }>> = {}): Promise<SecretsReply> =>
    act({ a: "mcp-allow", server: "github", hash: await mcpHash(DEF), def: DEF, env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, homes: { mini: home(), mac: "/Users/e" }, ...over });

  beforeEach(async () => {
    await mkdir(join(home(), ".claude", "mcp-env"), { recursive: true });
    await add("gh_token", V);
    await ok({ a: "machine-key", machine: "mac", recipient: (await newIdentity()).recipient });
    store.commits = [];
  });

  test("one commit adds the allow entry and both machines' sinks, and the mini's file is written", async () => {
    expect((await allow()).ok).toBe(true);
    expect(store.commits).toEqual(["secrets: allow MCP server github"]);
    const e = store.file.secrets["gh_token"];
    expect(e?.allow).toEqual([`mcp:github#${await mcpHash(DEF)}`, "sink:mcp-github-mac", "sink:mcp-github-mini"]);
    expect(e?.to).toEqual(["breakglass", "mac", "mini"]);
    expect(store.file.sinks["mcp-github-mac"]?.path).toBe("/Users/e/.claude/mcp-env/github.env");
    expect(await readFile(envFile(), "utf8")).toContain(`GITHUB_PERSONAL_ACCESS_TOKEN=${V}`);
    expect((await info()).sinks.find((s) => s.id === "mcp-github-mini")?.state).toEqual({ GITHUB_PERSONAL_ACCESS_TOKEN: "same" });
  });

  test("a hash that does not match its definition, gpd, and a home outside the roots are refused, with no commit", async () => {
    expect(await allow({ hash: "b".repeat(64) })).toEqual({ ok: false, error: "the hash does not match the definition of github that came with it" });
    const gpd = await allow({ homes: { gpd: "/home/eric" } });
    expect(gpd.ok ? "" : gpd.error).toContain("phase 3");
    const out = await allow({ homes: { mini: "/elsewhere" } });
    expect(out.ok ? "" : out.error).toContain("outside");
    expect(store.commits).toEqual([]);
  });

  test("revoke takes the allow entry and the sinks out in one commit; delete names the server until then (review focus 5)", async () => {
    await allow();
    const refused = await act({ a: "delete", name: "gh_token" });
    expect(refused.ok ? "" : refused.error).toBe("gh_token is used by mcp-github-mac, mcp-github-mini and the MCP server github; take it out of those first");
    store.commits = [];
    await ok({ a: "mcp-revoke", server: "github" });
    expect(store.commits).toEqual(["secrets: revoke MCP server github"]);
    expect(store.file.sinks).toEqual({});
    expect(store.file.secrets["gh_token"]?.allow).toEqual([]);
    await ok({ a: "delete", name: "gh_token" });
  });
});
```

The existing test "an existing name is refused; delete is refused while a sink uses it" checks `toContain("used by dns")`, which the new wording keeps.

- [ ] **Step 3: Run them to see them fail**

Run: `bun test src/secrets/service.test.ts src/core/secretwire.test.ts`
Expected: FAIL. The wire test reports `mcp-allow` as an unknown act, and the service tests get `unknown act mcp-allow`.

- [ ] **Step 4: Extend the wire**

In `src/core/secretwire.ts`:

1. Extend the imports to `import { AGE_HEAD, AGE_RECIPIENT, ALLOW, DOTENV_KEY, HEADER_NAME, JSON_PATH, MACHINE, MCP_SERVER, SECRET_NAME, SINK_ID } from "./secretfile";` and `import type { KitMcpDef, SecretProposalIn, SecretSinkFormat } from "./types";`.
2. Add to the `SecretAct` union, before `machine-key`:

```ts
  /** one server's allowance for every machine, with its env and headers sinks (phase 2) */
  | { a: "mcp-allow"; server: string; hash: string; def: KitMcpDef; env: Record<string, string>; headers: Record<string, string>; homes: Record<string, string> }
  | { a: "mcp-revoke"; server: string }
```

3. Add `"mcp-allow", "mcp-revoke"` to `ACT_KINDS` after `"sink-remove"`.
4. Add these helpers above `parseAct`:

```ts
const HASH = /^[0-9a-f]{64}$/;

/** the hashed part of a server, names sorted as the kit hashes them */
function mcpDef(v: unknown): KitMcpDef | null {
  if (!isObj(v)) return null;
  const { command, args, url, env, headers } = v;
  const names = (x: unknown, re: RegExp): string[] | null => (Array.isArray(x) && x.length <= 64 && x.every((s) => str(s, re)) ? x.map(String).sort() : null);
  const argList = Array.isArray(args) && args.length <= 64 && args.every((s) => typeof s === "string" && s.length <= LIMITS.field) ? args.map(String) : null;
  const e = names(env, DOTENV_KEY);
  const h = names(headers, HEADER_NAME);
  if (!argList || !e || !h) return null;
  const cmd = command === null ? null : typeof command === "string" && command !== "" && command.length <= LIMITS.field ? command : undefined;
  const link = url === null ? null : typeof url === "string" && /^https?:\/\//.test(url) && url.length <= 2048 ? url : undefined;
  if (cmd === undefined || link === undefined || (cmd === null) === (link === null)) return null;
  return { command: cmd, args: argList, url: link, env: e, headers: h };
}

/** names to secrets, every name one the definition holds */
function nameMap(v: unknown, re: RegExp, within: readonly string[]): Record<string, string> | null {
  if (!isObj(v) || Object.keys(v).length > 64) return null;
  const out: Record<string, string> = {};
  for (const [k, n] of Object.entries(v)) {
    if (!re.test(k) || !within.includes(k) || !str(n, SECRET_NAME)) return null;
    out[k] = n;
  }
  return out;
}
```

5. In `parseAct`, add `server, hash, def, env, headers, homes` to the destructure at the top, and these cases before `case "machine-key":`:

```ts
    case "mcp-allow": {
      const d = mcpDef(def);
      if (!str(server, MCP_SERVER) || !str(hash, HASH) || !d) return bad("a server, a hash and the definition it covers");
      const e = nameMap(env, DOTENV_KEY, d.env);
      const h = nameMap(headers, HEADER_NAME, d.headers);
      if (!e || !h || Object.keys(e).length + Object.keys(h).length === 0) return bad("env and headers mapping the definition's names to secrets");
      if (!isObj(homes) || Object.keys(homes).length === 0 || Object.keys(homes).length > 8) return bad("the home of each machine");
      const hs: Record<string, string> = {};
      for (const [m, p] of Object.entries(homes)) {
        if (!str(m, MACHINE) || !absPath(p)) return bad(`the home of ${m}`);
        hs[m] = p;
      }
      return { a, server, hash, def: d, env: e, headers: h, homes: hs };
    }
    case "mcp-revoke":
      return str(server, MCP_SERVER) ? { a, server } : bad("a server name");
```

- [ ] **Step 5: Teach the service both acts**

In `src/secrets/service.ts`:

1. Imports: add `impactOf, mcpEnvPath, reachText` to the `../core/secretfile` import (drop `usedBy` if nothing else uses it, so lint stays clean), and add `import { mcpHash } from "../core/kit";` and `import { mcpAllowFile, mcpRevokeFile } from "../core/secretmcp";`.
2. In `subject()`, add before `case "machine-key":`:

```ts
    case "mcp-allow":
    case "mcp-revoke":
      return act.server;
```

3. Replace the body of `case "delete":` with:

```ts
      case "delete": {
        if (!f.secrets[act.name]) return fail(`no secret named ${act.name}`);
        const reach = impactOf(f, act.name);
        if (reach.sinks.length > 0 || reach.servers.length > 0) return fail(`${reachText(act.name, reach)}; take it out of those first`);
        const secrets = Object.fromEntries(Object.entries(f.secrets).filter(([n]) => n !== act.name));
        return this.change({ ...f, secrets }, `secrets: delete ${act.name}`);
      }
```

4. Add to `run()` before `case "sink-write":`:

```ts
      case "mcp-allow": {
        // the hash the allow entry carries must be the one the human saw for this definition
        if ((await mcpHash(act.def)) !== act.hash) return fail(`the hash does not match the definition of ${act.server} that came with it`);
        const own = act.homes[this.d.machine];
        if (own !== undefined) {
          const refused = this.rootRefusal(mcpEnvPath(own, act.server));
          if (refused) return fail(refused);
        }
        const next = mcpAllowFile(f, act);
        if ("error" in next) return fail(next.error);
        return this.change(next.file, `secrets: allow MCP server ${act.server}`);
      }
      case "mcp-revoke": {
        const next = mcpRevokeFile(f, act.server);
        if ("error" in next) return fail(next.error);
        return this.change(next.file, `secrets: revoke MCP server ${act.server}`);
      }
```

`change()` reseals every value whose machines changed, so `gh_token` gains the Mac as a recipient in the same commit (the phase 1 recipient rule), and syncs the mini's sinks.

- [ ] **Step 6: Run the tests**

Run: `bun test src/secrets/service.test.ts src/core/secretwire.test.ts src/secrets/leak.test.ts && bun run typecheck && bun run lint`
Expected: PASS, including "every act kind is refused without a session" over the two new kinds.

- [ ] **Step 7: Commit**

```bash
git add src/core/secretwire.ts src/core/secretwire.samples.ts src/secrets/service.ts src/secrets/service.test.ts
git commit -m "feat(secrets): mcp-allow and mcp-revoke land allow entries and env sinks in one commit

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 5: Sink writers make the mcp-env folder, prune it, and check dotclaude's ignore

**Files:**
- Modify: `src/core/sinks.ts` (`writeSinkFile`, a new `mcpIgnoreRefusal`)
- Modify: `src/core/sinksync.ts` (new `pruneMcpEnv`, `mcpEnvKeep`)
- Modify: `src/secrets/service.ts` (`syncSinks`)
- Modify: `src/core/secretlocal.ts` (`ReaderOptions.mcpEnvDir`, `syncSinks`)
- Modify: `src/server/secrets.ts` (`SecretsHubDeps.mcpIgnored`, `writerRoute`, `createSecretsHub`)
- Create: `src/core/sinksync.test.ts` (there is none yet)
- Test: `src/core/sinks.test.ts`, `src/secrets/service.test.ts`, `src/core/secretlocal.test.ts`, `src/server/secrets.test.ts`

**Interfaces:**
- Consumes: `mcpEnvPath` (Task 2), the `mcp-allow` act (Task 4).
- Produces:
  - `MCP_ENV_DIR = "mcp-env"` and `mcpIgnoreRefusal(home: string, server: string): Promise<string | null>` in `src/core/sinks.ts`
  - `pruneMcpEnv(dir: string, keep: readonly string[]): Promise<string[]>` and `mcpEnvKeep(f: SecretFile, machine: string, dir: string): string[]` in `src/core/sinksync.ts`
  - `ReaderOptions.mcpEnvDir?: string`
  - `SecretsHubDeps.mcpIgnored?: (server: string) => Promise<string | null>`

- [ ] **Step 1: Write the failing writer and prune tests**

Add to `src/core/sinks.test.ts` (import `mcpIgnoreRefusal` and `writeSinkFile` from `./sinks`, `exec` from `./exec`, and `statSync`, `mkdtempSync`, `mkdirSync`, `writeFileSync`, `rmSync` from `node:fs` as needed):

```ts
describe("the mcp-env folder", () => {
  test("writeSinkFile makes a missing mcp-env folder 0700, and only that folder", async () => {
    const h = mkdtempSync(join(tmpdir(), "mcpenv-"));
    try {
      mkdirSync(join(h, ".claude"));
      await writeSinkFile(join(h, ".claude", "mcp-env", "github.env"), "A=b\n");
      expect(statSync(join(h, ".claude", "mcp-env")).mode & 0o777).toBe(0o700);
      expect(statSync(join(h, ".claude", "mcp-env", "github.env")).mode & 0o777).toBe(0o600);
      await expect(writeSinkFile(join(h, "other", "x.env"), "A=b\n")).rejects.toThrow();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });

  test("mcpIgnoreRefusal passes only when dotclaude's git ignores mcp-env/", async () => {
    const h = mkdtempSync(join(tmpdir(), "mcpignore-"));
    try {
      await exec(["git", "init", "-q", join(h, ".claude")]);
      expect(await mcpIgnoreRefusal(h, "github")).toContain("git does not ignore it");
      writeFileSync(join(h, ".claude", ".gitignore"), "mcp-env/\n");
      expect(await mcpIgnoreRefusal(h, "github")).toBeNull();
    } finally {
      rmSync(h, { recursive: true, force: true });
    }
  });
});
```

Create `src/core/sinksync.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyFile } from "./secretfile";
import { mcpEnvKeep, pruneMcpEnv } from "./sinksync";

describe("pruneMcpEnv", () => {
  test("deletes the env and headers files no sink names, and nothing else", async () => {
    const d = mkdtempSync(join(tmpdir(), "prune-"));
    try {
      for (const n of ["github.env", "old.env", "old.headers.json", "notes.txt", "Mixed.env"]) writeFileSync(join(d, n), "x");
      const f = emptyFile({});
      f.sinks["mcp-github-mac"] = { machine: "mac", path: join(d, "github.env"), format: "dotenv", keys: {} };
      f.sinks["mcp-github-mini"] = { machine: "mini", path: join(d, "old.env"), format: "dotenv", keys: {} };
      const keep = mcpEnvKeep(f, "mac", d);
      expect(keep).toEqual([join(d, "github.env")]);
      expect((await pruneMcpEnv(d, keep)).sort()).toEqual(["old.env", "old.headers.json"]);
      expect(readdirSync(d).sort()).toEqual(["Mixed.env", "github.env", "notes.txt"]);
      expect(await pruneMcpEnv(join(d, "missing"), [])).toEqual([]);
    } finally {
      rmSync(d, { recursive: true, force: true });
    }
  });
});
```

`src/core/sinks.test.ts` already imports from `node:fs`, `node:os` and `node:path`; add only the names it lacks.

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/sinks.test.ts src/core/sinksync.test.ts`
Expected: FAIL. The folder test throws `ENOENT` and the new names are not exported.

- [ ] **Step 3: Make the folder, and check the ignore**

In `src/core/sinks.ts`, add `mkdir` to the `node:fs/promises` import, import `mcpEnvPath` from `./secretfile`, and add above `writeSinkFile`:

```ts
/** the one folder a sink write makes when it is missing: ~/.claude/mcp-env */
export const MCP_ENV_DIR = "mcp-env";

/** a missing mcp-env folder, made 0700 and owned like its parent (~/.claude) */
async function makeMcpEnv(dir: string): Promise<void> {
  const parent = await stat(dirname(dir));
  await mkdir(dir, { mode: 0o700 });
  await chmod(dir, 0o700);
  if (process.getuid?.() === 0) await chown(dir, parent.uid, parent.gid);
}
```

and in `writeSinkFile`, replace `const d = await stat(dir);` with:

```ts
    let d = await stat(dir).catch((e: unknown) => (code(e) === "ENOENT" && basename(dir) === MCP_ENV_DIR ? null : Promise.reject(e)));
    if (!d) {
      await makeMcpEnv(dir);
      d = await stat(dir);
    }
```

Add after `repoRefusal`:

```ts
/** Whether dotclaude ignores a server's env file on this machine: the
 *  accident guard before an mcp-allow (phase 2 plan, call 5). */
export const mcpIgnoreRefusal = (home: string, server: string): Promise<string | null> =>
  repoRefusal(mcpEnvPath(home, server), [join(home, ".claude")]);
```

- [ ] **Step 4: Add the prune**

In `src/core/sinksync.ts`, add `import { readdir, rm } from "node:fs/promises";` and `import { dirname, join } from "node:path";`, and append:

```ts
/** only names the kit's sinks could have: <server>.env and <server>.headers.json */
const MCP_ENV_FILE = /^[a-z][a-z0-9-]{0,31}\.(env|headers\.json)$/;

/** the sink paths on `machine` inside `dir`, which a prune keeps */
export const mcpEnvKeep = (f: SecretFile, machine: string, dir: string): string[] =>
  Object.values(f.sinks).filter((s) => s.machine === machine && dirname(s.path) === dir).map((s) => s.path);

/** Delete the files in a machine's mcp-env folder that no sink names any
 *  more, so a revoke takes the value off disk (phase 2 plan, call 8).
 *  Returns the names deleted; a missing folder deletes nothing. */
export async function pruneMcpEnv(dir: string, keep: readonly string[]): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return [];
  }
  const gone = names.filter((n) => MCP_ENV_FILE.test(n) && !keep.includes(join(dir, n)));
  for (const n of gone) await rm(join(dir, n), { force: true });
  return gone;
}
```

Run: `bun test src/core/sinks.test.ts src/core/sinksync.test.ts`
Expected: PASS.

- [ ] **Step 5: Write the failing prune tests for both writers**

In `src/secrets/service.test.ts`, inside `describe("MCP allowances")`, add:

```ts
  test("after a revoke the next sync deletes the env file (review focus 5)", async () => {
    await allow();
    expect(await readFile(envFile(), "utf8")).toContain("GITHUB_PERSONAL_ACCESS_TOKEN");
    await ok({ a: "mcp-revoke", server: "github" });
    await expect(readFile(envFile(), "utf8")).rejects.toThrow();
    expect((await audit.last(5)).some((e) => e.action === "sink-prune" && e.detail?.endsWith("github.env"))).toBe(true);
  });
```

In `src/core/secretlocal.test.ts`, give the `reader` helper a third parameter `over: Partial<ReaderOptions> = {}` spread last into the `SecretsReader` options (import `type ReaderOptions` from `./secretlocal`), and add inside `describe("pulling")`:

```ts
  test("a locked Mac still prunes an env file no sink names (review focus 5)", async () => {
    await publish(await base(), signer);
    const mcpDir = join(dir, "mcp-env");
    await mkdir(mcpDir, { recursive: true });
    await writeFile(join(mcpDir, "github.env"), "GITHUB_PERSONAL_ACCESS_TOKEN=x\n");
    // no key was made here, so the reader is locked and every sink of its own would read waiting
    const r = await reader([], [], { mcpEnvDir: mcpDir });
    await r.syncSinks();
    await expect(readFile(join(mcpDir, "github.env"), "utf8")).rejects.toThrow();
  });
```

- [ ] **Step 6: Prune in both writers**

In `src/secrets/service.ts`, import `mcpEnvKeep, pruneMcpEnv` from `../core/sinksync`, and at the end of `syncSinks()`, before `this.sinkState = state;`:

```ts
    // the mcp-env folders this machine owns outright: an env file no sink names is a revoked value
    for (const root of this.d.sinkRoots) {
      const d = root.replace(/\/+$/, "");
      if (!d.endsWith("/.claude/mcp-env")) continue;
      for (const n of await pruneMcpEnv(d, mcpEnvKeep(f, this.d.machine, d))) await this.d.audit.add({ action: "sink-prune", name: null, ok: true, by: null, detail: `${d}/${n}` });
    }
```

In `src/core/secretlocal.ts`, import `mcpEnvKeep, pruneMcpEnv` from `./sinksync`, add to `ReaderOptions`:

```ts
  /** this machine's ~/.claude/mcp-env, pruned after each pass even while locked */
  mcpEnvDir?: string;
```

and at the end of `syncSinks()`, after `this.sinkState = state;`:

```ts
    const d = this.o.mcpEnvDir;
    if (d) for (const n of await pruneMcpEnv(d, mcpEnvKeep(f, this.o.machine, d))) this.o.log(`secrets: removed ${d}/${n}, which no sink names`);
```

- [ ] **Step 7: Write the failing relay test**

Add to `src/server/secrets.test.ts`, inside `describe("the writer relays")`:

```ts
  test("an mcp-allow waits for dotclaude's ignore on the writer's machine, and answers 409 without asking", async () => {
    const asked: SecretsRequest[] = [];
    const hub = new SecretsHub({
      backend: "mini", socket: "/run/canopy-secrets/secrets.sock", gateOrigin: GATE, reader: null, broadcast: () => {},
      ask: async (r) => (asked.push(r), { ok: true, data: {} }),
      mcpIgnored: async (server) => (server === "github" ? "/home/bun/.claude/mcp-env/github.env is inside the repo /home/bun/.claude and git does not ignore it there" : null),
    });
    const act = SAMPLES["mcp-allow"].good;
    const r = await call(hub, post("/api/secrets/act", { act }, { cookie: `canopy_secrets=${TOKEN}` }));
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toContain("pull dotclaude");
    expect(asked).toEqual([]);
    const other = await call(hub, post("/api/secrets/act", { act: { ...act, server: "other" } }, { cookie: `canopy_secrets=${TOKEN}` }));
    expect(other.status).toBe(200);
  });
```

Import `SAMPLES` from `../core/secretwire.samples` if the file does not already.

- [ ] **Step 8: The relay's check, and the hub's wiring**

In `src/server/secrets.ts`:

1. Add to `SecretsHubDeps`:

```ts
  /** the writer's accident guard before an mcp-allow: why this machine's
   *  dotclaude would commit the env file, or null (phase 2 plan, call 5) */
  mcpIgnored?: (server: string) => Promise<string | null>;
```

2. In `writerRoute`, `case "/api/secrets/act":`, after the `parseAct` check:

```ts
        if (act.a === "mcp-allow" && this.d.mcpIgnored) {
          const why = await this.d.mcpIgnored(act.server);
          if (why) return json({ error: `${why}; pull dotclaude on this machine first` }, 409);
        }
```

3. In `createSecretsHub`, import `mcpIgnoreRefusal` from `../core/sinks`, give the reader `repoRoots: () => [...o.repoRoots(), join(homedir(), ".claude")]` and `mcpEnvDir: join(homedir(), ".claude", "mcp-env")`, and pass the guard to the relay:

```ts
  return new SecretsHub({
    backend: o.backend, socket, gateOrigin, reader, broadcast: o.broadcast,
    // on the mini, this is the canopy container's /home/bun/.claude: the same dotclaude checkout as the host's
    mcpIgnored: socket ? (server) => mcpIgnoreRefusal(homedir(), server) : undefined,
  });
```

Import `join` from `node:path` if the file does not already.

- [ ] **Step 9: Run the tests**

Run: `bun test src/core/sinks.test.ts src/core/sinksync.test.ts src/secrets src/core/secretlocal.test.ts src/server/secrets.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 10: Commit**

```bash
git add src/core/sinks.ts src/core/sinks.test.ts src/core/sinksync.ts src/core/sinksync.test.ts src/secrets/service.ts src/secrets/service.test.ts src/core/secretlocal.ts src/core/secretlocal.test.ts src/server/secrets.ts src/server/secrets.test.ts
git commit -m "feat(secrets): sink writers make and prune mcp-env, and the relay checks dotclaude ignores it

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 6: The manifest's mcp block

**Files:**
- Modify: `src/core/types.ts` (`KitTarget.mcp`, `KitManifest.mcp`, new `KitMcpValue`, `KitMcpOption`, `KitMcpServer`, `KitMcpFormat`, `KitMcpTarget`)
- Modify: `src/core/kit.ts` (`parseKit`, new `parseMcpValue`, `hasSecrets`, `secretsOf`, `mcpDefOf`)
- Test: `src/core/kit.test.ts`

**Interfaces:**
- Consumes: `MCP_SERVER`, `HEADER_NAME`, `DOTENV_KEY`, `SECRET_NAME`, `SINK_ID`, `mcpSinkId` from `src/core/secretfile.ts`.
- Produces:
  - `KitTarget.mcp: KitMcpTarget | null`, `KitManifest.mcp: KitMcpServer[]` (always set by `parseKit`, `[]` with no block)
  - `parseMcpValue(v: unknown): KitMcpValue | string` (a string is the reason it was refused)
  - `hasSecrets(s: KitMcpServer): boolean`
  - `secretsOf(s: KitMcpServer): { env: Record<string, string>; headers: Record<string, string> }`
  - `mcpDefOf(s: KitMcpServer): KitMcpDef`

- [ ] **Step 1: Write the failing tests**

Add to `src/core/kit.test.ts` (extend the import from `./kit` with `hasSecrets, mcpDefOf, parseMcpValue, secretsOf`):

```ts
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/kit.test.ts`
Expected: FAIL, `parseMcpValue` not exported.

- [ ] **Step 3: Add the types**

In `src/core/types.ts`, add a field to `KitTarget` after `machines`:

```ts
  /** where this agent keeps its MCP servers; null: the kit writes none for it */
  mcp: KitMcpTarget | null;
```

add a field to `KitManifest` after `exclude`:

```ts
  /** the MCP servers, in manifest order */
  mcp: KitMcpServer[];
```

and after `KitManifest`:

```ts
export type KitMcpFormat = "claude-json" | "codex-toml";

export interface KitMcpTarget {
  /** `~/.claude.json` for claude; `~/.codex/config.toml` for codex */
  file: string;
  format: KitMcpFormat;
}

/** a value in a server's env or headers, as kit.json writes it */
export type KitMcpValue = { literal: string } | { env: string } | { secret: string };

export type KitMcpOption = string | number | boolean;

export interface KitMcpServer {
  name: string;
  command: string | null;
  args: string[];
  url: string | null;
  env: Record<string, KitMcpValue>;
  headers: Record<string, KitMcpValue>;
  /** null: every agent with an mcp target */
  agents: string[] | null;
  /** null: every machine */
  machines: string[] | null;
  /** agent to fields written into that agent's entry as they are (a leading ~/ expands); only on servers without secrets */
  options: Record<string, Record<string, KitMcpOption>>;
}
```

- [ ] **Step 4: Parse the block**

In `src/core/kit.ts`, extend the type import with `KitMcpDef, KitMcpFormat, KitMcpOption, KitMcpServer, KitMcpTarget, KitMcpValue`, extend the `./secretfile` import to `import { canonical, DOTENV_KEY, HEADER_NAME, MCP_SERVER, mcpSinkId, SECRET_NAME, SINK_ID } from "./secretfile";`, and add above `parseKit`:

```ts
/** any server's name: the server part of an `mcp:` allow entry */
export const MCP_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
/** fields the kit writes itself, so an option cannot set them. headersHelper
 *  is not one: the kit writes it only for secret headers, and a server with
 *  secrets takes no options, so executor's own helper can be an option. */
const RESERVED = new Set(["type", "command", "args", "url", "env", "headers", "http_headers"]);
const REF = /^\$\{(env|secret):([^}]*)\}$/;

export function parseMcpValue(v: unknown): KitMcpValue | string {
  if (typeof v !== "string") return "is not a string";
  const m = REF.exec(v);
  if (m) {
    const name = m[2] ?? "";
    if (m[1] === "env") return DOTENV_KEY.test(name) ? { env: name } : `\${env:${name}} is not a variable name`;
    return SECRET_NAME.test(name) ? { secret: name } : `\${secret:${name}} is not a secret name`;
  }
  if (v.includes("${")) return "holds ${ that is not one whole ${env:NAME} or ${secret:NAME}";
  return { literal: v };
}

export const hasSecrets = (s: KitMcpServer): boolean => [...Object.values(s.env), ...Object.values(s.headers)].some((v) => "secret" in v);

const secretMap = (vals: Record<string, KitMcpValue>): Record<string, string> =>
  Object.fromEntries(Object.entries(vals).flatMap(([k, v]) => ("secret" in v ? [[k, v.secret]] : [])));

export const secretsOf = (s: KitMcpServer): { env: Record<string, string>; headers: Record<string, string> } => ({ env: secretMap(s.env), headers: secretMap(s.headers) });

export const mcpDefOf = (s: KitMcpServer): KitMcpDef => ({
  command: s.command, args: [...s.args], url: s.url, env: Object.keys(s.env).sort(), headers: Object.keys(s.headers).sort(),
});

function parseServer(name: string, s: Record<string, unknown>, machines: KitMachine[], errors: string[]): KitMcpServer | null {
  const at = `mcp.${name}`;
  const fail = (why: string): null => {
    errors.push(`${at}: ${why}`);
    return null;
  };
  const command = str(s["command"]);
  const url = str(s["url"]);
  if ((command === null) === (url === null)) return fail("needs command or url, not both");
  if (url !== null && !/^https?:\/\//.test(url)) return fail("url is http or https");
  if (url !== null && s["args"] !== undefined) return fail("args are for a command only");
  if (url !== null && s["env"] !== undefined) return fail("env is for a command only");
  if (command !== null && s["headers"] !== undefined) return fail("headers are for a url only");
  const args = s["args"] === undefined ? [] : strs(s["args"]);
  if (!args) return fail("args is a list of strings");
  const values = (field: "env" | "headers", re: RegExp): Record<string, KitMcpValue> | null => {
    const o = s[field] === undefined ? {} : s[field];
    if (!isObj(o)) return fail(`${field} is an object`);
    const out: Record<string, KitMcpValue> = {};
    for (const [k, v] of Object.entries(o)) {
      if (!re.test(k)) return fail(`${field}.${k} is not a name`);
      const p = parseMcpValue(v);
      if (typeof p === "string") return fail(`${field}.${k} ${p}`);
      out[k] = p;
    }
    return out;
  };
  const env = values("env", DOTENV_KEY);
  const headers = values("headers", HEADER_NAME);
  if (!env || !headers) return null;
  const agents = s["agents"] === undefined ? null : strs(s["agents"]);
  const ms = s["machines"] === undefined ? null : strs(s["machines"]);
  if ((s["agents"] !== undefined && !agents) || (s["machines"] !== undefined && !ms)) return fail("agents and machines are lists of names");
  const options: Record<string, Record<string, KitMcpOption>> = {};
  const rawOpts = s["options"] === undefined ? {} : s["options"];
  if (!isObj(rawOpts)) return fail("options is an object of agent to fields");
  for (const [agent, o] of Object.entries(rawOpts)) {
    if (!isObj(o)) return fail(`options.${agent} is an object`);
    const fields: Record<string, KitMcpOption> = {};
    for (const [k, v] of Object.entries(o)) {
      if (RESERVED.has(k)) return fail(`options.${agent}.${k} is reserved; the kit writes it`);
      if (typeof v !== "string" && typeof v !== "number" && typeof v !== "boolean") return fail(`options.${agent}.${k} is a string, a number or a boolean`);
      fields[k] = v;
    }
    options[agent] = fields;
  }
  const server: KitMcpServer = { name, command, args, url, env, headers, agents, machines: ms, options };
  if (hasSecrets(server)) {
    if (!MCP_SERVER.test(name)) return fail("a server with secrets has a name of a-z, 0-9 and -, at most 32 long");
    if (Object.keys(options).length > 0) return fail("options are for servers without secrets");
    for (const m of machines) {
      if (ms !== null && !ms.includes(m.name)) continue;
      const id = mcpSinkId(name, m.name, true);
      if (!SINK_ID.test(id)) return fail(`the sink id ${id} is too long; shorten the server's name`);
    }
  }
  return server;
}
```

In `parseKit`, inside the targets loop, replace the `targets.push(...)` line with:

```ts
    let mcp: KitMcpTarget | null = null;
    if (t["mcp"] !== undefined) {
      const o = isObj(t["mcp"]) ? t["mcp"] : {};
      const file = str(o["file"]);
      const format = o["format"] as KitMcpFormat;
      const fits = (format === "claude-json" && agent === "claude") || (format === "codex-toml" && agent === "codex");
      if (!file || !fits) errors.push(`targets[${i}].mcp: needs a file, and the format claude-json for claude or codex-toml for codex`);
      else if (format === "claude-json" && file !== "~/.claude.json") errors.push(`targets[${i}].mcp: claude mcp writes ~/.claude.json, so the file is that`);
      else mcp = { file, format };
    }
    targets.push({ agent, skills, mode, machines: t["machines"] === undefined ? null : strs(t["machines"]), mcp });
```

after the `only` loop:

```ts
  const mcp: KitMcpServer[] = [];
  for (const [name, s] of Object.entries(isObj(raw["mcp"]) ? raw["mcp"] : {})) {
    if (!MCP_NAME.test(name) || !isObj(s)) { errors.push(`mcp.${name}: bad name or not an object`); continue; }
    const server = parseServer(name, s, machines, errors);
    if (server) mcp.push(server);
  }
```

and add `mcp` to the returned `kit` object.

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/kit.test.ts src/core/kitscan.test.ts src/server/kit.test.ts && bun run typecheck`
Expected: PASS. Every existing manifest has no `mcp`, so each target reads `mcp: null` and the kit `mcp: []`.

- [ ] **Step 6: Commit**

```bash
git add src/core/types.ts src/core/kit.ts src/core/kit.test.ts
git commit -m "feat(kit): the manifest's mcp block, with env and secret references and per-agent options

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 7: Planning MCP servers and painting their cells

**Files:**
- Modify: `src/core/types.ts` (`KitAction`, `KitMcpAction`, `KitCellState`, `KitCell`, new `KitMcpFileSeen`, `KitMcpOwned`, `KitMcpSeen`, `KitMcpCtx`)
- Modify: `src/core/kit.ts` (new `WRAPPER`, `buildEntry`, `sameEntry`, `allowanceOf`, `serverReady`, `mcpTargets`, `mcpWanted`, `planMcp`, `mcpCells`, `maskEntry`, `isMcpAction`; `planKit` and `cellsOf` take an optional ctx)
- Modify: `src/core/kitapply.ts` (`applyArgs` and `nextPlaced` skip MCP actions, so the skills script never sees them)
- Modify: `ui/src/kit.ts` (`GLYPH`, `PROBLEM` cover the new states, so the page still typechecks)
- Test: `src/core/kit.test.ts`

**Interfaces:**
- Consumes: Task 6's manifest types and helpers; `mcpSinkId`, `parseMcpAllow`, `canonical` from `src/core/secretfile.ts`; `SecretsInfo` from types.
- Produces:
  - `KitAction` gains `{ kind: "mcp-set" | "mcp-remove" | "mcp-adopt" | "mcp-restore"; agent: string; name: string }` (four members; names only, never an entry)
  - `KitMcpAction = Extract<KitAction, { kind: "mcp-set" | "mcp-remove" | "mcp-adopt" | "mcp-restore" }>`, `isMcpAction(a: KitAction): a is KitMcpAction`
  - `KitCellState` gains `"not-allowed" | "stale-allowance" | "no-sink" | "adoptable" | "unsupported" | "phase-3" | "unresolved"`
  - `KitCell.kind?: "mcp"`, `KitCell.restore?: boolean`
  - `type KitMcpEntry = Record<string, unknown>`
  - `buildEntry(s, agent, format, home, env): { entry: KitMcpEntry } | { state: KitCellState; why: string }`
  - `planMcp(kit, seen, ctx): { actions: KitAction[]; entries: Record<string, KitMcpEntry> }` with keys `"<agent>/<name>"`
  - `mcpCells(kit, seen, ctx): KitCell[]`
  - `planKit(kit, seen, dev, ctx?: KitMcpCtx)`, `cellsOf(kit, views: { seen: KitSeen; dev: string; ctx?: KitMcpCtx }[])`
  - `maskEntry(e: KitMcpEntry): KitMcpEntry`, `sameEntry(a, b): boolean`

- [ ] **Step 1: Add the types**

In `src/core/types.ts`, replace `KitAction` and `KitCellState` and extend `KitCell`:

```ts
export type KitAction =
  | { kind: "mkdir"; agent: string }
  | { kind: "link"; agent: string; name: string; link: string }
  | { kind: "relink"; agent: string; name: string; link: string }
  | { kind: "remove"; agent: string; name: string }
  | { kind: "pull" }
  /** an MCP server written as the kit defines it (phase 2); the entry stays in KitHub */
  | { kind: "mcp-set"; agent: string; name: string }
  | { kind: "mcp-remove"; agent: string; name: string }
  /** a hand-made entry replaced by the kit's, the old one kept for put back */
  | { kind: "mcp-adopt"; agent: string; name: string }
  | { kind: "mcp-restore"; agent: string; name: string };

export type KitMcpAction = Extract<KitAction, { kind: "mcp-set" | "mcp-remove" | "mcp-adopt" | "mcp-restore" }>;

export type KitCellState =
  | "ok" | "missing" | "drift" | "foreign" | "local" | "off" | "no-source" | "noagent" | "away"
  /** MCP servers (phase 2) */
  | "not-allowed" | "stale-allowance" | "no-sink" | "adoptable" | "unsupported" | "phase-3" | "unresolved";
```

and in `KitCell`, after `why`:

```ts
  /** an MCP server's cell; absent for a skill (and from a backend before phase 2) */
  kind?: "mcp";
  /** canopy keeps the hand-made entry adopt replaced here: put back restores it */
  restore?: boolean;
```

and after `KitApplyResult`:

```ts
/** an MCP entry as an agent's file holds it, or as the kit would write it */
export type KitMcpEntry = Record<string, unknown>;

/** an agent's MCP file as the scan read it. Raw: it stays in KitHub and
 *  never reaches KitInfo, a route or an event. */
export interface KitMcpFileSeen {
  agent: string;
  /** with ~ expanded on that machine */
  path: string;
  /** "<mtime> <size>" for the in-place write's check; "" when the file is missing */
  stamp: string;
  exists: boolean;
  text: string;
  /** server name to entry; null when the file does not parse */
  entries: Record<string, KitMcpEntry> | null;
  /** canopy's words for why it did not parse, never the parser's */
  error: string | null;
}

/** ~/.claude/.canopy-kit-mcp.json: what canopy wrote, and what adopt replaced */
export interface KitMcpOwned {
  /** agent to the server names canopy wrote there */
  placed: Record<string, string[]>;
  /** agent to name to the hand-made entry adopt replaced */
  adoptedFrom: Record<string, Record<string, KitMcpEntry>>;
}

export interface KitMcpSeen {
  /** the claude binary the scan found, absolute; null when none */
  claude: string | null;
  /** dotclaude's git ignores mcp-env/ on this machine */
  ignored: boolean;
  /** ~/.claude/bin/canopy-mcp-env is there and runs */
  wrapper: boolean;
  owned: KitMcpOwned;
  files: KitMcpFileSeen[];
}

/** what MCP planning needs beyond the scan */
export interface KitMcpCtx {
  mcp: KitMcpSeen;
  /** server name to its definition hash */
  hashes: Record<string, string>;
  /** the store's metadata as this backend sees it; null when it has none */
  secrets: SecretsInfo | null;
  /** the home ~ stands for in what the kit writes: the host's, on the mini */
  home: string;
  /** where ${env:NAME} resolves */
  env: Record<string, string | undefined>;
  /** reached over ssh (gpd): a server with secrets waits for secrets phase 3 */
  ssh: boolean;
}
```

- [ ] **Step 2: Keep the skills path and the page compiling**

In `src/core/kitapply.ts`, import `isMcpAction` from `./kit` (Step 5 adds it), and make `applyArgs` and `nextPlaced` skip MCP actions; Task 11 routes them elsewhere:

```ts
export function applyArgs(seen: KitSeen, actions: KitAction[]): string[] {
  const args = [storeOf(seen)];
  for (const a of actions) {
    if (isMcpAction(a)) continue;
    if (a.kind === "pull") args.push("pull", "-", "-", "-");
    else if (a.kind === "mkdir") args.push("mkdir", dirOf(seen, a.agent), "-", "-");
    else if (a.kind === "remove") args.push("remove", dirOf(seen, a.agent), a.name, "-");
    else args.push(a.kind, dirOf(seen, a.agent), a.name, a.link);
  }
  return args;
}
```

and in `nextPlaced`, change the first line of the loop to `if (a.kind === "pull" || a.kind === "mkdir" || isMcpAction(a)) continue;`.

In `ui/src/kit.ts`:

```ts
export const GLYPH: Record<KitCellState, string> = {
  ok: "●", missing: "○", drift: "≠", foreign: "◆", local: "·", off: "", "no-source": "∅", noagent: "–", away: "?",
  "not-allowed": "⊘", "stale-allowance": "⊘", "no-sink": "◌", adoptable: "◇", unsupported: "×", "phase-3": "…", unresolved: "∅",
};

export const PROBLEM: ReadonlySet<KitCellState> = new Set([
  "missing", "drift", "foreign", "no-source", "away", "not-allowed", "stale-allowance", "no-sink", "adoptable", "unresolved",
]);
```

`unsupported` and `phase-3` are not problems: nothing a person can do here fixes them.

- [ ] **Step 3: Write the failing planning tests**

Add to `src/core/kit.test.ts` (extend the imports: `buildEntry, cellsOf, maskEntry, mcpCells, mcpHash, planMcp, sameEntry` from `./kit`, and `KitMcpCtx, KitMcpOwned, SecretKeyState, SecretsInfo` from `./types`):

```ts
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
```

`seen()` is the file's existing helper (machine `mac`, home `/Users/e`); `KitAction` and `KitCell` join the type import if they are not there yet.

- [ ] **Step 4: Run them to see them fail**

Run: `bun test src/core/kit.test.ts`
Expected: FAIL, `buildEntry` not exported.

- [ ] **Step 5: Write the planning code**

In `src/core/kit.ts`, extend the type imports with `KitMcpAction, KitMcpCtx, KitMcpEntry, SecretsInfo` and the `./secretfile` import with `parseMcpAllow`, then add after `cellsOf`:

```ts
/* ---------- MCP servers (docs/superpowers/specs/2026-10-14-kit-secrets-phase-2-design.md) ---------- */

export const WRAPPER = "~/.claude/bin/canopy-mcp-env";

export const isMcpAction = (a: KitAction): a is KitMcpAction => a.kind.startsWith("mcp-");

export const mcpTargets = (kit: KitManifest, machine: string): (KitTarget & { mcp: KitMcpTarget })[] =>
  targetsFor(kit, machine).filter((t): t is KitTarget & { mcp: KitMcpTarget } => t.mcp !== null);

export const mcpWanted = (s: KitMcpServer, agent: string, machine: string): boolean =>
  (s.agents === null || s.agents.includes(agent)) && (s.machines === null || s.machines.includes(machine));

/** literal and ${env:} values resolved; secrets left to the wrapper */
function resolved(vals: Record<string, KitMcpValue>, env: Record<string, string | undefined>): Record<string, string> | { unset: string } {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(vals)) {
    if ("secret" in v) continue;
    if ("literal" in v) out[k] = v.literal;
    else {
      const x = env[v.env];
      if (x === undefined) return { unset: v.env };
      out[k] = x;
    }
  }
  return out;
}

/** the entry one agent's config should hold on this machine, or why it holds none */
export function buildEntry(s: KitMcpServer, agent: string, format: KitMcpFormat, home: string, env: Record<string, string | undefined>): { entry: KitMcpEntry } | { state: KitCellState; why: string } {
  const exp = (v: string) => expandHome(v, home);
  const e = resolved(s.env, env);
  const h = resolved(s.headers, env);
  if ("unset" in e || "unset" in h) {
    const n = "unset" in e ? e.unset : "unset" in h ? h.unset : "";
    return { state: "unresolved", why: `\${env:${n}} is not set for canopy here` };
  }
  const sec = secretsOf(s);
  const wrapper = exp(WRAPPER);
  const opts = Object.fromEntries(Object.entries(s.options[agent] ?? {}).map(([k, v]) => [k, typeof v === "string" ? exp(v) : v]));
  if (s.command !== null) {
    const viaWrapper = Object.keys(sec.env).length > 0;
    const command = viaWrapper ? wrapper : exp(s.command);
    const args = viaWrapper ? [s.name, "--", exp(s.command), ...s.args.map(exp)] : s.args.map(exp);
    const entry: KitMcpEntry = format === "claude-json" ? { type: "stdio", command, args } : { command, args };
    if (Object.keys(e).length > 0) entry["env"] = e;
    return { entry: { ...entry, ...opts } };
  }
  const secretHeaders = Object.keys(sec.headers).length > 0;
  if (format === "codex-toml") {
    if (secretHeaders) return { state: "unsupported", why: "not supported for codex: a url server with secret headers" };
    const entry: KitMcpEntry = { url: s.url };
    if (Object.keys(h).length > 0) entry["http_headers"] = h;
    return { entry: { ...entry, ...opts } };
  }
  const entry: KitMcpEntry = { type: "http", url: s.url };
  if (Object.keys(h).length > 0) entry["headers"] = h;
  if (secretHeaders) entry["headersHelper"] = `${wrapper} --headers ${s.name}`;
  return { entry: { ...entry, ...opts } };
}

const bare = (e: KitMcpEntry): KitMcpEntry =>
  Object.fromEntries(Object.entries(e).filter(([k, v]) => !(k === "type" && v === "stdio") && !(Array.isArray(v) && v.length === 0) && !(isObj(v) && Object.keys(v).length === 0)));

/** the same server: `type: "stdio"` and empty lists and tables are what each CLI leaves out or adds */
export const sameEntry = (a: KitMcpEntry, b: KitMcpEntry): boolean => canonical(bare(a)) === canonical(bare(b));

/** whether each of the server's secrets allows this definition, an older one, or none */
export function allowanceOf(s: KitMcpServer, hash: string, info: SecretsInfo): "allowed" | "stale" | "none" {
  const names = [...Object.values(secretsOf(s).env), ...Object.values(secretsOf(s).headers)];
  const hashes = names.map((n) => info.secrets.find((m) => m.name === n)?.allow.map(parseMcpAllow).find((p) => p?.server === s.name)?.hash ?? null);
  if (hashes.every((x) => x === hash)) return "allowed";
  return hashes.some((x) => x !== null) ? "stale" : "none";
}

function sinkReady(info: SecretsInfo, id: string, keys: string[]): { ok: true } | { waiting: true } | { why: string } {
  const k = info.sinks.find((x) => x.id === id);
  if (!k) return { why: `no sink ${id}; allow it again` };
  if (k.error) return { why: `sink ${id}: ${k.error}` };
  const states = keys.map((key) => k.state[key] ?? "unknown");
  if (states.every((x) => x === "same")) return { ok: true };
  if (states.some((x) => x === "waiting")) return { waiting: true };
  return { why: `sink ${id} reads ${states.join(", ")}` };
}

/** whether a server's secrets can reach it on this machine now */
export function serverReady(s: KitMcpServer, machine: string, ctx: KitMcpCtx): { ok: true } | { waiting: true } | { state: KitCellState; why: string } {
  if (!hasSecrets(s)) return { ok: true };
  if (ctx.ssh) return { state: "phase-3", why: "a server with secrets on an ssh machine waits for secrets phase 3" };
  if (!ctx.secrets?.ok) return { state: "no-sink", why: "this backend cannot read the secret store" };
  const a = allowanceOf(s, ctx.hashes[s.name] ?? "", ctx.secrets);
  if (a === "none") return { state: "not-allowed", why: "not allowed; allow it from the kit view" };
  if (a === "stale") return { state: "stale-allowance", why: "allowed for an older definition; allow it again" };
  if (!ctx.mcp.ignored) return { state: "no-sink", why: "dotclaude does not ignore mcp-env/ here; pull dotclaude" };
  if (!ctx.mcp.wrapper) return { state: "no-sink", why: "~/.claude/bin/canopy-mcp-env is missing; pull dotclaude" };
  const sec = secretsOf(s);
  let waiting = false;
  for (const [id, keys] of [[mcpSinkId(s.name, machine), Object.keys(sec.env)], [mcpSinkId(s.name, machine, true), Object.keys(sec.headers)]] as const) {
    if (keys.length === 0) continue;
    const r = sinkReady(ctx.secrets, id, keys);
    if ("why" in r) return { state: "no-sink", why: r.why };
    if ("waiting" in r) waiting = true;
  }
  return waiting ? { waiting: true } : { ok: true };
}

interface McpRow { agent: string; name: string; state: KitCellState; why: string; want: KitMcpEntry | null; restore: boolean; action: KitAction | null }

function mcpRows(kit: KitManifest, seen: KitSeen, ctx: KitMcpCtx): McpRow[] {
  const out: McpRow[] = [];
  for (const t of mcpTargets(kit, seen.machine)) {
    const file = ctx.mcp.files.find((x) => x.agent === t.agent);
    const placed = ctx.mcp.owned.placed[t.agent] ?? [];
    const adopted = ctx.mcp.owned.adoptedFrom[t.agent] ?? {};
    const mine = kit.mcp.filter((s) => mcpWanted(s, t.agent, seen.machine));
    const row = (name: string, state: KitCellState, why: string, extra: Partial<McpRow> = {}): McpRow =>
      ({ agent: t.agent, name, state, why, want: null, restore: name in adopted, action: null, ...extra });
    if (!file || file.entries === null) {
      for (const s of mine) out.push(row(s.name, "drift", file?.error ?? `${t.mcp.file} was not read`));
      continue;
    }
    if (t.mcp.format === "claude-json" && !ctx.mcp.claude) {
      for (const s of mine) out.push(row(s.name, "noagent", "no claude binary found here"));
      continue;
    }
    const entries = file.entries;
    for (const name of [...new Set([...kit.mcp.map((s) => s.name), ...Object.keys(entries), ...placed, ...Object.keys(adopted)])].sort()) {
      const s = mine.find((x) => x.name === name);
      const have = entries[name] ?? null;
      const owned = placed.includes(name);
      const remove: Partial<McpRow> = owned && have ? { action: { kind: "mcp-remove", agent: t.agent, name } } : {};
      if (!s) {
        const known = kit.mcp.some((x) => x.name === name);
        if (owned && have) out.push(row(name, "drift", "kit.json no longer gives it here; apply removes it", remove));
        else if (have) out.push(row(name, "local", known ? "here, but the manifest does not give it to this agent" : "hand-made; kit.json does not define it"));
        else if (name in adopted) out.push(row(name, "off", "canopy took it out; put back restores the hand-made one"));
        else if (known) out.push(row(name, "off", ""));
        continue;
      }
      const built = buildEntry(s, t.agent, t.mcp.format, ctx.home, ctx.env);
      if ("state" in built) {
        out.push(row(name, built.state, built.why, remove));
        continue;
      }
      const ready = serverReady(s, seen.machine, ctx);
      if ("state" in ready) {
        out.push(row(name, ready.state, have && !owned ? `${ready.why}; a hand-made entry is there` : ready.why, remove));
        continue;
      }
      if ("waiting" in ready) {
        // the sink file keeps the last value while the Mac is locked, so a written server stays (review focus 1)
        out.push(owned && have ? row(name, "ok", "waiting for unlock; keeps what it has") : row(name, "no-sink", "waiting for unlock"));
        continue;
      }
      const want = built.entry;
      const set: KitAction = { kind: "mcp-set", agent: t.agent, name };
      if (!have) out.push(row(name, "missing", "", { want, action: set }));
      else if (!owned) out.push(row(name, "adoptable", sameEntry(have, want) ? "a hand-made entry the same as the kit's; adopt to manage it" : "a hand-made entry; adopt shows both", { want }));
      else if (sameEntry(have, want)) out.push(row(name, "ok", "", { want }));
      else out.push(row(name, "drift", "differs from kit.json; apply writes the kit's version", { want, action: set }));
    }
  }
  return out;
}

/** the MCP actions apply all takes (never an adopt), and every entry the
 *  kit would write here, keyed "<agent>/<name>", for apply and adopt */
export function planMcp(kit: KitManifest, seen: KitSeen, ctx: KitMcpCtx): { actions: KitAction[]; entries: Record<string, KitMcpEntry> } {
  if (seen.away) return { actions: [], entries: {} };
  const rows = mcpRows(kit, seen, ctx);
  return {
    actions: rows.flatMap((r) => (r.action ? [r.action] : [])),
    entries: Object.fromEntries(rows.flatMap((r) => (r.want ? [[`${r.agent}/${r.name}`, r.want]] : []))),
  };
}

export function mcpCells(kit: KitManifest, seen: KitSeen, ctx: KitMcpCtx): KitCell[] {
  if (seen.away) return [];
  return mcpRows(kit, seen, ctx).map((r) => ({ machine: seen.machine, agent: r.agent, skill: r.name, state: r.state, why: r.why, kind: "mcp" as const, ...(r.restore ? { restore: true } : {}) }));
}

const SECRETISH = /token|secret|password|passwd|auth|bearer|cookie|key/i;
const LONG = /[A-Za-z0-9_\-+/=]{24,}/g;
const DOT = "•••";
/** a run of 24 or more token characters holding both a digit and a letter reads as a token */
const maskText = (v: string): string => v.replace(LONG, (m) => (/\d/.test(m) && /[A-Za-z]/.test(m) ? DOT : m));
const maskArg = (v: string): string => {
  const i = v.indexOf("=");
  return i > 0 && SECRETISH.test(v.slice(0, i)) ? `${v.slice(0, i + 1)}${DOT}` : maskText(v);
};
function maskUrl(u: string): string {
  const i = u.indexOf("?");
  if (i < 0) return maskText(u);
  const q = u.slice(i + 1).split("&").map((p) => (p.includes("=") ? `${p.slice(0, p.indexOf("="))}=${DOT}` : p));
  return `${maskText(u.slice(0, i))}?${q.join("&")}`;
}

/** An entry with every value that could be a secret hidden: env and
 *  header values, url query values, `name=` args and options whose name
 *  says token, and anything token-shaped. Names stay. For the adopt
 *  preview, which may show a hand-made entry holding a literal value. */
export function maskEntry(e: KitMcpEntry): KitMcpEntry {
  const out: KitMcpEntry = {};
  for (const [k, v] of Object.entries(e)) {
    if (["env", "headers", "http_headers", "env_http_headers"].includes(k) && isObj(v)) out[k] = Object.fromEntries(Object.keys(v).map((n) => [n, DOT]));
    else if (k === "url" && typeof v === "string") out[k] = maskUrl(v);
    else if (typeof v === "string") out[k] = SECRETISH.test(k) && !k.endsWith("_env_var") && k !== "headersHelper" ? DOT : maskText(v);
    else if (Array.isArray(v)) out[k] = v.map((x) => (typeof x === "string" ? maskArg(x) : isObj(x) ? maskEntry(x) : x));
    else out[k] = isObj(v) ? maskEntry(v) : v;
  }
  return out;
}
```

Then make `planKit` and `cellsOf` take the ctx. Rename the current `planKit` to `planSkills` (unexported) and add:

```ts
export function planKit(kit: KitManifest, seen: KitSeen, dev: string, ctx?: KitMcpCtx): KitAction[] {
  const skills = planSkills(kit, seen, dev);
  if (!ctx || seen.away || !seen.store) return skills;
  return [...skills, ...planMcp(kit, seen, ctx).actions];
}
```

In `cellsOf`, change the parameter to `views: { seen: KitSeen; dev: string; ctx?: KitMcpCtx }[]`, change the loop to `for (const { seen, dev, ctx } of views)`, and append at the end of the loop body, after the `seen.targets.forEach(...)`:

```ts
    if (ctx) out.push(...mcpCells(kit, seen, ctx));
```

- [ ] **Step 6: Run the tests**

Run: `bun test src/core/kit.test.ts src/core/kitapply.test.ts ui/src/kit.test.ts && bun run typecheck && bun run lint`
Expected: PASS. If `maskEntry`'s expected `url` in the test differs only by `mode=•••`, that is the rule (every query value is hidden), not a bug.

- [ ] **Step 7: Commit**

```bash
git add src/core/types.ts src/core/kit.ts src/core/kit.test.ts src/core/kitapply.ts ui/src/kit.ts
git commit -m "feat(kit): plan MCP servers from the scan and the store's allowances, and paint their cells

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 8: The canopy-mcp-env wrapper

**Files:**
- Create: `scripts/canopy-mcp-env` (mode 755)
- Test: `src/core/mcpenv.test.ts`

**Interfaces:**
- Consumes: `applyKeys` from `src/core/sinks.ts` (the test builds its file with the real dotenv writer, so the wrapper reads exactly what the sink writer emits).
- Produces: `canopy-mcp-env <server> -- <command> [args...]` and `canopy-mcp-env --headers <server>`, reading `$HOME/.claude/mcp-env/<server>.env` and `<server>.headers.json`. Task 17 copies the file to dotclaude's `bin/`.

- [ ] **Step 1: Write the failing test**

Create `src/core/mcpenv.test.ts`:

```ts
import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec } from "./exec";
import { applyKeys } from "./sinks";

const WRAPPER = join(import.meta.dir, "..", "..", "scripts", "canopy-mcp-env");
let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});
function home(): string {
  const h = mkdtempSync(join(tmpdir(), "mcpenv-"));
  dirs.push(h);
  mkdirSync(join(h, ".claude", "mcp-env"), { recursive: true });
  return h;
}

// one value per branch of quoteDotenv: bare, single quoted, double quoted
const AWKWARD: Record<string, string> = {
  BARE: "plain-value_1.2:3@x+y,z=w",
  SPACED: "two words $HOME `id` \\back = sign",
  DQ: 'it\'s "quoted"\nsecond\tline\\ end',
  TRAIL: "ends with a newline\n",
  CMD: "$(touch PWNED) ; `touch PWNED2`",
};
const PRINT = `process.stdout.write(JSON.stringify(Object.fromEntries(${JSON.stringify(Object.keys(AWKWARD))}.map((k) => [k, process.env[k]]))))`;

test("passes every value through unchanged, and never runs one", async () => {
  const h = home();
  const t = applyKeys(null, "dotenv", AWKWARD);
  if ("error" in t) throw new Error(t.error);
  // a comment, and no newline after the last pair: the reader takes both
  writeFileSync(join(h, ".claude", "mcp-env", "demo.env"), `# written by canopy\n${t.text.replace(/\n$/, "")}`, { mode: 0o600 });
  for (const sh of ["sh", ...(Bun.which("dash") ? ["dash"] : [])]) {
    const r = await exec([sh, WRAPPER, "demo", "--", process.execPath, "-e", PRINT], { cwd: h, env: { HOME: h } });
    expect(r.stderr).toBe("");
    expect(JSON.parse(r.stdout)).toEqual(AWKWARD);
  }
  expect(existsSync(join(h, "PWNED"))).toBe(false);
  expect(existsSync(join(h, "PWNED2"))).toBe(false);
});

test("--headers prints the headers file as it is", async () => {
  const h = home();
  writeFileSync(join(h, ".claude", "mcp-env", "hook.headers.json"), '{"Authorization":"x"}\n');
  const r = await exec(["sh", WRAPPER, "--headers", "hook"], { env: { HOME: h } });
  expect(r).toMatchObject({ code: 0, stdout: '{"Authorization":"x"}\n' });
});

test("a missing file and a bad call exit 1 with one line naming the file, and print nothing", async () => {
  const h = home();
  const r = await exec(["sh", WRAPPER, "gone", "--", "true"], { env: { HOME: h } });
  expect(r.code).toBe(1);
  expect(r.stdout).toBe("");
  expect(r.stderr).toBe(`canopy-mcp-env: cannot read ${join(h, ".claude", "mcp-env", "gone.env")}\n`);
  expect((await exec(["sh", WRAPPER, "../etc", "--", "true"], { env: { HOME: h } })).stderr).toContain("usage");
  expect((await exec(["sh", WRAPPER, "demo", "true"], { env: { HOME: h } })).stderr).toContain("usage");
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test src/core/mcpenv.test.ts`
Expected: FAIL, `sh` cannot open `scripts/canopy-mcp-env`.

- [ ] **Step 3: Write the wrapper**

Create `scripts/canopy-mcp-env`:

```sh
#!/bin/sh
# canopy-mcp-env: start an MCP server with its secrets from the kit's env
# sink, never evaluating them (canopy's docs/superpowers/specs/
# 2026-10-14-kit-secrets-phase-2-design.md). The source is canopy's
# scripts/canopy-mcp-env; dotclaude's bin/canopy-mcp-env is a copy.
#
#   canopy-mcp-env <server> -- <command> [args...]
#   canopy-mcp-env --headers <server>
#
# It reads the dialect canopy's dotenv sink writer emits: KEY=bare,
# KEY='single quoted' (literal) and KEY="double quoted" (\\ \" \n \r \t).
set -u
dir="$HOME/.claude/mcp-env"
nl='
'
cr=$(printf '\r')
tab=$(printf '\t')

die() { printf 'canopy-mcp-env: %s\n' "$1" >&2; exit 1; }

name_ok() {
  case $1 in [a-z]*) ;; *) return 1 ;; esac
  case $1 in *[!a-z0-9-]*) return 1 ;; esac
  return 0
}

# val becomes the value written after KEY=. No eval and no command
# substitution: nothing in it runs, and a trailing newline stays.
decode() {
  v=$1
  val=
  case $v in
    "'"*)
      v=${v#"'"}
      val=${v%%"'"*}
      ;;
    '"'*)
      v=${v#'"'}
      while [ -n "$v" ]; do
        c=${v%"${v#?}"}
        v=${v#?}
        case $c in
          '"') break ;;
          '\')
            c=${v%"${v#?}"}
            v=${v#?}
            case $c in n) c=$nl ;; r) c=$cr ;; t) c=$tab ;; esac
            ;;
        esac
        val=$val$c
      done
      ;;
    *) val=$v ;;
  esac
}

if [ "${1:-}" = "--headers" ]; then
  name_ok "${2:-}" || die "usage: canopy-mcp-env --headers <server>"
  f="$dir/$2.headers.json"
  [ -r "$f" ] || die "cannot read $f"
  exec cat "$f"
fi

server=${1:-}
if ! name_ok "$server" || [ "${2:-}" != "--" ] || [ $# -lt 3 ]; then
  die "usage: canopy-mcp-env <server> -- <command> [args...]"
fi
shift 2
f="$dir/$server.env"
[ -r "$f" ] || die "cannot read $f"
while IFS= read -r line || [ -n "$line" ]; do
  case $line in '' | '#'*) continue ;; esac
  line=${line#export }
  k=${line%%=*}
  [ "$k" = "$line" ] && continue
  case $k in '' | [0-9]* | *[!A-Za-z0-9_]*) continue ;; esac
  decode "${line#*=}"
  export "$k=$val"
done <"$f"
exec "$@"
```

Then: `chmod 755 scripts/canopy-mcp-env`.

This script was run against the test above under macOS `/bin/sh` and `dash` while the plan was written; both passed.

- [ ] **Step 4: Run the test**

Run: `bun test src/core/mcpenv.test.ts && bun run lint`
Expected: PASS.

- [ ] **Step 5: Note the limit in the docs**

In `docs/architecture.md`, section "The secret store", add one paragraph at its end:

```markdown
An MCP server's secrets reach it through `canopy-mcp-env` (`scripts/canopy-mcp-env`, copied to dotclaude's `bin/`), which reads `~/.claude/mcp-env/<server>.env` line by line and exports each value without evaluating it. It reads exactly what `quoteDotenv` writes, so a value that sink writer refuses (a quote or a newline together with a `$`) cannot reach an MCP server: its sink reads the writer's error instead.
```

- [ ] **Step 6: Commit**

```bash
git add scripts/canopy-mcp-env src/core/mcpenv.test.ts docs/architecture.md
git commit -m "feat(kit): canopy-mcp-env starts an MCP server with its sink's values, never evaluating them

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 9: The MCP writers: config.toml in place, Claude through its CLI

**Files:**
- Modify: `src/core/exec.ts` (`ExecOptions.input`, passed through `onHost`)
- Test: `src/core/exec.test.ts`
- Create: `src/core/kitmcp.ts`
- Create: `src/core/kitfake.ts` (test helper: a fake `claude`)
- Test: `src/core/kitmcp.test.ts`

**Interfaces:**
- Consumes: `KitMcpEntry` (Task 7).
- Produces, in `src/core/kitmcp.ts`:
  - `MARKER = "# canopy-kit: managed"`, `OWNED_FILE = ".canopy-kit-mcp.json"`
  - `codexServers(text: string): Record<string, KitMcpEntry> | null` (null when it does not parse)
  - `codexBlocks(text: string): { name: string; start: number; end: number }[]`
  - `codexTable(name: string, entry: KitMcpEntry, marked?: boolean): string`
  - `spliceCodex(text: string, name: string, entry: KitMcpEntry | null, how?: "kit" | "adopt" | "restore"): { text: string } | { error: string }`
  - `STAT_FN` (a POSIX `st()` printing `"<mtime> <size>"`), `inplaceWrite(io, path, stamp, text): Promise<string | null>`
  - `claudeSet(io, claude, name, entry, old): Promise<string | null>`, `claudeRemove(io, claude, name, old): Promise<string | null>`
  - `scrub(text: string, entries: (KitMcpEntry | null)[]): string`
  - `interface McpIO { run: typeof onHost; host: string | null; env?: Record<string, string> }`
- Produces `fakeClaude(dir: string): string` in `src/core/kitfake.ts`.
- `ExecOptions.input?: string`, sent on the child's stdin.

- [ ] **Step 1: Write the failing stdin test**

Add to `src/core/exec.test.ts`:

```ts
test("input goes to the child's stdin, so a file's text never sits in argv", async () => {
  expect(await exec(["cat"], { input: "a\nb $(no)" })).toMatchObject({ code: 0, stdout: "a\nb $(no)" });
  expect(await onHost(null, ["cat"], { input: "x" })).toMatchObject({ code: 0, stdout: "x" });
});
```

Import `onHost` there if the file does not already.

- [ ] **Step 2: Run it to see it fail**

Run: `bun test src/core/exec.test.ts`
Expected: FAIL, stdout is empty (stdin is ignored today).

- [ ] **Step 3: Pass input through**

In `src/core/exec.ts`, add to `ExecOptions`:

```ts
  /** text for the child's stdin; without it stdin is closed */
  input?: string;
```

in `exec`, replace `stdin: "ignore",` with:

```ts
      stdin: opts.input === undefined ? "ignore" : new TextEncoder().encode(opts.input),
```

and in `onHost`, pass it over ssh too (ssh forwards its stdin to the remote command):

```ts
  return exec([...sshArgs(host, sshControlDir()), remoteCommand(cmd)], { timeoutMs: opts.timeoutMs, input: opts.input });
```

Run: `bun test src/core/exec.test.ts`
Expected: PASS.

- [ ] **Step 4: Write the fake claude**

Create `src/core/kitfake.ts`:

```ts
/** A stand-in for the claude CLI, for tests only: it appends its argv to
 *  $FAKE_CLAUDE_LOG as one JSON line and edits $HOME/.claude.json the way
 *  `claude mcp add-json --scope user` and `remove --scope user` do,
 *  refusing an add over an existing name. FAKE_CLAUDE_FAIL=add makes every
 *  add fail with an error that echoes its JSON, as a CLI might. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const SCRIPT = `#!/usr/bin/env bun
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
const file = process.env.HOME + "/.claude.json";
const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
j.mcpServers ??= {};
const at = args.indexOf("--scope");
if (args[0] !== "mcp" || at < 0 || args[at + 1] !== "user") { console.error("usage"); process.exit(2); }
const rest = args.filter((_, i) => i > 1 && i !== at && i !== at + 1);
if (args[1] === "add-json") {
  if (process.env.FAKE_CLAUDE_FAIL === "add") { console.error("Invalid configuration: " + rest[1]); process.exit(1); }
  if (j.mcpServers[rest[0]]) { console.error("MCP server " + rest[0] + " already exists in user config"); process.exit(1); }
  j.mcpServers[rest[0]] = JSON.parse(rest[1]);
} else if (args[1] === "remove") {
  if (!j.mcpServers[rest[0]]) { console.error("No user-scoped MCP server found with name: " + rest[0]); process.exit(1); }
  delete j.mcpServers[rest[0]];
} else { console.error("usage"); process.exit(2); }
fs.writeFileSync(file, JSON.stringify(j, null, 2));
`;

export function fakeClaude(dir: string): string {
  const path = join(dir, "fake-claude");
  writeFileSync(path, SCRIPT, { mode: 0o755 });
  return path;
}
```

If Task 1 found that a second `add-json` on an existing name replaces it instead of failing, keep the fake as it is anyway: `claudeSet` removes first, so it is right either way.

- [ ] **Step 5: Write the failing writer tests**

Create `src/core/kitmcp.test.ts`:

```ts
import { afterEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
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
});

describe("the claude CLI writer", () => {
  function setup() {
    const h = scratch();
    const claude = fakeClaude(h);
    const log = join(h, "argv.log");
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ numStartups: 3, mcpServers: { github: { type: "stdio", command: "bash", args: ["-c", "x"] } } }));
    const io = (fail = false): McpIO => ({ run: onHost, host: null, env: { HOME: h, FAKE_CLAUDE_LOG: log, ...(fail ? { FAKE_CLAUDE_FAIL: "add" } : {}) } });
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
    const why = await claudeSet(io(true), claude, "github", want, old);
    expect(why).toContain("Invalid configuration");
    expect(why).not.toContain("literal-value-0x41");
    expect(servers()["github"]).toEqual(old);
  });
});
```

- [ ] **Step 6: Run them to see them fail**

Run: `bun test src/core/kitmcp.test.ts`
Expected: FAIL, cannot find module `./kitmcp`.

- [ ] **Step 7: Write `src/core/kitmcp.ts`**

```ts
/**
 * The only code that writes an agent's MCP config (phase 2 spec, "Writing
 * the agents' config"). Codex's config.toml is spliced as text, so every
 * byte outside canopy's marked tables stays, and written in place, since
 * ~/.codex is a bind mount on the mini. Claude's servers go through its
 * own CLI, since Claude Code rewrites ~/.claude.json many times a session
 * and on the mini it is a single-file bind mount. Nothing here logs, and
 * an error passes through `scrub` before it leaves.
 */

import type { onHost } from "./exec";
import type { KitMcpEntry } from "./types";

export const MARKER = "# canopy-kit: managed";

/** under ~/.claude: what canopy wrote, and what adopt replaced (KitMcpOwned) */
export const OWNED_FILE = ".canopy-kit-mcp.json";

export interface McpIO {
  run: typeof onHost;
  host: string | null;
  env?: Record<string, string>;
}

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** a [table] header's dotted path with its quotes taken off; null for any other line */
function tomlPath(line: string): string[] | null {
  const m = /^\s*\[([^[\]]*)\]\s*(#.*)?$/.exec(line);
  if (!m) return null;
  const out: string[] = [];
  const re = /\s*(?:"((?:[^"\\]|\\.)*)"|'([^']*)'|([A-Za-z0-9_-]+))\s*(\.|$)/y;
  const s = m[1] ?? "";
  let at = 0;
  while (at < s.length) {
    re.lastIndex = at;
    const p = re.exec(s);
    if (!p) return null;
    out.push(p[1] !== undefined ? (JSON.parse(`"${p[1]}"`) as string) : (p[2] ?? p[3] ?? ""));
    at = re.lastIndex;
    if (p[4] === "") break;
  }
  return out;
}

const under = (p: string[] | null, name: string): boolean => !!p && p.length >= 2 && p[0] === "mcp_servers" && p[1] === name;

/** The servers config.toml defines; null when it does not parse. Bun's
 *  own TOML parser, so the parse error's text (which can quote a line)
 *  never leaves this function. */
export function codexServers(text: string): Record<string, KitMcpEntry> | null {
  try {
    const m = (Bun.TOML.parse(text) as Record<string, unknown>)["mcp_servers"];
    return isObj(m) ? (Object.fromEntries(Object.entries(m).filter(([, v]) => isObj(v))) as Record<string, KitMcpEntry>) : {};
  } catch {
    return null;
  }
}

/** Canopy's tables: the marker line, its [mcp_servers.<name>] header, and
 *  every line up to the next table not under it. Line-based, so a table
 *  header inside a multi-line string would end a block early; canopy
 *  writes no multi-line strings, and the parse check after each splice
 *  catches a broken result. */
export function codexBlocks(text: string): { name: string; start: number; end: number }[] {
  const lines = text.split("\n");
  const out: { name: string; start: number; end: number }[] = [];
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]?.trim() !== MARKER) continue;
    const head = tomlPath(lines[i + 1] ?? "");
    if (!head || head.length !== 2 || head[0] !== "mcp_servers") continue;
    const name = head[1] ?? "";
    let j = i + 2;
    for (; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (l.trim() === MARKER || /^\s*\[\[/.test(l)) break;
      const p = tomlPath(l);
      if (p && !under(p, name)) break;
    }
    while (j > i + 2 && (lines[j - 1] ?? "").trim() === "") j--;
    out.push({ name, start: i, end: j });
    i = j - 1;
  }
  return out;
}

/** a hand-made [mcp_servers.<name>] and its subtables, when they sit together */
function foreignRegion(lines: string[], name: string): { start: number; end: number } | { error: string } | null {
  const start = lines.findIndex((l) => {
    const p = tomlPath(l);
    return under(p, name) && p?.length === 2;
  });
  if (start < 0) return null;
  let end = start + 1;
  for (; end < lines.length; end++) {
    const l = lines[end] ?? "";
    if (l.trim() === MARKER || /^\s*\[\[/.test(l)) break;
    const p = tomlPath(l);
    if (p && !under(p, name)) break;
  }
  while (end > start + 1 && (lines[end - 1] ?? "").trim() === "") end--;
  if (lines.slice(end).some((l) => under(tomlPath(l), name))) return { error: `config.toml splits [mcp_servers.${name}] across the file; adopt it by hand` };
  return { start, end };
}

const tomlKey = (k: string): string => (/^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k));

function tomlValue(v: unknown): string {
  // a JSON string is a TOML basic string, but for DEL, which TOML wants escaped
  if (typeof v === "string") return JSON.stringify(v).replace(/\u007f/g, "\\u007f");
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map(tomlValue).join(", ")}]`;
  if (isObj(v)) return `{ ${Object.entries(v).map(([k, x]) => `${tomlKey(k)} = ${tomlValue(x)}`).join(", ")} }`;
  throw new Error("config.toml takes strings, numbers, booleans, lists and tables");
}

/** one server as TOML: its own table, env and headers as inline tables */
export const codexTable = (name: string, entry: KitMcpEntry, marked = true): string =>
  [...(marked ? [MARKER] : []), `[mcp_servers.${tomlKey(name)}]`, ...Object.entries(entry).map(([k, v]) => `${tomlKey(k)} = ${tomlValue(v)}`)].join("\n");

const append = (text: string, table: string): string[] => {
  const body = text.replace(/\n+$/, "");
  return [...(body === "" ? [] : [body, ""]), ...table.split("\n"), ""];
};

/** The next config.toml. "kit" sets (or, with null, removes) canopy's own
 *  table; "adopt" turns a hand-made one into canopy's in place; "restore"
 *  turns canopy's back into a plain table holding `entry`. */
export function spliceCodex(text: string, name: string, entry: KitMcpEntry | null, how: "kit" | "adopt" | "restore" = "kit"): { text: string } | { error: string } {
  const have = codexServers(text);
  if (have === null) return { error: "config.toml does not parse; left as it is" };
  const lines = text.split("\n");
  const b = codexBlocks(text).find((x) => x.name === name);
  let next: string[];
  if (how === "adopt") {
    if (b || !entry) return { error: `[mcp_servers.${name}] is canopy's already` };
    const r = foreignRegion(lines, name);
    if (!r) return { error: `config.toml has no [mcp_servers.${name}] to adopt` };
    if ("error" in r) return r;
    next = [...lines.slice(0, r.start), ...codexTable(name, entry).split("\n"), ...lines.slice(r.end)];
  } else if (how === "restore") {
    if (!entry) return { error: `nothing to put back for ${name}` };
    if (b) next = [...lines.slice(0, b.start), ...codexTable(name, entry, false).split("\n"), ...lines.slice(b.end)];
    else if (name in have) return { error: `config.toml has a [mcp_servers.${name}] canopy did not write; it is back already` };
    else next = append(text, codexTable(name, entry, false));
  } else if (b) {
    if (entry) next = [...lines.slice(0, b.start), ...codexTable(name, entry).split("\n"), ...lines.slice(b.end)];
    else {
      next = [...lines.slice(0, b.start), ...lines.slice(b.end)];
      // the blank line the append put before the block goes with it
      if (b.start > 0 && next[b.start - 1] === "" && (next[b.start] === "" || next[b.start] === undefined)) next.splice(b.start - 1, 1);
    }
  } else {
    if (!entry) return { text };
    if (name in have) return { error: `config.toml has a [mcp_servers.${name}] canopy did not write; adopt it instead` };
    next = append(text, codexTable(name, entry));
  }
  const out = next.join("\n");
  if (codexServers(out) === null) return { error: "the change would leave config.toml unparseable; left as it is" };
  return { text: out };
}

/** prints "<mtime> <size>", GNU stat first, then BSD's; nothing for a missing file */
export const STAT_FN = String.raw`st() { stat -c '%Y %s' "$1" 2>/dev/null || stat -f '%m %z' "$1" 2>/dev/null; }`;

/** args: the file and the stamp the scan saw ("" for a missing file); the
 *  new text on stdin. Staged beside the file, then copied over it with
 *  cat, so the inode (and a bind mount of it) stays. */
const INPLACE_SCRIPT = `${STAT_FN}
f=$1; want=$2
tmp="$f.canopy-$$"
umask 077
cat > "$tmp" || { rm -f "$tmp"; echo "could not stage the new text"; exit 0; }
if [ "$(st "$f")" != "$want" ]; then rm -f "$tmp"; echo moved; exit 0; fi
cat "$tmp" > "$f" && rm -f "$tmp" && echo ok
`;

export async function inplaceWrite(io: McpIO, path: string, stamp: string, text: string): Promise<string | null> {
  const r = await io.run(io.host, ["sh", "-c", INPLACE_SCRIPT, "kit-write", path, stamp], { env: io.env, input: text, timeoutMs: 30_000 });
  const said = r.stdout.trim();
  if (said === "ok") return null;
  if (said === "moved") return "config.toml changed since the scan; rescan and apply again";
  return said || r.stderr.trim().split("\n")[0] || `the write exited ${r.code}`;
}

/** the strings in an entry that could be values: env and header values, a url, long args */
function sensitive(e: KitMcpEntry | null): string[] {
  if (!e) return [];
  const out: string[] = [];
  for (const k of ["env", "headers", "http_headers"]) {
    const v = e[k];
    if (isObj(v)) for (const x of Object.values(v)) if (typeof x === "string" && x.length >= 4) out.push(x);
  }
  if (typeof e["url"] === "string") out.push(e["url"]);
  if (Array.isArray(e["args"])) for (const a of e["args"]) if (typeof a === "string" && a.length >= 16) out.push(a);
  return out;
}

/** an error line with every such string taken out, since a CLI may echo what it was given */
export const scrub = (text: string, entries: (KitMcpEntry | null)[]): string =>
  entries.flatMap(sensitive).sort((a, b) => b.length - a.length).reduce((t, s) => t.split(s).join("•••"), text);

const firstLine = (s: string): string => s.split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** `claude mcp add-json` refuses a name that exists, so an old entry is
 *  removed first and put back when the add fails */
export async function claudeSet(io: McpIO, claude: string, name: string, entry: KitMcpEntry, old: KitMcpEntry | null): Promise<string | null> {
  const cli = (args: string[]) => io.run(io.host, [claude, "mcp", ...args], { env: io.env, timeoutMs: 60_000 });
  if (old) {
    const r = await cli(["remove", "--scope", "user", name]);
    if (r.code !== 0) return scrub(firstLine(r.stderr), [old]) || `claude mcp remove exited ${r.code}`;
  }
  const r = await cli(["add-json", "--scope", "user", name, JSON.stringify(entry)]);
  if (r.code === 0) return null;
  const why = scrub(firstLine(r.stderr), [entry, old]) || `claude mcp add-json exited ${r.code}`;
  if (old) await cli(["add-json", "--scope", "user", name, JSON.stringify(old)]);
  return why;
}

export async function claudeRemove(io: McpIO, claude: string, name: string, old: KitMcpEntry | null): Promise<string | null> {
  const r = await io.run(io.host, [claude, "mcp", "remove", "--scope", "user", name], { env: io.env, timeoutMs: 60_000 });
  return r.code === 0 ? null : scrub(firstLine(r.stderr), [old]) || `claude mcp remove exited ${r.code}`;
}
```

The splice, adopt and restore code above was run against the first two `spliceCodex` tests while the plan was written. One thing to know: a restored `startup_timeout_sec = 30.0` comes back as `30`, since TOML parsing reads 30.0 as the number 30. Codex reads both as a timeout, and Task 18 checks Codex still starts the server.

- [ ] **Step 8: Run the tests**

Run: `bun test src/core/kitmcp.test.ts src/core/exec.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add src/core/exec.ts src/core/exec.test.ts src/core/kitmcp.ts src/core/kitfake.ts src/core/kitmcp.test.ts
git commit -m "feat(kit): write config.toml in place by splicing marked tables, and Claude's servers through its CLI

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 10: Scanning a machine's MCP config

**Files:**
- Modify: `src/core/kitscan.ts` (new `MCP_SCAN_SCRIPT`, `mcpScanArgs`, `parseMcpScan`, `seeMcp`)
- Test: `src/core/kitscan.test.ts`

**Interfaces:**
- Consumes: `mcpTargets` (Task 7), `codexServers`, `STAT_FN`, `OWNED_FILE` (Task 9), `KitMcpSeen`, `KitMcpFileSeen`, `KitMcpOwned`, `KitMcpFormat`.
- Produces:
  - `mcpScanArgs(kit: KitManifest, machine: string): string[]`
  - `parseMcpScan(stdout: string, formats: Record<string, KitMcpFormat>): KitMcpSeen`
  - `seeMcp(kit, m: { name: string; host: string | null }, opts?: { run?; env? }): Promise<KitMcpSeen | null>` (null when the machine has no MCP target, or the scan did not run)

- [ ] **Step 1: Write the failing tests**

Add to `src/core/kitscan.test.ts` (imports: `parseMcpScan`, `seeMcp` from `./kitscan`; `fakeClaude` from `./kitfake`; `parseKit` from `./kit`; `exec` from `./exec`; and the `node:fs`, `node:os`, `node:path` names the file lacks):

```ts
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
  const kit = () => {
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
      const m = await seeMcp(kit(), { name: "mac", host: null }, { env: { HOME: h, KIT_CLAUDE: claude } });
      expect(m?.claude).toBe(claude);
      expect(m?.ignored).toBe(true);
      expect(m?.wrapper).toBe(true);
      expect(m?.owned).toEqual({ placed: { claude: ["excalidraw"] }, adoptedFrom: { claude: { excalidraw: { command: "old" } } } });
      const [c, x] = m?.files ?? [];
      expect(c).toMatchObject({ agent: "claude", path: join(h, ".claude.json"), exists: true, entries: { excalidraw: { type: "stdio", command: "npx" } }, error: null });
      expect(c?.stamp).toMatch(/^\d+ \d+$/);
      expect(x).toMatchObject({ agent: "codex", entries: { node_repl: { command: "node" } } });
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
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/kitscan.test.ts`
Expected: FAIL, `seeMcp` not exported.

- [ ] **Step 3: Write the scan**

In `src/core/kitscan.ts`, extend the imports with `mcpTargets` from `./kit`, `codexServers, OWNED_FILE, STAT_FN` from `./kitmcp` (kitmcp imports nothing from kitscan, so there is no import cycle), and the types `KitMcpEntry, KitMcpFileSeen, KitMcpFormat, KitMcpOwned, KitMcpSeen`. Then add:

```ts
/** args: `m <agent> <file>` per MCP target. Prints tab lines: C the claude
 *  path (absolute, or empty), I 1 when dotclaude ignores mcp-env/, W 1 when
 *  the wrapper runs, O the ownership file as base64, M agent path stamp
 *  base64 per file (stamp and text empty when it is missing). The text
 *  goes out as base64 on one line, so no value is ever parsed by sh. */
export const MCP_SCAN_SCRIPT = `${EXP}
${STAT_FN}
b64() { base64 < "$1" | tr -d '\\n'; }
abs() { case $1 in /*) [ -x "$1" ] && printf %s "$1";; esac; }
c=$(abs "\${KIT_CLAUDE:-}")
[ -n "$c" ] || c=$(abs "$(command -v claude 2>/dev/null)")
[ -n "$c" ] || c=$(abs "$("\${SHELL:-sh}" -lc 'command -v claude' 2>/dev/null </dev/null)")
[ -n "$c" ] || c=$(abs "$HOME/.local/bin/claude")
printf 'C\\t%s\\n' "$c"
i=0; git -C "$HOME/.claude" check-ignore -q mcp-env/probe.env 2>/dev/null && i=1
printf 'I\\t%s\\n' "$i"
w=0; [ -x "$HOME/.claude/bin/canopy-mcp-env" ] && w=1
printf 'W\\t%s\\n' "$w"
o="$HOME/.claude/${OWNED_FILE}"
[ -f "$o" ] && printf 'O\\t%s\\n' "$(b64 "$o")"
while [ $# -ge 3 ]; do
  a=$2; p=$(exp "$3"); shift 3
  if [ -f "$p" ]; then printf 'M\\t%s\\t%s\\t%s\\t%s\\n' "$a" "$p" "$(st "$p")" "$(b64 "$p")"
  else printf 'M\\t%s\\t%s\\t\\t\\n' "$a" "$p"; fi
done
`;

export const mcpScanArgs = (kit: KitManifest, machine: string): string[] =>
  mcpTargets(kit, machine).flatMap((t) => ["m", t.agent, t.mcp.file]);

const unb64 = (s: string): string => Buffer.from(s, "base64").toString("utf8");
const isObj = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

function ownedOf(text: string): KitMcpOwned {
  try {
    const j = JSON.parse(text) as { placed?: unknown; adoptedFrom?: unknown };
    const placed = isObj(j.placed) ? Object.fromEntries(Object.entries(j.placed).filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, (v as unknown[]).filter((x): x is string => typeof x === "string")])) : {};
    const adoptedFrom = isObj(j.adoptedFrom) ? (Object.fromEntries(Object.entries(j.adoptedFrom).filter(([, v]) => isObj(v))) as KitMcpOwned["adoptedFrom"]) : {};
    return { placed, adoptedFrom };
  } catch {
    return { placed: {}, adoptedFrom: {} };
  }
}

function entriesOf(text: string, format: KitMcpFormat): Record<string, KitMcpEntry> | null {
  if (format === "codex-toml") return codexServers(text);
  try {
    const j = JSON.parse(text) as { mcpServers?: unknown };
    return isObj(j.mcpServers) ? (Object.fromEntries(Object.entries(j.mcpServers).filter(([, v]) => isObj(v))) as Record<string, KitMcpEntry>) : {};
  } catch {
    return null;
  }
}

/** Everything stays in memory: the result goes to KitHub, never to KitInfo. */
export function parseMcpScan(stdout: string, formats: Record<string, KitMcpFormat>): KitMcpSeen {
  const seen: KitMcpSeen = { claude: null, ignored: false, wrapper: false, owned: { placed: {}, adoptedFrom: {} }, files: [] };
  for (const line of stdout.split("\n")) {
    const f = line.split("\t");
    switch (f[0]) {
      case "C": seen.claude = f[1]?.startsWith("/") ? f[1] : null; break;
      case "I": seen.ignored = f[1] === "1"; break;
      case "W": seen.wrapper = f[1] === "1"; break;
      case "O": seen.owned = ownedOf(unb64(f[1] ?? "")); break;
      case "M": {
        const agent = f[1] ?? "";
        const format = formats[agent];
        if (!format) break;
        const exists = (f[3] ?? "") !== "";
        const text = exists ? unb64(f[4] ?? "") : "";
        const entries = exists ? entriesOf(text, format) : {};
        const file: KitMcpFileSeen = { agent, path: f[2] ?? "", stamp: f[3] ?? "", exists, text, entries, error: entries === null ? `${format === "claude-json" ? "~/.claude.json" : "config.toml"} does not parse` : null };
        seen.files.push(file);
        break;
      }
    }
  }
  return seen;
}

export async function seeMcp(
  kit: KitManifest,
  m: { name: string; host: string | null },
  opts: { run?: typeof onHost; env?: Record<string, string> } = {},
): Promise<KitMcpSeen | null> {
  const ts = mcpTargets(kit, m.name);
  if (ts.length === 0) return null;
  const run = opts.run ?? onHost;
  const r = await run(m.host, ["sh", "-c", MCP_SCAN_SCRIPT, "kit-mcp-scan", ...mcpScanArgs(kit, m.name)], { env: opts.env, timeoutMs: SCAN_TIMEOUT });
  if (r.code !== 0) return null;
  return parseMcpScan(r.stdout, Object.fromEntries(ts.map((t) => [t.agent, t.mcp.format])));
}
```

The `EXP` helper is already in this file. `SHELL -lc` runs with stdin from `/dev/null`, so a login shell can never wait on a prompt; on the Mac it finds `~/.local/bin/claude` from the login profile even though `claude` is a zsh function in interactive shells.

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/kitscan.test.ts && bun run typecheck && bun run lint`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/kitscan.ts src/core/kitscan.test.ts
git commit -m "feat(kit): scan each machine's claude path, MCP files and ownership file into memory

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 11: Applying MCP actions, adopt and put back

**Files:**
- Modify: `src/core/kitmcp.ts` (new `applyMcp`, `OWNED_WRITE`)
- Modify: `src/core/kitapply.ts` (`applyKit` routes MCP actions to `applyMcp`)
- Test: `src/core/kitmcp.test.ts`

**Interfaces:**
- Consumes: `isMcpAction` (Task 7), the writers and `OWNED_FILE` (Task 9), `KitMcpSeen` and `MCP_SCAN_SCRIPT` (Task 10).
- Produces:
  - `applyMcp(mcp: KitMcpSeen, home: string, actions: KitMcpAction[], entries: Record<string, KitMcpEntry>, formats: Record<string, KitMcpFormat>, io: McpIO): Promise<{ done: KitAction[]; failed: { action: KitAction; why: string }[] }>`, where `home` is the machine's own `$HOME` (the scan's `H` line)
  - `applyKit(seen, host, actions, opts: { run?; env?; mcp?: { seen: KitMcpSeen; entries: Record<string, KitMcpEntry>; formats: Record<string, KitMcpFormat> } })`

- [ ] **Step 1: Write the failing tests**

Add to `src/core/kitmcp.test.ts` (extend the imports: `applyMcp` from `./kitmcp`, `MCP_SCAN_SCRIPT, parseMcpScan` from `./kitscan`, `applyKit` from `./kitapply`, `type KitMcpSeen, type KitSeen` from `./types`, and `mkdirSync` from `node:fs`):

```ts
describe("applyMcp", () => {
  const HAND = { type: "stdio", command: "bash", args: ["-c", "GITHUB_PERSONAL_ACCESS_TOKEN=$(gh auth token) exec bunx -y @modelcontextprotocol/server-github"] };
  const KIT_GH = { type: "stdio", command: "/h/.claude/bin/canopy-mcp-env", args: ["github", "--", "bunx", "-y", "@modelcontextprotocol/server-github"] };
  const FORMATS = { claude: "claude-json", codex: "codex-toml" } as const;

  async function machine(): Promise<{ h: string; io: McpIO; rescan: () => Promise<KitMcpSeen> }> {
    const h = scratch();
    const claude = fakeClaude(h);
    mkdirSync(join(h, ".claude"));
    mkdirSync(join(h, ".codex"));
    writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { github: HAND } }));
    writeFileSync(join(h, ".codex", "config.toml"), ORIG);
    const io: McpIO = { run: onHost, host: null, env: { HOME: h, KIT_CLAUDE: claude } };
    const rescan = async () => {
      const r = await exec(["sh", "-c", MCP_SCAN_SCRIPT, "s", "m", "claude", "~/.claude.json", "m", "codex", "~/.codex/config.toml"], { env: io.env });
      return parseMcpScan(r.stdout, FORMATS);
    };
    return { h, io, rescan };
  }
  const servers = (h: string) => (JSON.parse(readFileSync(join(h, ".claude.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;
  const owned = (h: string) => JSON.parse(readFileSync(join(h, ".claude", ".canopy-kit-mcp.json"), "utf8")) as unknown;

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
    expect(statSync(join(h, ".claude", ".canopy-kit-mcp.json")).mode & 0o777).toBe(0o600);
  });

  test("adopt keeps the hand-made entry, and put back restores it exactly", async () => {
    const { h, io, rescan } = await machine();
    const adopt = await applyMcp(await rescan(), h, [{ kind: "mcp-adopt", agent: "claude", name: "github" }], { "claude/github": KIT_GH }, FORMATS, io);
    expect(adopt.failed).toEqual([]);
    expect(servers(h)["github"]).toEqual(KIT_GH);
    expect(owned(h)).toEqual({ placed: { claude: ["github"] }, adoptedFrom: { claude: { github: HAND } } });
    const back = await applyMcp(await rescan(), h, [{ kind: "mcp-restore", agent: "claude", name: "github" }], {}, FORMATS, io);
    expect(back.failed).toEqual([]);
    expect(servers(h)["github"]).toEqual(HAND);
    expect(owned(h)).toEqual({ placed: { claude: [] }, adoptedFrom: { claude: {} } });
  });

  test("a config.toml that moved fails its actions and records nothing for them (review focus 4)", async () => {
    const { h, io, rescan } = await machine();
    const seen = await rescan();
    appendFileSync(join(h, ".codex", "config.toml"), "# codex wrote this\n");
    const r = await applyMcp(seen, h, [{ kind: "mcp-set", agent: "codex", name: "wiki-memory" }], { "codex/wiki-memory": { command: "bash" } }, FORMATS, io);
    expect(r.failed.map((f) => f.why)).toEqual(["config.toml changed since the scan; rescan and apply again"]);
    expect(readFileSync(join(h, ".codex", "config.toml"), "utf8")).toBe(`${ORIG}# codex wrote this\n`);
  });

  test("applyKit sends skills to the skills script and MCP actions here, in one result", async () => {
    const { h, io, rescan } = await machine();
    mkdirSync(join(h, ".claude", "skills"));
    const seen: KitSeen = { machine: "mac", at: 1, away: null, home: h, store: null, targets: [{ agent: "claude", dir: join(h, ".claude", "skills"), exists: true, parentExists: true, entries: [], placed: {} }], sources: {} };
    const r = await applyKit(seen, null, [{ kind: "mcp-set", agent: "claude", name: "excalidraw" }], { env: io.env, mcp: { seen: await rescan(), entries: { "claude/excalidraw": { command: "npx" } }, formats: FORMATS } });
    expect(r).toEqual({ machine: "mac", done: [{ kind: "mcp-set", agent: "claude", name: "excalidraw" }], failed: [] });
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/core/kitmcp.test.ts`
Expected: FAIL, `applyMcp` not exported.

- [ ] **Step 3: Write `applyMcp`**

Append to `src/core/kitmcp.ts` (extend the type import with `KitAction, KitMcpAction, KitMcpFormat, KitMcpSeen`):

```ts
/** writes ~/.claude/.canopy-kit-mcp.json from stdin, 0600; ~/.claude is a
 *  folder mount, so a rename inside it is safe on the mini */
const OWNED_WRITE = `f=$1
umask 077
cat > "$f.tmp-$$" && mv -f "$f.tmp-$$" "$f" && chmod 600 "$f" && echo ok`;

type Failed = { action: KitAction; why: string };

/** Carry out MCP actions on one machine. Claude's go one by one through
 *  its CLI; each Codex file is spliced in memory and written once, so a
 *  file that moved fails every action on it and changes nothing. The
 *  ownership file is written last, from what was done. */
export async function applyMcp(mcp: KitMcpSeen, home: string, actions: KitMcpAction[], entries: Record<string, KitMcpEntry>, formats: Record<string, KitMcpFormat>, io: McpIO): Promise<{ done: KitAction[]; failed: Failed[] }> {
  const done: KitAction[] = [];
  const failed: Failed[] = [];
  const placed: Record<string, string[]> = structuredClone(mcp.owned.placed);
  const adoptedFrom: KitMcpSeen["owned"]["adoptedFrom"] = structuredClone(mcp.owned.adoptedFrom);
  const codex = new Map<string, { text: string; actions: KitMcpAction[]; owned: (() => void)[] }>();
  const own = (agent: string, name: string, on: boolean) => {
    const p = (placed[agent] ??= []).filter((n) => n !== name);
    placed[agent] = on ? [...p, name].sort() : p;
  };

  for (const a of actions) {
    const file = mcp.files.find((f) => f.agent === a.agent);
    const format = formats[a.agent];
    if (!file || !format || file.entries === null) {
      failed.push({ action: a, why: file?.error ?? `${a.agent} has no MCP file here` });
      continue;
    }
    const current = file.entries[a.name] ?? null;
    const want = entries[`${a.agent}/${a.name}`] ?? null;
    const before = adoptedFrom[a.agent]?.[a.name] ?? null;
    if ((a.kind === "mcp-set" || a.kind === "mcp-adopt") && !want) {
      failed.push({ action: a, why: "nothing to write for it; rescan" });
      continue;
    }
    if (a.kind === "mcp-adopt" && !current) {
      failed.push({ action: a, why: "no hand-made entry to adopt; rescan" });
      continue;
    }
    if (a.kind === "mcp-restore" && !before) {
      failed.push({ action: a, why: "canopy keeps no hand-made entry for it" });
      continue;
    }
    const record = () => {
      if (a.kind === "mcp-set") own(a.agent, a.name, true);
      else if (a.kind === "mcp-remove") own(a.agent, a.name, false);
      else if (a.kind === "mcp-adopt" && current) {
        own(a.agent, a.name, true);
        (adoptedFrom[a.agent] ??= {})[a.name] = current;
      } else if (a.kind === "mcp-restore") {
        own(a.agent, a.name, false);
        delete (adoptedFrom[a.agent] ??= {})[a.name];
      }
    };
    if (format === "claude-json") {
      if (!mcp.claude) {
        failed.push({ action: a, why: "no claude binary found here" });
        continue;
      }
      const why =
        a.kind === "mcp-remove" ? (current ? await claudeRemove(io, mcp.claude, a.name, current) : null)
        : a.kind === "mcp-restore" ? await claudeSet(io, mcp.claude, a.name, before ?? {}, current)
        : await claudeSet(io, mcp.claude, a.name, want ?? {}, current);
      if (why) failed.push({ action: a, why });
      else {
        record();
        done.push(a);
      }
      continue;
    }
    const c = codex.get(file.path) ?? { text: file.text, actions: [], owned: [] };
    codex.set(file.path, c);
    const how = a.kind === "mcp-adopt" ? "adopt" : a.kind === "mcp-restore" ? "restore" : "kit";
    const next = spliceCodex(c.text, a.name, a.kind === "mcp-remove" ? null : a.kind === "mcp-restore" ? before : want, how);
    if ("error" in next) {
      failed.push({ action: a, why: next.error });
      continue;
    }
    c.text = next.text;
    c.actions.push(a);
    c.owned.push(record);
  }

  for (const [path, c] of codex) {
    if (c.actions.length === 0) continue;
    const file = mcp.files.find((f) => f.path === path);
    const why = await inplaceWrite(io, path, file?.stamp ?? "", c.text);
    if (why) for (const a of c.actions) failed.push({ action: a, why });
    else {
      for (const r of c.owned) r();
      done.push(...c.actions);
    }
  }

  if (done.length > 0) {
    const r = await io.run(io.host, ["sh", "-c", OWNED_WRITE, "kit-owned", `${home}/.claude/${OWNED_FILE}`], {
      env: io.env, input: `${JSON.stringify({ placed, adoptedFrom }, null, 2)}\n`, timeoutMs: 30_000,
    });
    if (r.stdout.trim() !== "ok") {
      const why = `written, but ~/.claude/${OWNED_FILE} was not: ${r.stderr.trim().split("\n")[0] || `exited ${r.code}`}`;
      return { done: [], failed: [...failed, ...done.map((action) => ({ action, why }))] };
    }
  }
  return { done, failed };
}
```

- [ ] **Step 4: Route MCP actions from `applyKit`**

In `src/core/kitapply.ts`, import `applyMcp` from `./kitmcp` and the types `KitMcpAction, KitMcpEntry, KitMcpFormat, KitMcpSeen`, and replace `applyKit` with:

```ts
export async function applyKit(
  seen: KitSeen,
  host: string | null,
  actions: KitAction[],
  opts: { run?: typeof onHost; env?: Record<string, string>; mcp?: { seen: KitMcpSeen; entries: Record<string, KitMcpEntry>; formats: Record<string, KitMcpFormat> } } = {},
): Promise<KitApplyResult> {
  const run = opts.run ?? onHost;
  const done: KitAction[] = [];
  const failed: KitApplyResult["failed"] = [];
  const skills = actions.filter((a) => !isMcpAction(a));
  const servers = actions.filter(isMcpAction);
  if (skills.length > 0) {
    const r = await run(host, ["sh", "-c", APPLY_SCRIPT, "kit-apply", ...applyArgs(seen, skills)], { env: opts.env, timeoutMs: 120_000 });
    const lines = r.stdout.split("\n");
    skills.forEach((a, i) => {
      const line = lines.find((l) => l === `ok ${i}` || l.startsWith(`err ${i} `));
      if (line === `ok ${i}`) done.push(a);
      else failed.push({ action: a, why: line ? line.slice(`err ${i} `.length) : (r.stderr.trim() || `exited ${r.code}`) });
    });
    const placed = nextPlaced(seen, done);
    const words: string[] = [];
    for (const [agent, p] of Object.entries(placed)) words.push(dirOf(seen, agent), JSON.stringify({ placed: p }));
    if (words.length) await run(host, ["sh", "-c", PLACED_SCRIPT, "kit-placed", ...words], { env: opts.env, timeoutMs: 30_000 });
  }
  if (servers.length > 0) {
    if (!opts.mcp) for (const a of servers) failed.push({ action: a, why: "no MCP scan for this machine; rescan" });
    else {
      const r = await applyMcp(opts.mcp.seen, seen.home, servers as KitMcpAction[], opts.mcp.entries, opts.mcp.formats, { run, host, env: opts.env });
      done.push(...r.done);
      failed.push(...r.failed);
    }
  }
  return { machine: seen.machine, done, failed };
}
```

`seen.home` is the scan's `$HOME` on that machine (the container's `/home/bun` on the mini, where `~/.claude` is the same folder as the host's).

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/kitmcp.test.ts src/core/kitapply.test.ts && bun run typecheck && bun run lint`
Expected: PASS. The adopt test is the put-back check: the `bash -c gh auth token` entry comes back byte for byte as JSON.

- [ ] **Step 6: Commit**

```bash
git add src/core/kitmcp.ts src/core/kitmcp.test.ts src/core/kitapply.ts
git commit -m "feat(kit): apply MCP set, remove, adopt and put back, with ownership recorded last

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 12: KitHub: MCP scans, allowances from the store, adopt, put back and the preview

**Files:**
- Modify: `src/core/types.ts` (`KitMachineView.home?`, `KitInfo.mcp?`, new `KitMcpView`, `KitMcpPreview`)
- Modify: `src/server/kit.ts`
- Modify: `src/server/index.ts` (the `KitHub` and `createSecretsHub` wiring near line 4254)
- Modify: `src/cli/kit.ts` (`PROBLEMS`)
- Test: `src/server/kit.test.ts`, `src/cli/kit.test.ts`

**Interfaces:**
- Consumes: `mcpHash`, `mcpDefOf`, `hasSecrets`, `secretsOf`, `planKit`, `cellsOf`, `planMcp`, `maskEntry`, `mcpTargets`, `mcpWanted` (Tasks 3, 6, 7); `seeMcp` (Task 10); `applyKit` with `mcp` (Task 11).
- Produces:
  - `KitHubDeps.secrets?: () => Promise<SecretsInfo | null>`, `KitHubDeps.hostHome?: string`, `KitHubDeps.procEnv?: Record<string, string | undefined>`
  - `KitHub.republish(): Promise<void>`, `KitHub.adopt(machine, agent, names?)`, `KitHub.restore(machine, agent, name)`, `KitHub.preview(machine, agent, name): KitMcpPreview`
  - `POST /api/kit/adopt {machine, agent, names?}`, `POST /api/kit/restore {machine, agent, name}`, `GET /api/kit/preview?machine=&agent=&name=`
  - `KitMcpView { name; def: KitMcpDef; hash; env: Record<string, string>; headers: Record<string, string>; machines: string[]; later: string[] }`
  - `KitMcpPreview { state: KitCellState; why: string; have: KitMcpEntry | null; want: KitMcpEntry | null }` (both entries masked)

- [ ] **Step 1: Add the types**

In `src/core/types.ts`, add to `KitMachineView` after `plan`:

```ts
  /** the home ~ stands for in what the kit writes there (phase 2); the mcp-allow act's homes come from here */
  home?: string;
```

add to `KitInfo` after `cells`:

```ts
  /** the servers with secrets, for the allow sheet (phase 2) */
  mcp?: KitMcpView[];
```

and after `KitMcpCtx`:

```ts
/** one server with secrets as the allow sheet shows it: names and the hash, never a value */
export interface KitMcpView {
  name: string;
  def: KitMcpDef;
  hash: string;
  /** env name to secret name */
  env: Record<string, string>;
  /** header name to secret name */
  headers: Record<string, string>;
  /** the machines it is placed on that an allowance covers now */
  machines: string[];
  /** the machines it is placed on that wait for secrets phase 3 (ssh machines: gpd) */
  later: string[];
}

/** what adopt would change, masked */
export interface KitMcpPreview {
  state: KitCellState;
  why: string;
  have: KitMcpEntry | null;
  want: KitMcpEntry | null;
}
```

- [ ] **Step 2: Write the failing hub tests**

Add to `src/server/kit.test.ts` (imports: `fakeClaude` from `../core/kitfake`, `mcpHash` from `../core/kit`, `readFileSync` from `node:fs`, and the types `SecretsInfo`, `KitMcpPreview`):

```ts
const HAND = { type: "stdio", command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "hand-literal-0x6b" } };
const GH_DEF = { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] };
const MCP_MANIFEST = {
  version: 1,
  machines: { mac: { backend: "mac" } },
  targets: [
    { agent: "claude", skills: "~/.claude/skills", mode: "store", mcp: { file: "~/.claude.json", format: "claude-json" } },
    { agent: "codex", skills: "~/.codex/skills", mode: "link", mcp: { file: "~/.codex/config.toml", format: "codex-toml" } },
  ],
  skills: {},
  mcp: {
    github: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:gh_token}" } },
    excalidraw: { command: "npx", args: ["-y", "excalidraw-render"], agents: ["claude"] },
  },
};

function storeInfo(allow: string[]): SecretsInfo {
  const meta = { description: "", tags: [], created: "2026-10-14T12:00:00.000Z", rotated: "2026-10-14T12:00:00.000Z", to: ["mac", "mini"], usedBy: ["mcp-github-mac"] };
  return {
    ok: true, error: null, backend: "mac", role: "reader", head: "abc", refused: null, lock: "open", recipient: null,
    secrets: [{ name: "gh_token", allow, ...meta }],
    sinks: [{ id: "mcp-github-mac", machine: "mac", path: "/x", format: "dotenv", keys: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, state: { GITHUB_PERSONAL_ACCESS_TOKEN: "same" }, error: null }],
    proposals: [], passkeys: [], session: false, firstPasskey: false, gate: "", unpushed: 0,
  };
}

async function setupMcp() {
  const h = mkdtempSync(join(tmpdir(), "kithub-mcp-"));
  dirs.push(h);
  const store = join(h, ".claude");
  await exec(["git", "init", "-q", "-b", "main", store]);
  mkdirSync(join(store, "skills"), { recursive: true });
  mkdirSync(join(store, "bin"));
  writeFileSync(join(store, "bin", "canopy-mcp-env"), "#!/bin/sh\n", { mode: 0o755 });
  writeFileSync(join(store, ".gitignore"), "mcp-env/\n.canopy-kit-mcp.json\n");
  mkdirSync(join(h, ".codex", "skills"), { recursive: true });
  writeFileSync(join(h, ".codex", "config.toml"), "");
  writeFileSync(join(h, ".claude.json"), JSON.stringify({ mcpServers: { github: HAND } }));
  const kitPath = join(store, "kit.json");
  writeFileSync(kitPath, JSON.stringify(MCP_MANIFEST));
  let secrets = storeInfo([]);
  const events: ServerEvent[] = [];
  const hub = new KitHub({
    self: "mac", devRoot: join(h, "dev"), kitPath, broadcast: (e) => events.push(e), env: { HOME: h, KIT_CLAUDE: fakeClaude(h) }, every: 0,
    secrets: async () => secrets, hostHome: h, procEnv: {},
  });
  hubs.push(hub);
  const allow = async () => {
    secrets = storeInfo([`mcp:github#${await mcpHash(GH_DEF)}`, "sink:mcp-github-mac"]);
  };
  const route = async (method: string, path: string, body?: unknown) => {
    const res = await hub.handle(new Request(`http://x${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) }), new URL(`http://x${path}`));
    if (!res) throw new Error(`${path} not handled`);
    return { status: res.status, text: await res.text() };
  };
  const claudeServers = () => (JSON.parse(readFileSync(join(h, ".claude.json"), "utf8")) as { mcpServers: Record<string, unknown> }).mcpServers;
  return { h, hub, events, allow, route, claudeServers };
}

describe("KitHub and MCP servers", () => {
  test("cells and plans carry servers; KitInfo holds no raw entry; the allow sheet gets names and the hash", async () => {
    const { hub, events } = await setupMcp();
    const info = await hub.scan();
    const cell = (agent: string, name: string) => info.cells.find((c) => c.kind === "mcp" && c.agent === agent && c.skill === name);
    expect(cell("claude", "github")?.state).toBe("not-allowed");
    expect(cell("claude", "excalidraw")?.state).toBe("missing");
    expect(info.machines[0]?.plan).toContainEqual({ kind: "mcp-set", agent: "claude", name: "excalidraw" });
    expect(info.machines[0]?.home).toBeTruthy();
    expect(info.mcp).toEqual([{ name: "github", def: GH_DEF, hash: await mcpHash(GH_DEF), env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, machines: ["mac"], later: [] }]);
    expect(JSON.stringify(info)).not.toContain("hand-literal-0x6b");
    expect(JSON.stringify(events)).not.toContain("hand-literal-0x6b");
  });

  test("an allowance landing in the store republishes the kit, and only then can github be adopted (review focus 1)", async () => {
    const { hub, allow, route, claudeServers } = await setupMcp();
    await hub.scan();
    const early = await route("POST", "/api/kit/adopt", { machine: "mac", agent: "claude", names: ["github"] });
    expect(early.status).toBe(409);
    expect(early.text).toContain("not allowed");
    await allow();
    await hub.republish();
    expect(hub.info().cells.find((c) => c.agent === "claude" && c.skill === "github")?.state).toBe("adoptable");
    const r = await route("POST", "/api/kit/adopt", { machine: "mac", agent: "claude", names: ["github"] });
    expect(r.status).toBe(200);
    expect(claudeServers()["github"]).toMatchObject({ command: expect.stringContaining("/.claude/bin/canopy-mcp-env"), args: ["github", "--", "bunx", "-y", "@modelcontextprotocol/server-github"] });
    expect(hub.info().cells.find((c) => c.agent === "claude" && c.skill === "github")).toMatchObject({ state: "ok", restore: true });
    expect((await route("POST", "/api/kit/restore", { machine: "mac", agent: "claude", name: "github" })).status).toBe(200);
    expect(claudeServers()["github"]).toEqual(HAND);
  });

  test("the preview masks the hand-made entry's values (review focus 3)", async () => {
    const { hub, allow, route } = await setupMcp();
    await allow();
    await hub.scan();
    const r = await route("GET", "/api/kit/preview?machine=mac&agent=claude&name=github");
    expect(r.status).toBe(200);
    const p = JSON.parse(r.text) as KitMcpPreview;
    expect(p.state).toBe("adoptable");
    expect(p.have).toMatchObject({ env: { GITHUB_PERSONAL_ACCESS_TOKEN: "•••" } });
    expect(p.want).toMatchObject({ args: ["github", "--", "bunx", "-y", "@modelcontextprotocol/server-github"] });
    expect(r.text).not.toContain("hand-literal-0x6b");
  });

  test("apply all writes what it plans and never adopts", async () => {
    const { hub, allow, route, claudeServers } = await setupMcp();
    await allow();
    await hub.scan();
    const r = JSON.parse((await route("POST", "/api/kit/apply", { machine: "mac" })).text) as KitApplyResult;
    expect(r.done.map((a) => a.kind)).not.toContain("mcp-adopt");
    expect(claudeServers()["github"]).toEqual(HAND);
    expect(claudeServers()["excalidraw"]).toEqual({ type: "stdio", command: "npx", args: ["-y", "excalidraw-render"] });
  });
});
```

`KitApplyResult` joins the type import if it is not there.

- [ ] **Step 3: Run them to see them fail**

Run: `bun test src/server/kit.test.ts`
Expected: FAIL, no `kind: "mcp"` cells, and `republish` is not a function.

- [ ] **Step 4: Grow KitHub**

In `src/server/kit.ts`:

1. Imports become:

```ts
import { cellsOf, hasSecrets, mcpDefOf, mcpHash, mcpTargets, mcpWanted, maskEntry, parseKit, planKit, planMcp, secretsOf } from "../core/kit";
import { applyKit } from "../core/kitapply";
import { seeKit, seeMcp } from "../core/kitscan";
import type {
  KitAction, KitApplyResult, KitInfo, KitManifest, KitMachineView, KitMcpCtx, KitMcpEntry, KitMcpFormat, KitMcpPreview, KitMcpSeen, KitMcpView, KitSeen, SecretsInfo, ServerEvent,
} from "../core/types";
```

2. Add to `KitHubDeps`:

```ts
  /** the store's metadata as this backend sees it (SecretsHub.info(null)); absent: no store here */
  secrets?: () => Promise<SecretsInfo | null>;
  /** the home ~ stands for in what the kit writes on this backend's own machine: the mini's canopy runs as /home/bun but writes for /home/eric */
  hostHome?: string;
  /** where ${env:NAME} resolves; this process's environment by default */
  procEnv?: Record<string, string | undefined>;
```

3. Replace the `views` field with:

```ts
  private views = new Map<string, { seen: KitSeen; dev: string; mcp: KitMcpSeen | null; ssh: boolean }>();
  private hashes: Record<string, string> = {};
  /** per machine, every entry the kit would write there; never leaves this process */
  private entries = new Map<string, Record<string, KitMcpEntry>>();
  private mcpSeen = new Map<string, KitMcpSeen>();
```

4. In `doScan`, right after `this.kit = kit;`:

```ts
    this.hashes = Object.fromEntries(await Promise.all(kit.mcp.map(async (s) => [s.name, await mcpHash(mcpDefOf(s))] as const)));
```

and in the error branch, also `this.entries.clear(); this.mcpSeen.clear();`.

5. Replace `scanOne` and `publish` with:

```ts
  private async scanOne(kit: KitManifest, m: Mine): Promise<void> {
    // a throw here would reject the scan, and nothing awaits the timer's
    // scans: an unhandled rejection ends the server
    const seen = await seeKit(kit, m, { run: this.deps.run, env: this.deps.env, now: this.deps.now }).catch(
      (err: unknown): KitSeen => ({ machine: m.name, at: (this.deps.now ?? Date.now)(), away: err instanceof Error ? err.message : String(err), home: "", store: null, targets: [], sources: {} }),
    );
    // after the skills scan, so an ssh machine that is away is not waited on twice
    const mcp = seen.away ? null : await seeMcp(kit, m, { run: this.deps.run, env: this.deps.env }).catch(() => null);
    this.views.set(m.name, { seen, dev: m.dev, mcp, ssh: m.host !== null });
    await this.publish(kit);
  }

  /** the store's metadata changed (a `secrets` event): plans and cells follow without a rescan */
  async republish(): Promise<void> {
    if (this.kit) await this.publish(this.kit);
  }

  private ctxOf(v: { seen: KitSeen; mcp: KitMcpSeen | null; ssh: boolean }, secrets: SecretsInfo | null): KitMcpCtx | undefined {
    if (!v.mcp) return undefined;
    const home = v.ssh ? v.seen.home : (this.deps.hostHome ?? v.seen.home);
    return { mcp: v.mcp, hashes: this.hashes, secrets, home, env: this.deps.procEnv ?? process.env, ssh: v.ssh };
  }

  private mcpViews(kit: KitManifest): KitMcpView[] {
    const placedOn = (name: string) => kit.machines.filter((m) => mcpTargets(kit, m.name).some((t) => mcpWanted(kit.mcp.find((s) => s.name === name)!, t.agent, m.name)));
    return kit.mcp.filter(hasSecrets).map((s) => ({
      name: s.name, def: mcpDefOf(s), hash: this.hashes[s.name] ?? "", ...secretsOf(s),
      machines: placedOn(s.name).filter((m) => !m.ssh).map((m) => m.name),
      later: placedOn(s.name).filter((m) => m.ssh).map((m) => m.name),
    }));
  }

  private async publish(kit: KitManifest): Promise<void> {
    const secrets = this.deps.secrets ? await this.deps.secrets().catch(() => null) : null;
    const vs = this.mine(kit).map((m) => this.views.get(m.name)).filter((v): v is NonNullable<typeof v> => !!v);
    const machines: KitMachineView[] = [];
    const cellViews: { seen: KitSeen; dev: string; ctx?: KitMcpCtx }[] = [];
    for (const v of vs) {
      const ctx = this.ctxOf(v, secrets);
      if (ctx) {
        this.entries.set(v.seen.machine, planMcp(kit, v.seen, ctx).entries);
        this.mcpSeen.set(v.seen.machine, ctx.mcp);
      } else {
        this.entries.delete(v.seen.machine);
        this.mcpSeen.delete(v.seen.machine);
      }
      machines.push({ machine: v.seen.machine, seen: v.seen, plan: planKit(kit, v.seen, v.dev, ctx), home: ctx?.home ?? v.seen.home });
      cellViews.push({ seen: v.seen, dev: v.dev, ctx });
    }
    this.last = { ok: true, error: null, machines, cells: cellsOf(kit, cellViews), mcp: this.mcpViews(kit) };
    this.deps.broadcast({ type: "kit", kit: this.last });
  }
```

6. Replace `apply` with these, sharing the checks:

```ts
  private reach(machine: string): { kit: KitManifest; view: KitMachineView; m: Mine } {
    if (!this.kit) throw new KitError(this.last.error ?? "kit.json not read", 409);
    const view = this.last.machines.find((x) => x.machine === machine);
    if (!view) throw new KitError(`not a machine this backend reaches: ${machine}`, 400);
    if (view.seen.away) throw new KitError(`${machine} is away: ${view.seen.away}`, 409);
    const m = this.mine(this.kit).find((x) => x.name === machine);
    if (!m) throw new KitError(`not a machine this backend reaches: ${machine}`, 400);
    return { kit: this.kit, view, m };
  }

  private async execute(machine: string, todo: KitAction[]): Promise<KitApplyResult> {
    const { kit, view, m } = this.reach(machine);
    const seen = this.mcpSeen.get(machine);
    const formats: Record<string, KitMcpFormat> = Object.fromEntries(mcpTargets(kit, machine).map((t) => [t.agent, t.mcp.format]));
    const r = await applyKit(view.seen, m.host, todo, {
      run: this.deps.run, env: this.deps.env,
      mcp: seen ? { seen, entries: this.entries.get(machine) ?? {}, formats } : undefined,
    });
    await this.scanOne(kit, m);
    return r;
  }

  async apply(machine: string, actions?: KitAction[], dryRun = false): Promise<KitApplyResult> {
    const { view } = this.reach(machine);
    const planned = new Set(view.plan.map((a) => JSON.stringify(a)));
    if (actions && !actions.every((a) => planned.has(JSON.stringify(a)))) throw new KitError("an action is not in the current plan; rescan first", 409);
    const todo = actions ?? view.plan;
    if (dryRun) return { machine, done: todo, failed: [] };
    return this.execute(machine, todo);
  }

  private mcpCell(machine: string, agent: string, name: string) {
    return this.last.cells.find((c) => c.kind === "mcp" && c.machine === machine && c.agent === agent && c.skill === name);
  }

  /** Adopt hand-made entries the kit defines. Only an adoptable cell
   *  qualifies: a server with secrets is adoptable once its allowance
   *  and sink let the kit's version be written, so adopt never leaves a
   *  working server replaced by nothing (phase 2 plan, call 10). */
  async adopt(machine: string, agent: string, names?: string[]): Promise<KitApplyResult> {
    this.reach(machine);
    const all = this.last.cells.filter((c) => c.kind === "mcp" && c.machine === machine && c.agent === agent);
    const pick = names ?? all.filter((c) => c.state === "adoptable").map((c) => c.skill);
    if (pick.length === 0) throw new KitError(`nothing to adopt for ${agent} on ${machine}`, 409);
    for (const n of pick) {
      const c = this.mcpCell(machine, agent, n);
      if (c?.state !== "adoptable") throw new KitError(`${n} cannot be adopted: ${c ? c.why || c.state : "the kit has no such server here"}`, 409);
    }
    return this.execute(machine, pick.map((name): KitAction => ({ kind: "mcp-adopt", agent, name })));
  }

  async restore(machine: string, agent: string, name: string): Promise<KitApplyResult> {
    this.reach(machine);
    if (!this.mcpCell(machine, agent, name)?.restore) throw new KitError(`canopy keeps no hand-made ${name} for ${agent} on ${machine}`, 409);
    return this.execute(machine, [{ kind: "mcp-restore", agent, name }]);
  }

  preview(machine: string, agent: string, name: string): KitMcpPreview {
    this.reach(machine);
    const c = this.mcpCell(machine, agent, name);
    if (!c) throw new KitError(`no server ${name} for ${agent} on ${machine}`, 404);
    const have = this.mcpSeen.get(machine)?.files.find((f) => f.agent === agent)?.entries?.[name] ?? null;
    const want = this.entries.get(machine)?.[`${agent}/${name}`] ?? null;
    return { state: c.state, why: c.why, have: have ? maskEntry(have) : null, want: want ? maskEntry(want) : null };
  }
```

7. In `handle`, add after the apply route:

```ts
      if (path === "/api/kit/preview" && req.method === "GET") {
        const q = url.searchParams;
        return json(this.preview(q.get("machine") ?? "", q.get("agent") ?? "", q.get("name") ?? ""));
      }
      if ((path === "/api/kit/adopt" || path === "/api/kit/restore") && req.method === "POST") {
        const body = (await req.json().catch(() => ({}))) as { machine?: unknown; agent?: unknown; name?: unknown; names?: unknown };
        if (typeof body.machine !== "string" || typeof body.agent !== "string") return json({ error: "machine and agent are required" }, 400);
        if (path === "/api/kit/restore") {
          if (typeof body.name !== "string") return json({ error: "name is required" }, 400);
          return json(await this.restore(body.machine, body.agent, body.name));
        }
        const names = Array.isArray(body.names) && body.names.every((n) => typeof n === "string") ? (body.names as string[]) : undefined;
        return json(await this.adopt(body.machine, body.agent, names));
      }
```

- [ ] **Step 5: Wire it in the server**

In `src/server/index.ts`, where `kit: new KitHub({...})` is built, add:

```ts
      // the store's metadata: allowances and sink states, no session needed
      secrets: () => state.secrets.info(null),
      // the mini's canopy writes for the host's home, not the container's /home/bun (docker-compose.yml)
      hostHome: process.env["CANOPY_HOST_HOME"] || undefined,
```

and give `createSecretsHub` a broadcast that also tells the kit:

```ts
      broadcast: (ev) => {
        broadcast(state, ev);
        // an allowance or a sink state moved: the kit's MCP cells follow without a rescan
        if (ev.type === "secrets") void state.kit.republish();
      },
```

- [ ] **Step 6: The CLI's problem list**

In `src/cli/kit.ts`, change `PROBLEMS` to:

```ts
const PROBLEMS = new Set(["missing", "drift", "foreign", "no-source", "noagent", "away", "not-allowed", "stale-allowance", "no-sink", "adoptable", "unresolved"]);
```

and add to `src/cli/kit.test.ts` a check that a server cell prints:

```ts
test("server cells print like skills, with their why", () => {
  const info: KitInfo = { ok: true, error: null, cells: [{ machine: "mac", agent: "claude", skill: "github", state: "not-allowed", why: "not allowed; allow it from the kit view", kind: "mcp" }], machines: [{ machine: "mac", seen: { machine: "mac", at: 1, away: null, home: "/h", store: null, targets: [], sources: {} }, plan: [{ kind: "mcp-set", agent: "codex", name: "github" }] }] };
  expect(kitStatusLines(info, null)).toEqual(["  claude  github  not-allowed  not allowed; allow it from the kit view", "  plan: mcp-set codex/github"]);
});
```

- [ ] **Step 7: Run the tests**

Run: `bun test src/server/kit.test.ts src/cli/kit.test.ts && bun run typecheck && bun run lint`
Expected: PASS. The older hub tests still pass: their manifest has no `mcp`, so `seeMcp` answers null and nothing else changes.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/server/kit.ts src/server/kit.test.ts src/server/index.ts src/cli/kit.ts src/cli/kit.test.ts
git commit -m "feat(kit): KitHub plans MCP servers from the store's allowances, adopts, puts back and previews masked

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 13: The leak test covers the kit

**Files:**
- Modify: `src/secrets/leak.test.ts`

**Interfaces:**
- Consumes: everything above; `KitHub` with `secrets: () => hub.info(null)`.

- [ ] **Step 1: Write the test**

In `src/secrets/leak.test.ts`:

1. Change the service's `sinkRoots: [stacks]` to `sinkRoots: [stacks, join(dir, "home", ".claude", "mcp-env")]`, and add `await mkdir(join(dir, "home", ".claude", "mcp-env"), { recursive: true });` to `beforeEach`.
2. Add the imports: `copyFile, chmod, stat` from `node:fs/promises`; `exec` from `../core/exec`; `mcpHash` from `../core/kit`; `fakeClaude` from `../core/kitfake`; `KitHub` from `../server/kit`.
3. Add the test:

```ts
test("no value reaches a kit route, a kit event, an apply result, claude's argv or either config file", async () => {
  const h = join(dir, "home");
  const claudeDir = join(h, ".claude");
  await exec(["git", "init", "-q", "-b", "main", claudeDir]);
  await writeFile(join(claudeDir, ".gitignore"), "mcp-env/\n.canopy-kit-mcp.json\n");
  await mkdir(join(claudeDir, "skills"), { recursive: true });
  await mkdir(join(claudeDir, "bin"), { recursive: true });
  await copyFile(join(import.meta.dir, "..", "..", "scripts", "canopy-mcp-env"), join(claudeDir, "bin", "canopy-mcp-env"));
  await chmod(join(claudeDir, "bin", "canopy-mcp-env"), 0o755);
  await mkdir(join(h, ".codex", "skills"), { recursive: true });
  await writeFile(join(h, ".codex", "config.toml"), "");
  // a hand-made github holding a literal token, and a hand-made server with a token in its url
  await writeFile(join(h, ".claude.json"), JSON.stringify({ mcpServers: {
    github: { type: "stdio", command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: V2 } },
    hooky: { type: "http", url: `https://h.example/mcp?token=${V3}` },
  } }));
  const kitPath = join(claudeDir, "kit.json");
  await writeFile(kitPath, JSON.stringify({
    version: 1,
    machines: { mini: { backend: "mini" } },
    targets: [
      { agent: "claude", skills: "~/.claude/skills", mode: "store", mcp: { file: "~/.claude.json", format: "claude-json" } },
      { agent: "codex", skills: "~/.codex/skills", mode: "link", mcp: { file: "~/.codex/config.toml", format: "codex-toml" } },
    ],
    mcp: { github: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], env: { GITHUB_PERSONAL_ACCESS_TOKEN: "${secret:gh_token}" } } },
  }));

  await act({ a: "add", name: "gh_token", value: V, description: "", tags: [] });
  const def = { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] };
  await act({ a: "mcp-allow", server: "github", hash: await mcpHash(def), def, env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, homes: { mini: h } });

  const log = join(dir, "argv.log");
  const kitEvents: ServerEvent[] = [];
  const kit = new KitHub({
    self: "mini", devRoot: join(h, "dev"), kitPath, broadcast: (e) => kitEvents.push(e), every: 0,
    env: { HOME: h, KIT_CLAUDE: fakeClaude(dir), FAKE_CLAUDE_LOG: log }, secrets: () => hub.info(null), hostHome: h, procEnv: {},
  });
  const kitSend = async (method: string, path: string, body?: unknown): Promise<{ status: number; text: string }> => {
    const req = new Request(`http://127.0.0.1:7850${path}`, { method, body: body === undefined ? undefined : JSON.stringify(body) });
    const res = await kit.handle(req, new URL(req.url));
    if (!res) throw new Error(`${path} not handled`);
    const text = await res.text();
    seen.push(text);
    return { status: res.status, text };
  };
  await kit.scan();
  await kitSend("GET", "/api/kit");
  expect((await kitSend("GET", "/api/kit/preview?machine=mini&agent=claude&name=github")).status).toBe(200);
  expect((await kitSend("POST", "/api/kit/adopt", { machine: "mini", agent: "claude", names: ["github"] })).status).toBe(200);
  expect((await kitSend("POST", "/api/kit/apply", { machine: "mini" })).status).toBe(200);

  // the server starts with the value, which reaches it through the wrapper alone
  const started = await exec(["sh", join(claudeDir, "bin", "canopy-mcp-env"), "github", "--", "printenv", "GITHUB_PERSONAL_ACCESS_TOKEN"], { env: { HOME: h } });
  expect(started.stdout).toBe(`${V}\n`);

  const claudeJson = await readFile(join(h, ".claude.json"), "utf8");
  const toml = await readFile(join(h, ".codex", "config.toml"), "utf8");
  const owned = await readFile(join(claudeDir, ".canopy-kit-mcp.json"), "utf8");
  expect(toml).toContain("canopy-mcp-env");
  // the hand-made entry adopt replaced is kept for put back, in a 0600 file git ignores
  expect(owned).toContain(V2);
  expect((await stat(join(claudeDir, ".canopy-kit-mcp.json"))).mode & 0o777).toBe(0o600);
  expect((await exec(["git", "-C", claudeDir, "check-ignore", "-q", ".canopy-kit-mcp.json"])).code).toBe(0);

  const outside = [...seen, JSON.stringify(events), JSON.stringify(kitEvents), logs.join("\n"), await readFile(log, "utf8")].join("\n");
  for (const v of VALUES) {
    expect(outside).not.toContain(v);
    expect(outside).not.toContain(sha(v));
    expect(outside).not.toContain(b64(v));
  }
  // the configs hold no store value and no adopted literal; hooky is hand-made and stays as it was
  for (const text of [claudeJson, toml]) {
    expect(text).not.toContain(V);
    expect(text).not.toContain(V2);
  }
  expect(owned).not.toContain(V);
});
```

`V`, `V2`, `V3`, `VALUES`, `sha`, `b64`, `seen`, `events`, `logs`, `act` and `hub` are the file's own.

- [ ] **Step 2: Run it**

Run: `bun test src/secrets/leak.test.ts`
Expected: PASS. If it fails on `outside`, find which part holds the value (print `outside.indexOf(v)` and the 80 characters before it, never the value) and fix the code that let it through, not the test.

- [ ] **Step 3: Run every gate**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add src/secrets/leak.test.ts
git commit -m "test(secrets): the leak test covers kit routes, events, apply results, argv and both config files

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 14: The kit view: server rows, adopt, put back and the allow sheet

**Files:**
- Modify: `ui/src/kit.ts`
- Test: `ui/src/kit.test.ts`
- Modify: `ui/src/api.ts` (`kitAdopt`, `kitRestore`, `kitPreview`)
- Modify: `ui/src/components/Kit.tsx`
- Modify: `ui/src/styles.css` (after the `.kit-` rules near line 10245)

There is no `DESIGN.md`; follow the kit view's existing classes and the tokens in `ui/src/styles.css`.

**Interfaces:**
- Consumes: `KitInfo.mcp`, `KitMachineView.home`, `KitCell.kind` and `restore` (Task 12); the routes from Task 12; `writerOf`, `gateHere`, `isGateClosed`, `errorText` from `ui/src/secrets.ts`; `api.secretsAct`.
- Produces, in `ui/src/kit.ts`: `isServer`, `serverRows`, `serverAt`, `adoptableIn`, `mcpViewsOf`, `homesFor`, `allowAct`; `rows` and `cellAt` now skip server cells.

- [ ] **Step 1: Write the failing helper tests**

Add to `ui/src/kit.test.ts` (extend the imports: `adoptableIn, allowAct, homesFor, mcpViewsOf, serverAt, serverRows` from `./kit`; `parseAct` from `../../src/core/secretwire`; `KitMachineView, KitMcpView` from the types):

```ts
describe("server rows", () => {
  const s = (machine: string, agent: string, name: string, state: KitCell["state"]): KitCell => ({ ...c(machine, agent, name, state), kind: "mcp" });
  const cells = [c("mac", "claude", "ship", "ok"), s("mac", "claude", "github", "adoptable"), s("mac", "codex", "github", "missing"), s("mac", "claude", "ship", "local")];
  const all = { agent: null, machine: null, problems: false, text: "" };
  test("skills and servers keep to their own tables, even with one name", () => {
    expect(rows(cells, all)).toEqual(["ship"]);
    expect(serverRows(cells, all)).toEqual(["github", "ship"]);
    expect(cellAt(cells, "ship", "mac", "claude")?.state).toBe("ok");
    expect(serverAt(cells, "ship", "mac", "claude")?.state).toBe("local");
  });
  test("adoptableIn lists one column's adoptable servers", () => {
    expect(adoptableIn(cells, "mac", "claude")).toEqual(["github"]);
    expect(adoptableIn(cells, "mac", "codex")).toEqual([]);
  });
  test("the allow act carries every machine's home, and parses as the service will read it", () => {
    const v: KitMcpView = { name: "github", def: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] }, hash: "a".repeat(64), env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, machines: ["mac", "mini"], later: ["gpd"] };
    const view = (machine: string, home?: string): KitMachineView => ({ machine, seen: { machine, at: 1, away: null, home: "", store: null, targets: [], sources: {} }, plan: [], ...(home ? { home } : {}) });
    expect(homesFor(v, [view("mac", "/Users/e")])).toEqual({ missing: ["mini"] });
    const h = homesFor(v, [view("mac", "/Users/e"), view("mini", "/home/eric")]);
    if (!("homes" in h)) throw new Error("no homes");
    const act = allowAct(v, h.homes);
    expect(parseAct(act)).toEqual(act);
    expect(mcpViewsOf({ mac: { ...info([]), mcp: [v] }, mini: { ...info([]), mcp: [v] } })).toEqual([v]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test ui/src/kit.test.ts`
Expected: FAIL, `serverRows` not exported.

- [ ] **Step 3: Write the helpers**

In `ui/src/kit.ts`, extend the type import with `KitMcpView`, add `import type { SecretAct } from "../../src/core/secretwire";`, and:

```ts
export const isServer = (c: KitCell): boolean => c.kind === "mcp";
```

In `rows`, make the filter start with `!isServer(c) &&`; in `cellAt`, find with `!isServer(c) && c.skill === skill && …`. Then add:

```ts
export function serverRows(cells: KitCell[], f: KitFilter): string[] {
  const keep = cells.filter((c) =>
    isServer(c) &&
    (!f.agent || c.agent === f.agent) &&
    (!f.machine || c.machine === f.machine) &&
    (!f.problems || PROBLEM.has(c.state)) &&
    (!f.text || c.skill.includes(f.text.toLowerCase())));
  return [...new Set(keep.map((c) => c.skill))].sort();
}

export const serverAt = (cells: KitCell[], name: string, machine: string, agent: string): KitCell | null =>
  cells.find((c) => isServer(c) && c.skill === name && c.machine === machine && c.agent === agent) ?? null;

/** a column's servers that adopt all would take */
export const adoptableIn = (cells: KitCell[], machine: string, agent: string): string[] =>
  cells.filter((c) => isServer(c) && c.machine === machine && c.agent === agent && c.state === "adoptable").map((c) => c.skill).sort();

/** the servers with secrets, once each: every backend reads the same kit.json */
export function mcpViewsOf(byBackend: Record<string, KitInfo>): KitMcpView[] {
  const out = new Map<string, KitMcpView>();
  for (const info of Object.values(byBackend)) for (const v of info.mcp ?? []) if (!out.has(v.name)) out.set(v.name, v);
  return [...out.values()];
}

/** each machine's home, from the backend that owns it; a machine not seen yet blocks the allow */
export function homesFor(v: KitMcpView, machines: KitMachineView[]): { homes: Record<string, string> } | { missing: string[] } {
  const homes: Record<string, string> = {};
  const missing: string[] = [];
  for (const m of v.machines) {
    const home = machines.find((x) => x.machine === m)?.home;
    if (home) homes[m] = home;
    else missing.push(m);
  }
  return missing.length > 0 ? { missing } : { homes };
}

export const allowAct = (v: KitMcpView, homes: Record<string, string>): SecretAct =>
  ({ a: "mcp-allow", server: v.name, hash: v.hash, def: v.def, env: v.env, headers: v.headers, homes });
```

Run: `bun test ui/src/kit.test.ts`
Expected: PASS.

- [ ] **Step 4: The api calls**

In `ui/src/api.ts`, add `KitMcpPreview` to the type import and, after `kitApply`:

```ts
  kitAdopt: (b: string, machine: string, agent: string, names?: string[]) =>
    req<KitApplyResult>(b, "/api/kit/adopt", { method: "POST", body: JSON.stringify({ machine, agent, names }) }),
  kitRestore: (b: string, machine: string, agent: string, name: string) =>
    req<KitApplyResult>(b, "/api/kit/restore", { method: "POST", body: JSON.stringify({ machine, agent, name }) }),
  /** what adopt would change, both sides masked */
  kitPreview: (b: string, machine: string, agent: string, name: string) =>
    req<KitMcpPreview>(b, `/api/kit/preview?${new URLSearchParams({ machine, agent, name }).toString()}`),
```

- [ ] **Step 5: The server table and its sheets**

In `ui/src/components/Kit.tsx`:

1. Imports: change the first line to `import { useEffect, useMemo, useState } from "react";`; extend the `../kit` import with `adoptableIn, allowAct, homesFor, mcpViewsOf, serverAt, serverRows`; add `errorText, gateHere, isGateClosed, writerOf` from `../secrets`; and extend the type import to `KitApplyResult, KitMachineView, KitMcpPreview, KitMcpView` from `../../../src/core/types`, and add `SecretAct` from `../../../src/core/secretwire`.

2. Add above `KitView`:

```tsx
type Sheet =
  | { kind: "adopt"; machine: string; agent: string; names: string[] }
  | { kind: "restore"; machine: string; agent: string; name: string }
  | { kind: "allow"; name: string };

const said = (machine: string, r: KitApplyResult): string =>
  r.failed.length ? `${machine}: ${r.failed.length} failed, first: ${r.failed[0]!.why}` : `${machine}: ${r.done.length} done`;

const shown = (e: Record<string, unknown> | null): string => (e ? JSON.stringify(e, null, 2) : "(none)");

/** Adopt one server or a column's: each hand-made entry beside what the
 *  kit would write, masked by the server, then one confirm. */
function AdoptSheet({ backend, machine, agent, names, onDone }: { backend: string; machine: string; agent: string; names: string[]; onDone: (msg: string) => void }) {
  const key = names.join(",");
  const [previews, setPreviews] = useState<Record<string, KitMcpPreview>>({});
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let live = true;
    for (const n of key.split(",")) {
      api.kitPreview(backend, machine, agent, n).then((p) => live && setPreviews((x) => ({ ...x, [n]: p })), () => {});
    }
    return () => {
      live = false;
    };
  }, [backend, machine, agent, key]);
  const go = async () => {
    setBusy(true);
    try {
      onDone(said(machine, await api.kitAdopt(backend, machine, agent, names)));
    } catch (e) {
      onDone(`${machine}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kit-sheet">
      <h4>Adopt {names.length === 1 ? names[0] : `${names.length} servers`} for {agent} on {machine}</h4>
      <p className="kit-note">Canopy keeps each hand-made entry, so put back restores it. Values are hidden here.</p>
      {names.map((n) => (
        <div key={n} className="kit-compare">
          <div>
            <span className="kit-note">{n} now</span>
            <pre>{shown(previews[n]?.have ?? null)}</pre>
          </div>
          <div>
            <span className="kit-note">what the kit writes</span>
            <pre>{shown(previews[n]?.want ?? null)}</pre>
          </div>
        </div>
      ))}
      <div className="kit-line">
        <button type="button" className="mini" disabled={busy} onClick={() => void go()}>adopt</button>
        <button type="button" className="mini" onClick={() => onDone("")}>cancel</button>
      </div>
    </div>
  );
}

function RestoreSheet({ backend, machine, agent, name, onDone }: { backend: string; machine: string; agent: string; name: string; onDone: (msg: string) => void }) {
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try {
      onDone(said(machine, await api.kitRestore(backend, machine, agent, name)));
    } catch (e) {
      onDone(`${machine}: ${errorText(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="kit-sheet">
      <h4>Put back the hand-made {name} for {agent} on {machine}?</h4>
      <p className="kit-note">The kit stops managing it here until you adopt it again.</p>
      <div className="kit-line">
        <button type="button" className="mini" disabled={busy} onClick={() => void go()}>put back</button>
        <button type="button" className="mini" onClick={() => onDone("")}>cancel</button>
      </div>
    </div>
  );
}

/** One gated allowance for every machine, sent to the secrets service
 *  from the gate page with an open passkey session. */
function AllowSheet({ view, machines, onDone }: { view: KitMcpView; machines: KitMachineView[]; onDone: (msg: string) => void }) {
  const all = useStore((s) => s.secrets);
  const order = useStore((s) => s.backendOrder);
  const writer = writerOf(all, order);
  const info = writer ? all[writer] : undefined;
  const here = gateHere(info, window.location.origin);
  const homes = homesFor(view, machines);
  const [busy, setBusy] = useState(false);
  const [sure, setSure] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = async (act: SecretAct, done: string) => {
    if (!writer) return;
    setBusy(true);
    setError(null);
    try {
      await api.secretsAct(writer, act);
      onDone(done);
    } catch (e) {
      setError(isGateClosed(e) ? "the passkey session has ended; open it again in the secrets view" : errorText(e));
    } finally {
      setBusy(false);
    }
  };
  const names = Object.entries({ ...view.env, ...view.headers }).map(([k, n]) => `${k} from ${n}`).join(", ");
  return (
    <div className="kit-sheet">
      <h4>Allow {view.name} its secrets</h4>
      <dl className="secrets-facts">
        <dt>runs</dt>
        <dd><code>{view.def.command !== null ? [view.def.command, ...view.def.args].join(" ") : view.def.url}</code></dd>
        <dt>definition</dt>
        <dd><code>{view.hash.slice(0, 16)}</code></dd>
        <dt>secrets</dt>
        <dd>{names}</dd>
        <dt>machines</dt>
        <dd>{view.machines.join(", ") || "none"}{view.later.length > 0 ? `; ${view.later.join(", ")} waits for secrets phase 3` : ""}</dd>
      </dl>
      <p className="kit-note">One allowance covers every machine and makes each one's env sink. Editing the command, args, url or the names voids it.</p>
      {!writer || !info ? (
        <p className="kit-error">No backend on this page is the secret store's writer (the mini), so nothing here can allow a server.</p>
      ) : !here ? (
        <p className="kit-note">Allowing needs the passkey gate: <a href={new URL("/?view=kit", info.gate).toString()}>open the kit on the gate page</a>.</p>
      ) : !info.session ? (
        <p className="kit-note">Open the passkey session in <a href="/?view=secrets">the secrets view</a> first.</p>
      ) : "missing" in homes ? (
        <p className="kit-error">No home known yet for {homes.missing.join(", ")}; rescan.</p>
      ) : (
        <div className="kit-line">
          <button type="button" className="mini" disabled={busy} onClick={() => void run(allowAct(view, homes.homes), `${view.name}: allowed`)}>allow</button>
          {sure ? (
            <>
              <span className="kit-error">Revoke takes the allow entries and the env sinks out.</span>
              <button type="button" className="mini" disabled={busy} onClick={() => void run({ a: "mcp-revoke", server: view.name }, `${view.name}: revoked`)}>revoke</button>
              <button type="button" className="mini" onClick={() => setSure(false)}>keep it</button>
            </>
          ) : (
            <button type="button" className="mini" disabled={busy} onClick={() => setSure(true)}>revoke…</button>
          )}
          <button type="button" className="mini" onClick={() => onDone("")}>close</button>
        </div>
      )}
      {error && <p className="kit-error">{error}</p>}
    </div>
  );
}
```

3. In `KitView`, add after `const agents = …`:

```tsx
  const serverNames = useMemo(() => serverRows(merged.cells, f), [merged, f]);
  const views = useMemo(() => mcpViewsOf(byBackend), [byBackend]);
  const [sheet, setSheet] = useState<Sheet | null>(null);
  const close = (msg: string) => {
    setSheet(null);
    if (msg) setSaid(msg);
  };
  const owner = (machine: string) => ownerOf(byBackend, machine);
```

4. Inside `.kit-scroll`, after the skills `</table>`:

```tsx
        {serverNames.length > 0 && (
          <table className="kit-grid kit-servers">
            <thead>
              <tr>
                <th>MCP servers</th>
                {cols.map((col) => {
                  const n = adoptableIn(merged.cells, col.machine, col.agent);
                  return (
                    <th key={`${col.machine}/${col.agent}`} title={`${col.agent} on ${col.machine}`}>
                      {col.machine}<br />{col.agent}
                      {n.length > 0 && (
                        <><br /><button type="button" className="mini" onClick={() => setSheet({ kind: "adopt", machine: col.machine, agent: col.agent, names: n })}>adopt all ({n.length})</button></>
                      )}
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {serverNames.map((name) => (
                <tr key={name}>
                  <th scope="row">
                    {name}
                    {views.some((v) => v.name === name) && (
                      <button type="button" className="mini kit-allow" onClick={() => setSheet({ kind: "allow", name })}>allow…</button>
                    )}
                  </th>
                  {cols.map((col) => {
                    const cell = serverAt(merged.cells, name, col.machine, col.agent);
                    const state = cell?.state ?? "off";
                    const open: Sheet | null = !cell ? null
                      : state === "adoptable" ? { kind: "adopt", machine: col.machine, agent: col.agent, names: [name] }
                      : cell.restore && state !== "adoptable" ? { kind: "restore", machine: col.machine, agent: col.agent, name }
                      : state === "not-allowed" || state === "stale-allowance" ? { kind: "allow", name }
                      : null;
                    return (
                      <td key={`${col.machine}/${col.agent}`} className={`kit-cell kit-${state}${PROBLEM.has(state) ? " kit-problem" : ""}`}
                        title={cell ? `${state}${cell.why ? `: ${cell.why}` : ""}${cell.restore ? " (put back available)" : ""}` : ""}>
                        {open ? <button type="button" className="kit-cell-button" onClick={() => setSheet(open)}>{GLYPH[state]}</button> : GLYPH[state]}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        )}
```

5. Before `</main>`:

```tsx
      {sheet?.kind === "adopt" && owner(sheet.machine) && (
        <AdoptSheet backend={owner(sheet.machine)!} machine={sheet.machine} agent={sheet.agent} names={sheet.names} onDone={close} />
      )}
      {sheet?.kind === "restore" && owner(sheet.machine) && (
        <RestoreSheet backend={owner(sheet.machine)!} machine={sheet.machine} agent={sheet.agent} name={sheet.name} onDone={close} />
      )}
      {sheet?.kind === "allow" && views.find((v) => v.name === sheet.name) && (
        <AllowSheet view={views.find((v) => v.name === sheet.name)!} machines={merged.machines} onDone={close} />
      )}
```

- [ ] **Step 6: Styles**

Append after the `.kit-` rules in `ui/src/styles.css`:

```css
.kit-servers { margin-top: 16px; }
.kit-allow { margin-left: 8px; }
.kit-cell-button { background: none; border: 0; padding: 0; color: inherit; font: inherit; cursor: pointer; }
.kit-cell-button:focus-visible { outline: 2px solid var(--sky); outline-offset: 2px; }
.kit-sheet { border-top: 1px solid var(--bark2); padding: 12px 0; display: flex; flex-direction: column; gap: 8px; max-width: 100%; }
.kit-sheet h4 { margin: 0; font-size: 13px; }
.kit-note { color: var(--ink-dim); font-size: 12px; }
.kit-line { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
.kit-compare { display: grid; grid-template-columns: repeat(auto-fit, minmax(16rem, 1fr)); gap: 8px; }
.kit-compare pre { margin: 0; padding: 8px; overflow: auto; max-height: 16rem; background: var(--bark1); font-family: var(--mono); font-size: 11px; }
```

Check each token (`--bark1`, `--bark2`, `--sky`, `--ink-dim`, `--mono`) exists in `:root` in `ui/src/styles.css` (`grep -n -- '--bark1:' ui/src/styles.css`); use the nearest existing one if a name differs.

- [ ] **Step 7: Check it in a browser**

Run the gates first: `bun run typecheck && bun run lint && bun test ui && bun run build`.

Start a scratch server as the memory note "Scratch canopy server for UI checks" says (no `TMUX`, a short config dir, previews off). Give it a config that names this backend `mac`, and a small manifest of its own, so the server table has rows and nothing points at the live `kit.json`:

```bash
mkdir -p /tmp/claude-501/kitui/cfg
printf '%s\n' '{ "self": "mac" }' > /tmp/claude-501/kitui/cfg/config.json
cat > /tmp/claude-501/kitui/kit.json <<'EOF'
{
  "version": 1,
  "machines": { "mac": { "backend": "mac" } },
  "targets": [
    { "agent": "claude", "skills": "~/.claude/skills", "mode": "store", "mcp": { "file": "~/.claude.json", "format": "claude-json" } },
    { "agent": "codex", "skills": "~/.codex/skills", "mode": "link", "mcp": { "file": "~/.codex/config.toml", "format": "codex-toml" } }
  ],
  "mcp": {
    "excalidraw": { "command": "npx", "args": ["-y", "excalidraw-render"], "agents": ["claude"] },
    "github": { "command": "bunx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:gh_token}" } },
    "wiki-memory": { "command": "bash", "args": ["~/dev/homelab/services/memory/wiki-mcp.sh"], "options": { "codex": { "startup_timeout_sec": 30, "tool_timeout_sec": 180 } } },
    "executor": {
      "url": "https://macmini-2018.tail2d2c60.ts.net:8443/mcp?elicitation_mode=browser",
      "options": { "claude": { "headersHelper": "~/.config/executor/mcp-headers.sh" }, "codex": { "bearer_token_env_var": "EXECUTOR_API_KEY" } }
    }
  },
  "skills": { "default": { "agents": ["*"], "machines": ["*"] } }
}
EOF
env -u TMUX CANOPY_KIT=/tmp/claude-501/kitui/kit.json CANOPY_CONFIG_DIR=/tmp/claude-501/kitui/cfg CANOPY_PREVIEW_PORTS=0 CANOPY_NO_DESKTOP=1 bun bin/canopy.ts ui ~/dev --port 7893 --no-open
```

The fresh config dir has no pinned store, so this backend reads no secret store (its reader stops before any sink pass, so it never touches `~/.claude/mcp-env`). It does read the Mac's real `~/.claude.json` and `config.toml` (into memory, names out), so press nothing that writes: no adopt, apply, put back or allow. With playwright-cli, open `http://127.0.0.1:7893/?view=kit` and check:
- the MCP servers table has `excalidraw`, `executor`, `github` and `wiki-memory`, plus the Mac's other hand-made servers as local, hand-made and not in kit.json (the 12 artcraft ones under claude, `node_repl` and `computer-use` under codex);
- `excalidraw`, `executor` and `wiki-memory` read adoptable (foreign, kit has one), and the mac/claude column header shows "adopt all (3)";
- `github` reads no sink, with the title "this backend cannot read the secret store", and its row's "allow…" opens the allow sheet, which says no backend on this page is the store's writer;
- the excalidraw cell opens the adopt sheet with both sides shown; the hand-made side shows `npx` and its args, and no side shows an env value;
- at 390 px wide the page has no horizontal scroll outside `.kit-scroll`, and after resizing back to 1280 px the layout returns.

Stop the server and kill its tmux server (`tmux -S /tmp/claude-501/kitui/cfg/tmux.sock kill-server`).

- [ ] **Step 8: Commit**

```bash
git add ui/src/kit.ts ui/src/kit.test.ts ui/src/api.ts ui/src/components/Kit.tsx ui/src/styles.css
git commit -m "feat(kit): the MCP servers table, adopt with a masked preview, put back, and the allow sheet

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 15: The secret sheet shows a rotation's reach

**Files:**
- Modify: `ui/src/secrets.ts` (new `restartLine`, `reachRows`, `usedByText`, `ReachRow`)
- Test: `ui/src/secrets.test.ts`
- Modify: `ui/src/components/Secrets.tsx` (`SecretSheet` and the place that renders it)
- Modify: `ui/src/styles.css` (after the `.secrets-` rules near line 10372)

**Interfaces:**
- Consumes: `SecretMeta.impact` (Task 2), `reachText` from `src/core/secretfile.ts`, `SinkRow` and `sinkRows` from `ui/src/secrets.ts`.
- Produces: `restartLine(stack: string): string`, `reachRows(meta: SecretMeta, sinks: SinkRow[]): ReachRow[]`, `usedByText(meta: SecretMeta): string`.

- [ ] **Step 1: Write the failing tests**

Add to `ui/src/secrets.test.ts` (import `reachRows, restartLine, usedByText` from `./secrets`, and `SecretMeta`, `SecretSinkInfo` from the types if missing):

```ts
describe("a rotation's reach", () => {
  const H = "a".repeat(64);
  const meta = (over: Partial<SecretMeta> = {}): SecretMeta => ({
    name: "gh_token", description: "", tags: [], created: "2026-10-14T12:00:00.000Z", rotated: "2026-10-14T12:00:00.000Z", to: ["mac", "mini"], allow: [], usedBy: ["dev-env", "mcp-github-mac"],
    impact: {
      sinks: [{ id: "dev-env", machine: "mini", path: "/opt/stacks/dev/.env", keys: ["GH_TOKEN"] }, { id: "mcp-github-mac", machine: "mac", path: "/Users/e/.claude/mcp-env/github.env", keys: ["GITHUB_PERSONAL_ACCESS_TOKEN"] }],
      servers: [{ server: "github", hash: H, machines: ["mac"] }],
      stacks: ["dev"],
    },
    ...over,
  });
  const sink = (id: string, state: SecretSinkInfo["state"], error: string | null = null): SinkRow => ({ sink: { id, machine: "mac", path: "/x", format: "dotenv", keys: {}, state, error }, owner: "mac" });

  test("the restart line is the stack's compose up", () => {
    expect(restartLine("dev")).toBe("cd /opt/stacks/dev && docker compose up -d");
  });

  test("lists sinks with their states, servers with the session note, and stacks with their line", () => {
    const r = reachRows(meta(), [sink("dev-env", { GH_TOKEN: "same" }), sink("mcp-github-mac", { GITHUB_PERSONAL_ACCESS_TOKEN: "waiting" })]);
    expect(r).toEqual([
      { kind: "sink", name: "dev-env", machine: "mini", detail: "/opt/stacks/dev/.env, GH_TOKEN", state: "same" },
      { kind: "sink", name: "mcp-github-mac", machine: "mac", detail: "/Users/e/.claude/mcp-env/github.env, GITHUB_PERSONAL_ACCESS_TOKEN", state: "waiting" },
      { kind: "server", name: "github", machine: "mac", detail: "new agent sessions get the new value; running ones keep the old one", state: null },
      { kind: "stack", name: "dev", machine: "mini", detail: "cd /opt/stacks/dev && docker compose up -d", state: null },
    ]);
    expect(reachRows(meta(), [sink("dev-env", {}, "cannot write")])[0]?.state).toBe("cannot write");
  });

  test("used by reads the reach, or the sinks from a backend without it", () => {
    expect(usedByText(meta())).toBe("dev-env, mcp-github-mac and the MCP server github");
    const { impact: _, ...old } = meta();
    expect(usedByText(old)).toBe("dev-env, mcp-github-mac");
    expect(usedByText(meta({ usedBy: [], impact: { sinks: [], servers: [], stacks: [] } }))).toBe("nothing");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test ui/src/secrets.test.ts`
Expected: FAIL, `restartLine` not exported.

- [ ] **Step 3: Write the helpers**

In `ui/src/secrets.ts`, add `import { reachText } from "../../src/core/secretfile";` and:

```ts
/** the line that restarts a stack, until phase 3's button */
export const restartLine = (stack: string): string => `cd /opt/stacks/${stack} && docker compose up -d`;

export interface ReachRow {
  kind: "sink" | "server" | "stack";
  name: string;
  machine: string;
  detail: string;
  /** a sink's key states from its owner's last pass, or its error; null for the rest */
  state: string | null;
}

function sinkState(rows: readonly SinkRow[], id: string, keys: readonly string[]): string | null {
  const s = rows.find((r) => r.sink.id === id)?.sink;
  if (!s) return null;
  if (s.error) return s.error;
  return [...new Set(keys.map((k) => s.state[k] ?? "unknown"))].join(", ");
}

/** everything a rotation of `meta` reaches, for the preview and for after the write */
export function reachRows(meta: SecretMeta, rows: readonly SinkRow[]): ReachRow[] {
  const r = meta.impact;
  if (!r) return meta.usedBy.map((id) => ({ kind: "sink", name: id, machine: rows.find((x) => x.sink.id === id)?.sink.machine ?? "", detail: "", state: sinkState(rows, id, Object.keys(rows.find((x) => x.sink.id === id)?.sink.keys ?? {})) }));
  return [
    ...r.sinks.map((s): ReachRow => ({ kind: "sink", name: s.id, machine: s.machine, detail: `${s.path}, ${s.keys.join(", ")}`, state: sinkState(rows, s.id, s.keys) })),
    ...r.servers.map((s): ReachRow => ({ kind: "server", name: s.server, machine: s.machines.join(", "), detail: "new agent sessions get the new value; running ones keep the old one", state: null })),
    ...r.stacks.map((st): ReachRow => ({ kind: "stack", name: st, machine: "mini", detail: restartLine(st), state: null })),
  ];
}

export const usedByText = (meta: SecretMeta): string =>
  meta.impact ? reachText(meta.name, meta.impact).slice(`${meta.name} is used by `.length) : meta.usedBy.join(", ") || "no sink";
```

Run: `bun test ui/src/secrets.test.ts`
Expected: PASS.

- [ ] **Step 4: Use it in the sheet**

In `ui/src/components/Secrets.tsx`:

1. Import `reachRows, usedByText, type ReachRow, type SinkRow` from `../secrets` (with what is imported there already) and `reachText` from `../../../src/core/secretfile`.
2. Where `SecretSheet` is rendered, pass the sink rows the view already builds (or build them with `sinkRows(all, order, writer)` next to `writer`): `<SecretSheet … sinks={rows} />`. Add `sinks: SinkRow[]` to its props.
3. Add above `SecretSheet`:

```tsx
function ReachList({ rows }: { rows: ReachRow[] }) {
  if (rows.length === 0) return <p className="secrets-note">Nothing uses it; a rotation changes only the store.</p>;
  return (
    <ul className="secrets-reach">
      {rows.map((r) => (
        <li key={`${r.kind}:${r.name}`}>
          <span className="secrets-reach-kind">{r.kind}</span> <strong>{r.name}</strong>
          {r.machine ? ` on ${r.machine}` : ""}
          {r.kind === "stack" ? (
            <>
              {" "}<code>{r.detail}</code>{" "}
              <button type="button" className="mini" onClick={() => void navigator.clipboard.writeText(r.detail)}>copy</button>
            </>
          ) : r.detail ? <span className="secrets-note"> · {r.detail}</span> : null}
          {r.state ? <span className={r.state === "same" ? "secrets-reach-ok" : "secrets-reach-bad"}> · {r.state}</span> : null}
        </li>
      ))}
    </ul>
  );
}
```

4. In `SecretSheet`: add `const [reach, setReach] = useState<"no" | "preview" | "after">("no");` and `const rows = reachRows(meta, sinks);`. Replace the "used by" `<dd>` with `<dd>{usedByText(meta)}</dd>`. Replace the rotate form with:

```tsx
          <form
            className="secrets-form"
            onSubmit={(e) => {
              e.preventDefault();
              if (reach !== "preview") {
                setReach("preview");
                return;
              }
              void act.run({ a: "rotate", name: meta.name, value: next }).then((r) => {
                if (r) {
                  setNext("");
                  setReach("after");
                }
              });
            }}
          >
            <input type="password" aria-label={`New value for ${meta.name}`} placeholder="new value" autoComplete="off" value={next} onChange={(e) => setNext(e.target.value)} />
            <button type="submit" className="mini" disabled={act.busy || next === ""}>
              {reach === "preview" ? "rotate now" : "rotate…"}
            </button>
            {reach === "preview" && (
              <button type="button" className="mini" onClick={() => setReach("no")}>
                cancel
              </button>
            )}
          </form>
          {reach === "preview" && (
            <>
              <p className="secrets-note">Rotating {meta.name} writes the new value here:</p>
              <ReachList rows={rows} />
            </>
          )}
          {reach === "after" && (
            <>
              <p className="secrets-note">Written. Each sink's state from its owner's next pass:</p>
              <ReachList rows={rows} />
            </>
          )}
```

The `rows` come from the live store, so the "after" list moves from `waiting` or `unknown` to `same` as each owner's pass lands (the `secrets` event).

5. Replace `const used = meta.usedBy.length > 0;` with:

```tsx
  const used = meta.impact ? meta.impact.sinks.length + meta.impact.servers.length > 0 : meta.usedBy.length > 0;
  const usedTitle = meta.impact ? `${reachText(meta.name, meta.impact)}; take it out of those first` : `used by ${meta.usedBy.join(", ")}; take it out of those sinks first`;
```

and the delete button's `title` with `title={used ? usedTitle : `delete ${meta.name}`}`. When `used`, show the reach under the disabled button: `{used && <ReachList rows={rows} />}`.

- [ ] **Step 5: Styles**

Append after the `.secrets-` rules in `ui/src/styles.css`:

```css
.secrets-reach { margin: 0; padding-left: 16px; display: flex; flex-direction: column; gap: 4px; font-size: 12px; }
.secrets-reach code { font-family: var(--mono); font-size: 11px; overflow-wrap: anywhere; }
.secrets-reach-kind { color: var(--ink-dim); text-transform: lowercase; }
.secrets-reach-ok { color: var(--moss); }
.secrets-reach-bad { color: var(--rust); }
```

- [ ] **Step 6: Run the gates and look**

Run: `bun run typecheck && bun run lint && bun test ui && bun run build`
Expected: PASS.

The sheet needs a readable store, and a scratch server cannot have one safely: a copy of the Mac's store under a scratch config dir would run the reader's sink pass against the real `~/.claude/mcp-env` and prune it with the copy's view. So the look at this sheet happens live, in Task 18 Step 12 (after the Mac's canopy restarts on this build): "used by" reads the reach line, delete is disabled with the reach listed, and the rotate preview opens without rotating.

- [ ] **Step 7: Commit**

```bash
git add ui/src/secrets.ts ui/src/secrets.test.ts ui/src/components/Secrets.tsx ui/src/styles.css
git commit -m "feat(secrets): rotate shows its sinks, servers and stacks before the write and their states after

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 16: The mini's mounts, the redeploy step and the docs

**Files:**
- Modify: `docker-compose.yml` (the `secrets`, `canopy` and `shells` services)
- Test: `src/server/compose.test.ts`
- Modify: `scripts/redeploy.sh` (`job()`)
- Modify: `docs/architecture.md` ("The kit", line 114; "The secret store", line 223)
- Modify: `docs/deploy.md` ("The kit", line 848; "Secrets", line 1081)

**Interfaces:**
- Consumes: `CANOPY_HOST_HOME` (read in `src/server/index.ts`, Task 12); `CANOPY_SECRETS_SINK_ROOTS` (read by `serviceEnv` in `src/secrets/main.ts`, which splits on `:`).
- Produces: on the mini, the `secrets` service writes `${HOST_HOME}/.claude/mcp-env/*.env` at that host path; `canopy` and `shells` see `${HOST_HOME}/.claude` at its host path as well as at `/home/bun/.claude`.

The `secrets` service runs as root (it has no `user:`). The sink writer already chowns a new file to its folder's owner when it runs as root (`src/core/sinks.ts:288`), so the files come out owned by eric, and the containers' `bun` user (the same uid) reads them.

- [ ] **Step 1: Write the failing compose tests**

In `src/server/compose.test.ts`, inside `describe("the secrets service", …)`, replace

```ts
  const named = (v: string): string => v.split(":")[0] ?? v;
```

with

```ts
  /** a volume's host side, with ${HOST_HOME:-x} read as its default, so two
   *  HOST_HOME mounts compare by path and not by the text "${HOST_HOME" */
  const named = (v: string): string => v.replace(/\$\{HOST_HOME:-([^}]*)\}/g, "$1").split(":")[0] ?? v;
  const MCP_ENV = "${HOST_HOME:-/home/eric}/.claude/mcp-env";
  const HOST_CLAUDE = "${HOST_HOME:-/home/eric}/.claude:${HOST_HOME:-/home/eric}/.claude";
```

and add, after the test "shares only the socket with canopy, and only canopy holds it":

```ts
  test("writes the MCP env files at their host path, a sink root, and nothing else of ~/.claude", () => {
    expect(secrets?.volumes).toContain(`${MCP_ENV}:${MCP_ENV}`);
    expect(envOf(secrets ?? {})).toContain(`CANOPY_SECRETS_SINK_ROOTS=/opt/stacks:${MCP_ENV}`);
    expect((secrets?.volumes ?? []).filter((v) => v.includes(".claude"))).toEqual([`${MCP_ENV}:${MCP_ENV}`]);
  });
  test("canopy and the shells see ~/.claude at its host path too, so the wrapper's path runs in both", () => {
    for (const name of ["canopy", "shells"]) {
      const vols = compose.services[name]?.volumes ?? [];
      expect(vols).toContain("${HOST_HOME:-/home/eric}/.claude:/home/bun/.claude");
      expect(vols).toContain(HOST_CLAUDE);
      // the env files reach them only inside ~/.claude, never as a mount of their own
      expect(vols.map(named)).not.toContain(named(MCP_ENV));
    }
    expect(compose.services["stages"]?.volumes ?? []).not.toContain(HOST_CLAUDE);
    expect(envOf(canopy ?? {})).toContain("CANOPY_HOST_HOME=${HOST_HOME:-/home/eric}");
  });
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test src/server/compose.test.ts`
Expected: FAIL on the two new tests (no `mcp-env` mount, no `CANOPY_HOST_HOME`). The two older tests that use `named` still pass with the new helper.

- [ ] **Step 3: Change the compose file**

In `docker-compose.yml`, the `secrets` service's `environment`, after `CANOPY_SECRETS_ORIGIN`:

```yaml
      # where the service may write sinks: the stacks, and the MCP env files
      # the kit's servers read (mcp-allow writes them at the host path)
      - CANOPY_SECRETS_SINK_ROOTS=/opt/stacks:${HOST_HOME:-/home/eric}/.claude/mcp-env
```

and its `volumes`, after `/opt/stacks:/opt/stacks`:

```yaml
      # the MCP env files only, at the host path the sinks name; redeploy
      # makes the folder 0700 first, or docker would make it as root
      - ${HOST_HOME:-/home/eric}/.claude/mcp-env:${HOST_HOME:-/home/eric}/.claude/mcp-env
```

The `canopy` service's `environment`, after `CANOPY_SECRETS_ORIGIN`:

```yaml
      # the host's home: ~ in a kit MCP server and every mcp-env sink path
      # resolve against it, since ~/.claude.json is shared with the host
      - CANOPY_HOST_HOME=${HOST_HOME:-/home/eric}
```

In both the `canopy` and the `shells` services' `volumes`, right after `- ${HOST_HOME:-/home/eric}/.claude:/home/bun/.claude`:

```yaml
      # the same folder at its host path, so a kit server written as
      # /home/eric/.claude/bin/canopy-mcp-env runs here and on the host
      - ${HOST_HOME:-/home/eric}/.claude:${HOST_HOME:-/home/eric}/.claude
```

Run: `bun test src/server/compose.test.ts`
Expected: PASS.

- [ ] **Step 4: Make the folder before `up`**

In `scripts/redeploy.sh`, in `job()`, after the `mkdir -p "$STAGE_DEV_ROOT/_incubator" …` block and before the `--dry-run` check:

```sh
  # the secrets service writes the MCP env files here as root and chowns each
  # to the folder's owner; a folder docker made would be root's, and 0700
  # keeps every other user out
  mkdir -p "$STAGE_HOST_HOME/.claude/mcp-env" && chmod 700 "$STAGE_HOST_HOME/.claude/mcp-env" ||
    { echo "could not make $STAGE_HOST_HOME/.claude/mcp-env; up would make it as root"; return 1; }
```

Run: `sh -n scripts/redeploy.sh && bash -n scripts/redeploy.sh`
Expected: no output.

The new mounts change the `canopy`, `shells` and `secrets` containers' config, so the first deploy after this task recreates all three; `redeploy` stops with exit 3 until it runs with `--shells` (Task 18).

- [ ] **Step 5: The docs**

In `docs/architecture.md`, add a paragraph after the one paragraph of "The kit" (before `## Version`):

```markdown
Phase 2 (`docs/superpowers/specs/2026-10-14-kit-secrets-phase-2-design.md`) adds MCP servers. `kit.json`'s `mcp` block defines each server once; a target's `mcp` names the agent's file and format (`~/.claude.json` as `claude-json`, `~/.codex/config.toml` as `codex-toml`). `core/kit.ts` parses the block, hashes a definition (`mcpHash`: SHA-256 over the canonical JSON of command, args, url and the sorted env and header names, before `~` resolves), builds the entry each agent should hold (`buildEntry`; a server with secrets runs through `~/.claude/bin/canopy-mcp-env <server> -- …`) and plans and paints the server cells (`planMcp`, `mcpCells`) from the scan and the store's plaintext metadata, so allowed, not allowed and stale read the same on every backend without a session. `core/kitscan.ts` reads both files and the ownership file `~/.claude/.canopy-kit-mcp.json` into memory (`MCP_SCAN_SCRIPT`, base64 lines); `core/kitmcp.ts` is the only writer: Claude through `claude mcp add-json` and `remove --scope user` (the path the scan found), Codex by splicing `# canopy-kit: managed` tables into `config.toml` in place after an mtime and size check. Adopt keeps the hand-made entry in the ownership file's `adoptedFrom` (0600, git-ignored), and put back writes it back as it was. `KitInfo` carries names, states and masked previews only; raw entries stay in `KitHub`. On the mini the scan runs as `/home/bun`, but `~` in a server and every sink path take `CANOPY_HOST_HOME`, since `~/.claude.json` is shared with the host.
```

In `docs/architecture.md`, "The secret store", add at its end (after Task 8's paragraph):

```markdown
`mcp-allow {server, hash, def, env, headers, homes}` and `mcp-revoke {server}` (`core/secretmcp.ts`, gated) change the allow lists and the env sinks in one commit: `mcp:<server>#<hash>` on each named secret, and per machine the dotenv sink `mcp-<server>-<machine>` at `<home>/.claude/mcp-env/<server>.env` (plus `-headers` for a JSON headers file). The service recomputes the hash from `def` and refuses one that does not match. MCP sinks are known by id, so `secrets.json`'s shape is unchanged. Each writer deletes any file in its own `mcp-env` folder that no sink names after every pass (`pruneMcpEnv`), locked or not, so a revoke takes the value off disk. On the mini, canopy's relay refuses an `mcp-allow` while `git -C ~/.claude check-ignore` does not ignore `mcp-env/<server>.env`, since the service cannot run git there. `impactOf` lists a secret's reach (sinks, servers, stacks) for the rotate preview, the delete refusal and "used by".
```

In `docs/deploy.md`, "The kit", at the end of the section (before `## Codex`):

```markdown
MCP servers (phase 2) write through `claude mcp` and an in-place splice of `~/.codex/config.toml`, so both bind mounts stay single-file mounts with their inode. The `canopy` and `shells` services also mount `${HOST_HOME}/.claude` at its host path, and `canopy` gets `CANOPY_HOST_HOME`, so a server written as `/home/eric/.claude/bin/canopy-mcp-env` runs inside the containers and on the host. That wrapper is dotclaude's `bin/canopy-mcp-env`, a copy of canopy's `scripts/canopy-mcp-env`; pull dotclaude on the mini and gpd after it changes. A server with secrets is written only after its allowance (the allow sheet in the kit view, on the gate page with a passkey session) and once its env sink on that machine is in step.
```

In `docs/deploy.md`, "Secrets", at its end:

```markdown
**MCP env files.** The `secrets` service mounts `${HOST_HOME}/.claude/mcp-env` at that host path and lists it in `CANOPY_SECRETS_SINK_ROOTS` beside `/opt/stacks`. `redeploy` makes the folder 0700 before `up`; the service runs as root and chowns each file to the folder's owner. dotclaude's `.gitignore` must ignore `mcp-env/` on every machine before the first `mcp-allow`, and canopy's relay refuses the act until it does. A rotation reaches a server only when a new agent session starts it; sessions already running keep the old value.
```

- [ ] **Step 6: Run the gates**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add docker-compose.yml src/server/compose.test.ts scripts/redeploy.sh docs/architecture.md docs/deploy.md
git commit -m "feat(deploy): the mini's mcp-env mount and sink root, the host-path .claude mount, and the docs

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
```

---

### Task 17: dotclaude: the wrapper, the ignore line and the mcp block

This task works in `~/.claude`, the dotclaude repo, not in canopy. Its commit is its own, on the Mac; the mini and gpd only pull.

**Files (all in `~/.claude`):**
- Create: `bin/canopy-mcp-env` (a copy of canopy's `scripts/canopy-mcp-env`, mode 755)
- Modify: `.gitignore` (line 141 holds `skills/.canopy-kit.json`, line 142 `mcp-env/`)
- Modify: `kit.json` (the targets, and a new `mcp` block)

**Interfaces:**
- Consumes: the manifest format of Task 6 (`targets[].mcp`, the `mcp` block, `options`), `WRAPPER` (`~/.claude/bin/canopy-mcp-env`, Task 7), the wrapper of Task 8.
- Produces: the live manifest Task 18 applies.

What the live config holds (checked 2026-10-14, names, commands and booleans only): the Mac's Claude has 16 servers, the 12 artcraft ones as `~/.local/share/artcraft/<x>/<x>-cli mcp`, `excalidraw` as `npx -y excalidraw-render`, `wiki-memory` as `bash ~/dev/homelab/services/memory/wiki-mcp.sh`, `executor` as an http server with a `headersHelper`, and `github` as `bash -c …` reading `gh auth token`. The Mac's Codex has `node_repl`, `computer-use`, `wiki-memory` (with `startup_timeout_sec = 30` and `tool_timeout_sec = 180`) and `executor` (with `bearer_token_env_var = "EXECUTOR_API_KEY"`). The mini's Claude has only `executor`; its Codex has `node_repl` and `executor`. The wiki script, the executor helper and `bunx` exist on the Mac, the mini and gpd. The mini's sparse checkout (`/*` with three exclusions) brings `bin/`.

`github` gets no `agents` filter, so it lands in Codex too, which has no `github` today. That adds one server for Codex rather than changing one. `node_repl` and `computer-use` stay out of the manifest, so they stay hand-made and their cells read local.

- [ ] **Step 1: Check what dotclaude holds before touching it**

```bash
git -C ~/.claude status --short
git -C ~/.claude log --oneline -1
```

Note every path listed. Those are other sessions' edits (desk skill, memory files most days); none of them is staged in this task.

- [ ] **Step 2: Copy the wrapper**

```bash
mkdir -p ~/.claude/bin
cp ~/dev/dev-tools/canopy/scripts/canopy-mcp-env ~/.claude/bin/canopy-mcp-env
chmod 755 ~/.claude/bin/canopy-mcp-env
cmp ~/dev/dev-tools/canopy/scripts/canopy-mcp-env ~/.claude/bin/canopy-mcp-env && echo same
~/.claude/bin/canopy-mcp-env 2>&1 >/dev/null | head -1
```

Expected: `same`, then the wrapper's usage line (no arguments).

- [ ] **Step 3: The ignore line**

In `~/.claude/.gitignore`, after line 142 (`mcp-env/`), add:

```gitignore
# the kit's MCP ownership file: adoptedFrom can hold a hand-made entry with a value in it
.canopy-kit-mcp.json
```

Run:

```bash
git -C ~/.claude check-ignore -q .canopy-kit-mcp.json && git -C ~/.claude check-ignore -q mcp-env/github.env && echo ignored
```

Expected: `ignored`.

- [ ] **Step 4: The targets**

In `~/.claude/kit.json`, replace

```json
    { "agent": "claude", "skills": "~/.claude/skills", "mode": "store" },
    { "agent": "codex", "skills": "~/.codex/skills", "mode": "link" },
```

with

```json
    { "agent": "claude", "skills": "~/.claude/skills", "mode": "store", "mcp": { "file": "~/.claude.json", "format": "claude-json" } },
    { "agent": "codex", "skills": "~/.codex/skills", "mode": "link", "mcp": { "file": "~/.codex/config.toml", "format": "codex-toml" } },
```

Hermes keeps no `mcp`, so it gets no servers.

- [ ] **Step 5: The mcp block**

In `~/.claude/kit.json`, replace

```json
  ],
  "skills": {
```

with

```json
  ],
  "mcp": {
    "photocraft": { "command": "~/.local/share/artcraft/photocraft/photocraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "vectorcraft": { "command": "~/.local/share/artcraft/vectorcraft/vectorcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "filmcraft": { "command": "~/.local/share/artcraft/filmcraft/filmcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "lightcraft": { "command": "~/.local/share/artcraft/lightcraft/lightcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "pdfcraft": { "command": "~/.local/share/artcraft/pdfcraft/pdfcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "effectcraft": { "command": "~/.local/share/artcraft/effectcraft/effectcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "designcraft": { "command": "~/.local/share/artcraft/designcraft/designcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "deckcraft": { "command": "~/.local/share/artcraft/deckcraft/deckcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "gridcraft": { "command": "~/.local/share/artcraft/gridcraft/gridcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "soundcraft": { "command": "~/.local/share/artcraft/soundcraft/soundcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "cadcraft": { "command": "~/.local/share/artcraft/cadcraft/cadcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "wordcraft": { "command": "~/.local/share/artcraft/wordcraft/wordcraft-cli", "args": ["mcp"], "agents": ["claude"], "machines": ["mac"] },
    "excalidraw": { "command": "npx", "args": ["-y", "excalidraw-render"], "agents": ["claude"], "machines": ["mac"] },
    "github": { "command": "bunx", "args": ["-y", "@modelcontextprotocol/server-github"], "env": { "GITHUB_PERSONAL_ACCESS_TOKEN": "${secret:gh_token}" } },
    "wiki-memory": {
      "command": "bash",
      "args": ["~/dev/homelab/services/memory/wiki-mcp.sh"],
      "options": { "codex": { "startup_timeout_sec": 30, "tool_timeout_sec": 180 } }
    },
    "executor": {
      "url": "https://macmini-2018.tail2d2c60.ts.net:8443/mcp?elicitation_mode=browser",
      "options": { "claude": { "headersHelper": "~/.config/executor/mcp-headers.sh" }, "codex": { "bearer_token_env_var": "EXECUTOR_API_KEY" } }
    }
  },
  "skills": {
```

- [ ] **Step 6: Check the manifest with canopy's own parser**

```bash
cd ~/dev/dev-tools/canopy && bun -e '
import { parseKit } from "./src/core/kit";
const r = parseKit(JSON.parse(await Bun.file(process.env.HOME + "/.claude/kit.json").text()));
if ("errors" in r) {
  console.log("errors", JSON.stringify(r.errors));
} else {
  console.log("servers", r.kit.mcp.map((s) => s.name).join(","));
  console.log("targets", r.kit.targets.map((t) => `${t.agent}:${t.mcp?.format ?? "none"}`).join(","));
}
'
```

Expected: no `errors` line, the 16 server names, and `claude:claude-json,codex:codex-toml,hermes:none`.

The running canopy on the Mac (and the mini's, once Task 18 pulls dotclaude) reads this file before it runs the new build. Phase 1's `parseKit` reads only the fields it knows and ignores the rest (no unknown-key check in `src/core/kit.ts`), so the old build keeps planning skills as before and simply shows no servers until it restarts.

- [ ] **Step 7: Commit in dotclaude (only with Eric's approval)**

Stage only the three paths; never `-A` or `.`:

```bash
git -C ~/.claude add bin/canopy-mcp-env .gitignore kit.json
git -C ~/.claude diff --cached --stat
git -C ~/.claude commit -m "feat: the kit's MCP servers, the canopy-mcp-env wrapper, and the ownership file ignored

Claude-Session: https://claude.ai/code/session_01R41PqzJB37o9BkfReGp5B8"
git -C ~/.claude status --short
```

Expected: the stat lists exactly those three files, and the status afterwards lists the same other paths Step 1 noted. Push dotclaude only if Eric says so (the mini and gpd pull from its remote, so Task 18 needs the push; ask once, at this step).

---

### Task 18: Live check on the Mac and the mini

No code changes. The order matters: the mini must run the new `secrets` service (with the `mcp-env` mount and sink root) and every machine must have pulled dotclaude before the first `mcp-allow`, or the mini's sink reads an error and its server stays out.

**Files:** none.

Never print a value in this task. The token is only ever held in a shell variable and compared with `grep -c -F`, which prints a count. Read MCP config as names, commands and args only (`jq` on `.mcpServers.<name> | {command, args}`), never `env` or header values.

- [ ] **Step 1: The gates, and the wrapper copy**

```bash
cd ~/dev/dev-tools/canopy && bun run typecheck && bun run lint && bun test && bun run build
cmp scripts/canopy-mcp-env ~/.claude/bin/canopy-mcp-env && echo same
~/.claude/skills/verify-build/clean-rebuild.sh check && echo fresh
```

Expected: all four gates pass, `same`, `fresh`.

- [ ] **Step 2: Commits**

**Eric's hands:** Eric approves the canopy commits (Tasks 2 to 16, if not yet made) and the dotclaude commit and its push (Task 17). Never push canopy; `redeploy` carries the Mac's `main` to the mini itself.

- [ ] **Step 3: Pull dotclaude on the mini and gpd**

```bash
for h in macmini-2018 gpd; do
  echo "== $h"
  ssh "$h" 'git -C ~/.claude pull --ff-only --no-rebase -q && test -x ~/.claude/bin/canopy-mcp-env && git -C ~/.claude check-ignore -q mcp-env/github.env && git -C ~/.claude check-ignore -q .canopy-kit-mcp.json && echo ready'
done
```

Expected: `ready` twice. On the mini a pull can stop on its local `shell/bashrc` edit; this commit does not touch that file, so if it stops, read the message and ask Eric (memory note "The mini's ~/.claude is a sparse checkout").

- [ ] **Step 4: Redeploy the mini**

**Eric's hands:** this recreates the shells container and ends every shell on the mini. Ask Eric for a moment when nothing needs them, then from the Mac:

```bash
cd ~/dev/dev-tools/canopy && bun run redeploy --shells
bun run redeploy status
```

Expected: the deploy reports the Mac's HEAD, and `status` shows `canopy`, `shells` and `secrets` running and healthy. Then check the mounts and the folder (modes and names only):

```bash
ssh macmini-2018 'cd ~/dev/dev-tools/canopy &&
  stat -c "%a %U %n" ~/.claude/mcp-env &&
  docker compose exec -T secrets sh -c "test -d /home/eric/.claude/mcp-env && echo secrets-sees-it" &&
  docker compose exec -T -u bun canopy sh -c "test -x /home/eric/.claude/bin/canopy-mcp-env && echo wrapper-runs && echo home=\$CANOPY_HOST_HOME" &&
  docker compose exec -T -u bun shells sh -c "test -x /home/eric/.claude/bin/canopy-mcp-env && echo shells-ok"'
```

Expected: `700 eric /home/eric/.claude/mcp-env`, `secrets-sees-it`, `wrapper-runs`, `home=/home/eric`, `shells-ok`.

- [ ] **Step 5: Restart the Mac's canopy**

The Mac's server is the launchd agent `ca.beric.canopy-server`; it serves the `dist/web` from Step 1.

```bash
launchctl kickstart -k "gui/$(id -u)/ca.beric.canopy-server"
cd ~/dev/dev-tools/canopy && bun bin/canopy.ts kit status
```

Expected: the status lists MCP server rows for mac, mini and gpd. Before any allow: `github` reads not allowed on mac and mini and phase 3 on gpd; the other Mac servers read adoptable (foreign, kit has one); gpd's `wiki-memory` and `executor` read missing unless gpd already has them.

- [ ] **Step 6: Unlock the Mac and open the passkey session**

```bash
cd ~/dev/dev-tools/canopy && bun bin/canopy.ts secrets status | head -3
```

**Eric's hands:** if the second line says the Mac is locked (it is after every Mac restart), Eric unlocks it (`canopy secrets unlock`, his passphrase, in a real terminal). Then Eric opens `https://canopy.beric.ca/?view=secrets` and opens the passkey session (his passkey prompt).

- [ ] **Step 7: Allow github**

**Eric's hands:** on the same gate page, Eric opens `https://canopy.beric.ca/?view=kit`, presses "allow…" on the `github` row, reads the sheet (command `bunx -y @modelcontextprotocol/server-github`, the secret `GITHUB_PERSONAL_ACCESS_TOKEN from gh_token`, machines `mac, mini`, gpd waiting for phase 3), and presses allow.

The Mac reads its own copy of the store, which it pulls every 5 minutes. Take the new commit now: press pull in the Mac's secrets view (`http://127.0.0.1:7850/?view=secrets`, with playwright-cli). Then check the commit and the sinks from the Mac, names and states only:

```bash
cd ~/dev/dev-tools/canopy
bun bin/canopy.ts secrets status --json | jq -c '.secrets[] | select(.name == "gh_token") | .allow'
bun bin/canopy.ts secrets status --json | jq -c '.sinks[] | select(.id | startswith("mcp-github")) | {id, machine, state, error}'
```

Expected: the allow list holds `mcp:github#<64 hex>`; two sinks, `mcp-github-mac` and `mcp-github-mini`. After the Mac's pass both read `GITHUB_PERSONAL_ACCESS_TOKEN same`.

```bash
stat -f '%Lp %Su %N' ~/.claude/mcp-env ~/.claude/mcp-env/github.env
ssh macmini-2018 'stat -c "%a %U %n" ~/.claude/mcp-env/github.env'
```

Expected: `700` for the Mac's folder, `600 ericbaruch` for its file, and `600 eric` on the mini.

- [ ] **Step 8: Adopt on the Mac**

**Eric's hands:** Eric says yes to adopting. Then, in the Mac's kit view (`http://127.0.0.1:7850/?view=kit`), press "adopt all (16)" in the mac/claude column header, read the sheet (each hand-made entry beside the kit's, values hidden), and press adopt; then the same for mac/codex (`wiki-memory`, `executor`). Then:

```bash
cd ~/dev/dev-tools/canopy
bun bin/canopy.ts kit apply --machine mac --dry-run
bun bin/canopy.ts kit apply --machine mac
bun bin/canopy.ts kit status --machine mac
```

Expected: the dry run lists `mcp-set github` for codex and nothing for the adopted Claude servers; after the apply every mac MCP cell reads ok, and `node_repl` and `computer-use` read local. Then the entries, commands and args only:

```bash
jq -c '.mcpServers | {github: (.github | {command, args, env: (.env // {} | keys)}), excalidraw: (.excalidraw | {command, args})}' ~/.claude.json
cd /tmp && bun -e 'const t = Bun.TOML.parse(await Bun.file(process.env.HOME + "/.codex/config.toml").text()) as any; const s = t.mcp_servers; console.log(Object.keys(s).join(","), JSON.stringify({ command: s.github.command, args: s.github.args, env: Object.keys(s.github.env ?? {}) }), s["wiki-memory"].startup_timeout_sec)'
grep -c '# canopy-kit: managed' ~/.codex/config.toml
```

Expected: `github` runs `/Users/ericbaruch/.claude/bin/canopy-mcp-env` with args `["github","--","bunx","-y","@modelcontextprotocol/server-github"]` and no env names in both files; `excalidraw` is as before; Codex lists `node_repl,computer-use,wiki-memory,executor,github` (in file order), `wiki-memory`'s timeout is still 30, and three tables carry the marker.

- [ ] **Step 9: The token is in no config file and no log**

```bash
v=$(~/.claude/bin/canopy-mcp-env github -- printenv GITHUB_PERSONAL_ACCESS_TOKEN) && [ -n "$v" ] || { echo "no value"; exit 1; }
for f in ~/.claude.json ~/.codex/config.toml ~/.claude/.canopy-kit-mcp.json ~/Library/Logs/canopy-server.log; do
  [ -e "$f" ] && printf '%s %s\n' "$(grep -c -F -f - "$f" <<<"$v")" "$f"
done
unset v
```

Expected: `0` for every file. The pattern goes to `grep` on stdin (`-f -`), so the value never sits in a process's argv. The ownership file holds the hand-made `github` entry, which read its token through `gh auth token` and so has none either.

- [ ] **Step 10: A fresh Claude session uses github, and Codex starts its servers**

```bash
cd /tmp && claude -p "Use the github MCP tool search_repositories with the query 'dotclaude user:eric-M3Max' and answer with the full name of the first result only." --allowedTools mcp__github__search_repositories
```

Expected: `eric-M3Max/dotclaude`. The repository is private, so finding it proves the server got the token from the store.

The first start of `bunx -y @modelcontextprotocol/server-github` on a machine downloads the package, which can outlast Codex's default MCP startup timeout. If Codex's first run below reports that `github` failed to start, run it once more before treating it as a failure.

```bash
cd /tmp && codex exec --skip-git-repo-check "Call the wiki-memory tool list_wikis and answer with the number of wikis only, then call the github tool search_repositories with the query 'dotclaude user:eric-M3Max' and answer with the first result's full name."
```

Expected: a number and `eric-M3Max/dotclaude`. If Codex declines a tool call for approval, the server still started (its tools were offered); note it and move on rather than changing Codex's approval settings.

- [ ] **Step 11: The same on the mini**

```bash
ssh macmini-2018 'cd ~/dev/dev-tools/canopy && docker compose exec -T -u bun canopy bun bin/canopy.ts kit status --machine mini'
```

Expected: on the mini, `github` and `wiki-memory` read missing for claude and codex (github allowed, its sink in step), `executor` reads adoptable for both, and Codex's `node_repl` reads local. **Eric's hands:** Eric says yes, then in `https://canopy.beric.ca/?view=kit` press adopt on the mini's two `executor` cells, then:

```bash
ssh macmini-2018 'cd ~/dev/dev-tools/canopy && docker compose exec -T -u bun canopy bun bin/canopy.ts kit apply --machine mini'
ssh macmini-2018 'cd ~/dev/dev-tools/canopy &&
  v=$(~/.claude/bin/canopy-mcp-env github -- printenv GITHUB_PERSONAL_ACCESS_TOKEN) && [ -n "$v" ] || exit 1
  for f in ~/.claude.json ~/.codex/config.toml ~/.claude/.canopy-kit-mcp.json; do printf "%s %s\n" "$(grep -c -F -f - "$f" <<<"$v")" "$f"; done
  printf "%s logs\n" "$(docker compose logs --no-color canopy secrets shells 2>&1 | grep -c -F -f <(printf "%s\n" "$v"))"
  unset v
  stat -c "%i" ~/.claude.json; docker compose exec -T -u bun canopy sh -c "stat -c %i /home/bun/.claude.json"
  docker compose exec -T -u bun shells sh -c "cd /tmp && claude -p \"Use the github MCP tool search_repositories with the query dotclaude user:eric-M3Max and answer with the full name of the first result only.\" --allowedTools mcp__github__search_repositories"'
```

Expected: `0` for each file and for the logs; the two inode numbers match (the file is still the bind mount Task 1 checked); `eric-M3Max/dotclaude`.

- [ ] **Step 12: The rotation's reach, without rotating**

On the gate page (`https://canopy.beric.ca/?view=secrets`, session still open), open `gh_token`'s sheet with playwright-cli. Check that "used by" names its sinks and `the MCP server github`, and that delete is disabled with the reach listed under it (the sinks on mac and mini, the server with the session note). Type nothing into the rotate field and press nothing.

**Eric's hands (optional):** to see the preview itself, Eric types any text in the rotate field, presses "rotate…" once, reads the list, and presses cancel. A second press of "rotate now" would rotate the token.

- [ ] **Step 13: Put back and adopt again (optional)**

On the Mac's kit view, open the mac/claude `excalidraw` cell, press put back and confirm, then:

```bash
jq -c '.mcpServers.excalidraw | {command, args}' ~/.claude.json
cd ~/dev/dev-tools/canopy && bun bin/canopy.ts kit status --machine mac | grep excalidraw
```

Expected: `{"command":"npx","args":["-y","excalidraw-render"]}` and the cell reads adoptable. Adopt it again from the cell and check it reads ok.

- [ ] **Step 14: Record it**

Run a checkpoint: `bun ~/.claude/skills/memory-vault/scripts/vault.ts checkpoint --topic "canopy kit and secrets phase 2 live"`, and add a canopy memory note saying where MCP servers are defined (dotclaude's `kit.json`), that a server with secrets needs its allowance on the gate page, and that the mini's deploy now needs `--shells` whenever the `.claude` mounts change.

