# Token-free incubator stages: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** canopy never runs code an incubator stage could have written while canopy holds a token. It never runs a seed's git config. It never lets one stage's files give the next stage settings. Every stage agent and every stage check runs in a separate container that has no token, its own pid namespace and a fenced network.

**Architecture:**
- Part 1 (Task 1) closes a live hole in canopy's own git calls: a guard on every git command canopy runs inside a seed.
- Part 2 (Task 2) keeps a stage from reading settings the seed carries.
- Task 3 closes the other ways canopy starts something in a seed on its own: a task's keep or start-with-panel, a panel's auto-started agent shell, a commit suggestion, a launcher build.
- Part 3 (Tasks 4-12) builds the stages container and its unix-socket stage runner, then routes stage runs and checks through it.
  - The Claude driver moves onto the `RpcSpawn` seam the Codex driver already uses, so a stage process is a socket away and not a child of canopy.
- Tasks 1 to 3 stand alone and close holes phase 3 has today, so they run straight on `feat/incubator-phase-3`, before it merges.

**Tech stack:** Bun + TypeScript (strict), `bun:test`, Docker compose on the mini, iptables `DOCKER-USER` rules.

**Spec:** `docs/superpowers/specs/2026-10-02-incubator-token-free-stages-design.md`. It follows `docs/superpowers/specs/2026-10-01-incubator-design.md` and amendment 2.

**Base:** Tasks 1 to 3 commit on `feat/incubator-phase-3` itself (its tip is `b179e76`, with the re-review folded in). Tasks 4 to 13 go on a new branch `feat/incubator-stages` cut from that tip once Task 3 is done. Do not base either on `main`.

**Scope of the goal.** "On its own" is the line. A task or a shell the user starts by hand in a seed, or a dev server the user runs from the guided panel, still runs in the shells container with its tokens. That is the user's own act and stays a residual, listed in Task 13's amendment and said in the incubator view.

## Rulings made while planning

1. **A separate container, not a second uid.** Only another pid namespace stops `/proc/<canopy>/environ` from being read. Switching uids inside canopy's container would need root or `CAP_SETUID`, and canopy runs as `bun`.
2. **One connection, one process.** The wire is JSON lines with base64 data. It is simple, it is testable with a real socket, and closing the connection kills the process tree, which matches today's rule that a run dies with canopy.
3. **The runner never forwards canopy's env.** It builds the child's env from its own base plus three `CANOPY_*` names. The env scrub stays in canopy as defense in depth, but the boundary is the runner's own rule.
4. **`@pick-check` and `@questions` run in canopy.** Canopy's code is not in the stage image. Both checks only parse a file canopy reads through `readSeed`, so running them in canopy's process runs no seed code. A check line that starts with `@` names a built-in. Any other line is a shell command and runs in the stage container.
5. **Nothing from `canopy-config` is mounted.** That volume holds the tmux socket, flows, pastes and shell snapshots. A stage reads its inputs and the workspace snapshot from `_incubator/.shared/`, which canopy fills and which is mounted read-only over the read-write `_incubator`.
6. **Fail closed.** A backend with `CANOPY_STAGE_SOCKET` set never runs a stage outside the runner. A backend without it runs stages only under `CANOPY_INCUBATOR_UNISOLATED=1`.
7. **The stages subnet is `10.250.13.0/24`.** It is outside 172.16.0.0/12 (ufw's docker allowance on the mini) and outside 192.168.48.0/20 (the tailchan rule). The fence task checks the mini's LAN before applying.
8. **Logins are Eric's.** `claude` and `codex` log in once in the stages container (`docker compose exec -it stages claude`, then `/login`; `codex login --device-auth`). The harness cannot drive an interactive login.

## Review amendments (2026-10-02, before execution)

A review reproduced three ways around Task 1's guard, each with the plan's own `SEED_GIT_FLAGS` on and a `.git/config` the guard reads as clean (the repro is `repro.sh` in that session's scratchpad). These amendments win over the task text below wherever the two differ.

**Task 1**
1. **`.git/commondir` points git at another config.** With a commondir line in `.git`, git reads `<commondir>/config`, and a filter there ran on `git status`. The guard refuses a seed whose `.git` holds `commondir` or `config.worktree`. It reads `.git` and `.git/config` with `lstat` and refuses a symlink in either place.
2. **A committed gitlink brings its own config.** A gitlink in the index plus a plain `sub/.git` folder with a filter: `git status` recursed into it and ran the filter, with no submodule key in the superproject's config. `SEED_GIT_FLAGS` gains `-c diff.ignoreSubmodules=all -c submodule.recurse=false -c fetch.recurseSubmodules=false`; with them the filter did not run.
3. **Git walks up into `_incubator/.git`.** In a folder under the seeds dir with no `.git` of its own, git walked up to an `_incubator/.git` the agent wrote, and its filter ran. Every seed git call sets `GIT_CEILING_DIRECTORIES=<seeds dir>`; with it the filter did not run. The guard finds the `.git` git itself would use: it walks up from the path to the seed's top folder (the first component under the seeds dir) and checks the first `.git` it meets, so a subfolder is judged by its seed's config. A path with no `.git` up to the seed's top is let through, since the ceiling stops git there (that is how `seed.ts` runs `git init` in a new seed). `git()` refuses the seeds dir itself ("the seeds folder is never a repo"), and the scan never takes `<root>/_incubator` as a repo: it descends into it as if it had no `.git`.
4. **The memo is forgeable.** `touch -r` restores an mtime, so a same-size swap read as unchanged. The memo keys on `ctimeMs`, `ino`, `size` and `mtimeMs`; a user cannot set ctime.
5. **Ruling: the peer gate checks seeds in the CLI, not in `gateCommand`.** `gateCommand` is synchronous and pure over the filesystem, and `guardSeed` is async. The gate's caller in `src/cli/index.ts` calls `setSeedRoots([<root>/_incubator])` and, for an upload-pack path under it, awaits `guardSeed` and refuses on a reason.

**Task 2**
6. `sweepCodexTrust` writes the new config to a temp file beside it and renames it into place, so a write Codex makes at the same moment is never half-overwritten.

**Task 3**
7. The UI never offers an agent start in a seed: `AgentButtons` (🐞, ✓), the "new claude/codex shell" and profile rows in `RepoMenu`, `NewShell`'s agent options and the hand-off button are hidden for a repo `isSeedId` names, rather than left to the server's 1011.
8. The guided panel's "Run my app" in a seed carries one line under it: "this runs code the incubator's agents wrote, with your tokens".

**Part 3, folded in for later (not Tasks 1 to 3)**
9. **Task 6: escapees.** `killTree` walks down from the tracked pid, and a `setsid` or double-forked daemon is re-parented to tini and escapes it. At a run's end, and on a kill frame, the runner also kills every process whose `/proc/<pid>/cwd` is inside that run's seed. The runner answers a `busy` request (`{seed}` → whether any process has its cwd there), and Task 8's `setSeedBusy` asks it rather than trusting the pid canopy tracked.
10. **Task 11 and 12: the network.** The stages network sets `enable_ipv6: false`, and the compose test checks it. `scripts/stages-fence.sh --persist` writes the rules into `/etc/ufw/after.rules` (a `*filter` block with `:DOCKER-USER - [0:0]`, idempotent), so nothing is pasted by hand.
11. **Task 12: logins (Eric's decision).** The stages container holds Eric's Claude Max and Codex logins next to agent-written code with open egress. Before Task 12, Eric picks: those logins, or a dedicated key with a spending cap for stages. The plan as written uses the logins.
12. **Unverified, check in Task 1's sweep of call sites:** whether a seed remote holding a local path counts as "self-hosted" for the background fetch. If it does, a seed's `remote.*.url` is allowed only as `https://`, `ssh://`, scp-style `host:path`, or a peer url.

## Global constraints

- **Bun everywhere.** Use `bun`/`bunx`, never npm or npx. Run tests with `SHELL=/bin/bash bun test`.
- **The four gates before every commit:** `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`. Known flakes: `src/server/tasks-hub.test.ts` and one `src/core/seed.test.ts` timing test. Run any other failure alone twice before calling it flaky.
- **Strict TypeScript.** `src/core/types.ts` and every module the UI imports stay browser-safe, with no Bun or node imports.
- **Commit format:** `git commit -m "<subject>" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"`. No backticks in messages. Never push.
- **No token in visible or stored text.** No token on an argv, in a log line, or in stored error text.
- **No tokens in the stages container.** The stages service holds no `*TOKEN*`, `*KEY*` or `*SECRET*` variable, no `~/.ssh`, no `~/.config/git`, no `.env`, and no docker socket.
- **Normal runs are unchanged.** Non-incubator runs, flows, shells and tasks keep their env and their spawn path.
- **Prose rules:** no em dashes, sentence case, plain words.

## Review focus

1. **An agent-written `.git/config` in a seed must never make canopy run a program.** That covers fsmonitor, a filter, an include, `sshCommand`, a pager, `ext::`, a gitfile, and a key added between two scans. Task 1 tests each. The guard reads the config and git reads it again a moment later, so code still running in the seed could swap it in between. Canopy therefore runs no git in a seed while a stage process is alive there (Task 1's `setSeedBusy`, wired to the Runner and the checks in Task 8). Once Part 3 lands, the runner kills the tree when each run ends, so the seed is quiet between runs.
2. **A canopy restart while a stage's `bun run dev` serves must leave nothing running in the stages container.** The grandchildren die too. Task 6 tests it with a real socket and a real grandchild.
3. **A request the runner should refuse must be refused before any process starts.** That covers a cwd that is a symlink out of the stage root, a dot folder, a nested path, an `argv[0]` like `/bin/sh` or `bun`, and an env carrying `GH_TOKEN`. Task 6 tests each against a real socket.
4. **A stage started while the runner is down must wait, not run in canopy's container and not fail.** A queued sprout stays queued with the reason on the incubator view, and starts on the next good hello. A flow restored mid-step parks, so it can be resumed, instead of failing. Canopy waits for one bounded hello before it restores flows or pumps sprouts, and compose starts canopy only once the runner answers its healthcheck. Tasks 9 and 11 test it.
5. **Output framing must survive real sizes.** A 1 MB stdout, a JSON line split across frames, and stdin that arrives before the child reads must all come through byte for byte. Task 7 tests it.

---

## File structure

| File | Responsibility |
|---|---|
| `src/core/seedgit.ts` (new) | pure: `seedConfigRefusal(list)`, `SEED_GIT_FLAGS`, `underSeeds(path, roots)`; Bun: `guardSeed(path)` with an mtime memo, `setSeedRoots` |
| `src/core/exec.ts` | `git()` runs the guard for seed paths |
| `src/core/seed.ts`, `src/core/shipper.ts`, `src/core/peersync.ts` | the guard before their own git calls |
| `src/core/claudedrive.ts` | `cliArgs(..., stage)` uses `user` sources; the driver spawns through `RpcSpawn` |
| `src/core/sprout.ts`, `src/core/suggest.ts`, `ui/src/store.ts` | `isSeedId`; a seed gets no auto-started agent, task or build, and a suggestion runs from a scratch folder |
| `src/core/codexrun.ts`, `src/core/codextrust.ts` (new) | the stage's untrusted override, and the sweep of incubator project tables |
| `src/core/builtincheck.ts` (new) | `@pick-check` and `@questions`, over `readSeed` |
| `src/core/stagewire.ts` (new) | pure, browser-safe: frames, the request's refusal, the child env |
| `src/stage/runner.ts` (new) | Bun: the stage runner daemon |
| `src/stage/main.ts` (new) | the daemon's entry, bundled into the image |
| `src/core/stageclient.ts` (new) | Bun: `StageClient`, with `spawn`, `exec`, `hello` and `harnessesNow` |
| `src/core/driver.ts`, `src/core/runner.ts`, `src/core/check.ts` | `DriveCtx.spawn`; stage runs and checks go through the client |
| `src/core/stageshare.ts` (new) | copies inputs and the workspace snapshot into `_incubator/.shared/` |
| `src/core/incubator.ts`, `src/core/sprout.ts` | the isolation gate, the `.shared` paths |
| `src/server/index.ts`, `src/server/incubator.ts` | wiring, `isolated` in the API |
| `ui/src/components/Incubator.tsx` | the `isolated` word |
| `Dockerfile`, `docker-compose.yml`, `src/server/compose.test.ts` (new) | the `stages` stage and service, and a test that reads the compose file |
| `scripts/stages-fence.sh` (new), `src/stage/fencecheck.ts` (new) | the fence, and the check the stages image runs |
| `docs/deploy.md`, the incubator spec, `CLAUDE.md` | docs |

---

### Task 1: canopy's git never runs a seed's config

**Files:**
- Create: `src/core/seedgit.ts`
- Create: `src/core/seedgit.test.ts`
- Modify: `src/core/exec.ts` (`git()`)
- Modify: `src/core/seed.ts` (its own `git` helper)
- Modify: `src/core/shipper.ts` (before both clones)
- Modify: `src/core/peersync.ts` (`gateCommand`, before serving a seed)
- Modify: `src/server/index.ts` (`setSeedRoots` at start)

**Interfaces:**
- Produces:
  - `setSeedBusy(busy: (path: string) => boolean): void`. While it says a seed is busy, `git()` refuses there with `canopy waits for the stage running in this seed`, and the watcher's refresh skips that seed instead of showing the refusal as a scan error. Task 8 wires it to the Runner's live processes and the flows' running checks.
  - `seedConfigRefusal(entries: readonly [string, string][]): string | null`
  - `SEED_GIT_FLAGS: readonly string[]`
  - `underSeeds(path: string, roots: readonly string[]): boolean`
  - `setSeedRoots(roots: readonly string[]): void`
  - `guardSeed(path: string): Promise<string | null>`. A string is the refusal, null means go.
  - `git()` answers a refused seed with `{ code: 128, stdout: "", stderr: "canopy will not run git in this seed: <reason>" }` and runs nothing.

- [ ] **Step 1: Write the failing tests** (`src/core/seedgit.test.ts`)

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, appendFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, git } from "./exec";
import { guardSeed, seedConfigRefusal, setSeedBusy, setSeedRoots, underSeeds, SEED_GIT_FLAGS } from "./seedgit";

describe("seedConfigRefusal", () => {
  const ok: [string, string][] = [
    ["core.repositoryformatversion", "0"],
    ["core.filemode", "true"],
    ["core.bare", "false"],
    ["core.logallrefupdates", "true"],
    ["remote.upstream.url", "https://github.com/a/b.git"],
    ["remote.upstream.fetch", "+refs/heads/*:refs/remotes/upstream/*"],
    ["remote.mini.pushurl", "canopy-peer-no-push"],
    ["remote.mini.tagopt", "--no-tags"],
    ["branch.main.remote", "upstream"],
    ["branch.main.merge", "refs/heads/main"],
    ["branch.release-1.2.merge", "refs/heads/release-1.2"],
    ["branch.main.vscode-merge-base", "origin/main"],
    ["remote.mini.prune", "true"],
    ["user.name", "canopy"],
    ["user.email", "canopy@mini"],
    ["extensions.objectformat", "sha1"],
  ];
  test("what canopy and a plain commit write passes", () => {
    expect(seedConfigRefusal(ok)).toBe(null);
  });
  test.each([
    ["core.fsmonitor", "./x"],
    ["core.hookspath", "./hooks"],
    ["core.sshcommand", "sh -c x"],
    ["core.pager", "sh"],
    ["filter.lfs.clean", "sh -c x"],
    ["diff.x.textconv", "sh"],
    ["include.path", "/tmp/evil"],
    ["includeif.gitdir:/.path", "/tmp/evil"],
    ["remote.upstream.uploadpack", "sh"],
    ["url.ext::sh.insteadof", "https://"],
    ["extensions.worktreeconfig", "true"],
    ["alias.st", "!sh"],
  ])("%s refuses, named", (key, value) => {
    expect(seedConfigRefusal([...ok, [key, value]])).toContain(key);
  });
  test("a url that is a transport command or a flag refuses", () => {
    expect(seedConfigRefusal([["remote.x.url", "ext::sh -c id"]])).toContain("remote.x.url");
    expect(seedConfigRefusal([["remote.x.url", "-oProxyCommand=id"]])).toContain("remote.x.url");
    expect(seedConfigRefusal([["remote.x.pushurl", "fd::3"]])).toContain("remote.x.pushurl");
  });
  test("keys compare lowercased, as git stores them", () => {
    expect(seedConfigRefusal([["Core.FsMonitor", "x"]])).toContain("core.fsmonitor");
  });
  test("a refusal names the command that undoes it", () => {
    expect(seedConfigRefusal([["core.pager", "less"]])).toContain("git config --unset-all core.pager");
  });
  test("a dotted subsection cannot smuggle a key past the end anchor", () => {
    expect(seedConfigRefusal([["branch.a.b.uploadpack", "sh"]])).toContain("branch.a.b.uploadpack");
    expect(seedConfigRefusal([["remote.x.y.receivepack", "sh"]])).toContain("remote.x.y.receivepack");
  });
});

describe("underSeeds", () => {
  test("a path inside a seeds dir, not the dir itself or a lookalike", () => {
    expect(underSeeds("/w/_incubator/coin", ["/w/_incubator"])).toBe(true);
    expect(underSeeds("/w/_incubator/coin/sub", ["/w/_incubator"])).toBe(true);
    expect(underSeeds("/w/_incubator", ["/w/_incubator"])).toBe(false);
    expect(underSeeds("/w/_incubatorx/coin", ["/w/_incubator"])).toBe(false);
    expect(underSeeds("ssh://mini/w/_incubator/coin", ["/w/_incubator"])).toBe(false);
  });
});

describe("the guard on real seeds", () => {
  let root = "";
  let seeds = "";
  const marker = () => join(root, "ran");
  const seed = async (name: string): Promise<string> => {
    const dir = join(seeds, name);
    await mkdir(dir, { recursive: true });
    expect((await exec(["git", "init", "-q", "-b", "main"], { cwd: dir })).code).toBe(0);
    await writeFile(join(dir, "a.txt"), "a\n");
    return dir;
  };
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "canopy-seedgit-"));
    seeds = join(root, "_incubator");
    setSeedRoots([seeds]);
  });
  afterAll(async () => {
    setSeedRoots([]);
    await rm(root, { recursive: true, force: true });
  });

  test("a clean seed reads as before, with the hardening flags", async () => {
    const dir = await seed("clean");
    expect(await guardSeed(dir)).toBe(null);
    const r = await git(dir, ["status", "--porcelain=v2"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("a.txt");
    expect(SEED_GIT_FLAGS).toEqual(["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"]);
  });

  test("an fsmonitor the agent wrote never runs, and the reason names it", async () => {
    const dir = await seed("fsmon");
    await writeFile(join(root, "mon.sh"), `#!/bin/sh\ntouch ${marker()}\n`, { mode: 0o755 });
    await appendFile(join(dir, ".git", "config"), `[core]\n\tfsmonitor = ${join(root, "mon.sh")}\n`);
    const r = await git(dir, ["status", "--porcelain=v2"]);
    expect(r.code).toBe(128);
    expect(r.stderr).toContain("core.fsmonitor");
    expect(await Bun.file(marker()).exists()).toBe(false);
  });

  test("an include is refused without being followed", async () => {
    const dir = await seed("incl");
    await writeFile(join(root, "evil.cfg"), `[core]\n\tfsmonitor = ${join(root, "mon.sh")}\n`);
    await appendFile(join(dir, ".git", "config"), `[include]\n\tpath = ${join(root, "evil.cfg")}\n`);
    expect(await guardSeed(dir)).toContain("include.path");
  });

  test("a key added after a clean read is caught on the next call", async () => {
    const dir = await seed("later");
    expect(await guardSeed(dir)).toBe(null);
    await Bun.sleep(5);
    await appendFile(join(dir, ".git", "config"), `[filter "x"]\n\tclean = sh\n`);
    expect(await guardSeed(dir)).toContain("filter.x.clean");
  });

  test("a gitfile .git refuses", async () => {
    const dir = join(seeds, "gitfile");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, ".git"), "gitdir: /tmp/elsewhere\n");
    expect(await guardSeed(dir)).toContain("gitfile");
  });

  test("while a stage process is alive in a seed, canopy runs no git there", async () => {
    const dir = await seed("busy");
    setSeedBusy((p) => p === dir);
    const r = await git(dir, ["status"]);
    expect(r.code).toBe(128);
    expect(r.stderr).toContain("waits for the stage");
    setSeedBusy(() => false);
    expect((await git(dir, ["status"])).code).toBe(0);
  });

  test("a repo outside the seeds dir is not read by the guard", async () => {
    const dir = join(root, "plain");
    await mkdir(dir, { recursive: true });
    await exec(["git", "init", "-q"], { cwd: dir });
    await appendFile(join(dir, ".git", "config"), `[alias]\n\tst = status\n`);
    expect(await guardSeed(dir)).toBe(null);
    expect((await git(dir, ["status"])).code).toBe(0);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/core/seedgit.test.ts`
Expected: FAIL with `Cannot find module './seedgit'`.

- [ ] **Step 3: Write `src/core/seedgit.ts`**

```ts
/**
 * Seeds are written by agents, `.git/config` included, and canopy runs git in
 * them (the watcher's status, fetch, the peer pass, ship's clone). A config
 * key like core.fsmonitor, a filter driver, an include or an ext:: url turns
 * that git call into a program the agent chose, run as canopy. So every git
 * call canopy makes in a seed is refused unless the config holds only keys
 * canopy and plain commits write, and carries flags that turn the rest off.
 * The pure parts are tested in seedgit.test.ts; `guardSeed` is Bun.
 */
import { stat } from "node:fs/promises";
import { join, sep } from "node:path";

/** laid on every git call canopy makes in a seed */
export const SEED_GIT_FLAGS: readonly string[] = ["-c", "core.fsmonitor=false", "-c", "core.hooksPath=/dev/null", "-c", "protocol.ext.allow=never"];

const ALLOWED: readonly RegExp[] = [
  /^core\.(repositoryformatversion|filemode|bare|logallrefupdates|ignorecase|precomposeunicode|symlinks)$/,
  // a subsection keeps its dots (branch.release-1.2.merge), so `.+`, not `[^.]+`
  /^remote\..+\.(url|fetch|pushurl|tagopt|prune)$/,
  // what a person's own tools write too: VS Code's merge base, a rebase or push remote, a description
  /^branch\..+\.(remote|merge|rebase|pushremote|description|vscode-merge-base)$/,
  /^user\.(name|email)$/,
  /^extensions\.objectformat$/,
];

/** a url git would hand to a transport helper or read as a flag */
const badUrl = (v: string): boolean => v.includes("::") || v.trimStart().startsWith("-");

/** what is wrong with a seed's config, from `git config --list --null`'s
 *  pairs, or null when every key is one canopy expects */
export function seedConfigRefusal(entries: readonly [string, string][]): string | null {
  for (const [raw, value] of entries) {
    const key = raw.toLowerCase();
    if (!ALLOWED.some((re) => re.test(key))) return `its .git/config sets ${key}; if you set it yourself, git config --unset-all ${key} lets canopy back in`;
    if (/\.(url|pushurl)$/.test(key) && badUrl(value)) return `its .git/config sets ${key} to a command, not an address`;
  }
  return null;
}

/** whether `path` is inside one of the seeds dirs, not the dir itself */
export function underSeeds(path: string, roots: readonly string[]): boolean {
  if (path.includes("://")) return false;
  return roots.some((r) => path.startsWith(r.endsWith(sep) ? r : r + sep));
}

let seedRoots: readonly string[] = [];
/** the seeds dirs, set once by the server; tests set their own */
export function setSeedRoots(roots: readonly string[]): void {
  seedRoots = [...roots];
  memo.clear();
}

let busyHook: (path: string) => boolean = () => false;
/** set once by the server: a seed with a stage process alive in it */
export function setSeedBusy(busy: (path: string) => boolean): void {
  busyHook = busy;
}
export const seedBusy = (path: string): boolean => busyHook(path);

const memo = new Map<string, { mtime: number; size: number; refusal: string | null }>();

/** `--list --null` output as key/value pairs: `key\nvalue\0` */
function parseList(out: string): [string, string][] {
  const pairs: [string, string][] = [];
  for (const rec of out.split("\0")) {
    if (!rec) continue;
    const nl = rec.indexOf("\n");
    pairs.push(nl < 0 ? [rec, ""] : [rec.slice(0, nl), rec.slice(nl + 1)]);
  }
  return pairs;
}

/** null when canopy may run git at `path`, else why not. A path outside
 *  every seeds dir is always null. */
export async function guardSeed(path: string): Promise<string | null> {
  if (!underSeeds(path, seedRoots)) return null;
  const dotGit = join(path, ".git");
  const st = await stat(dotGit).catch(() => null);
  if (!st) return null; // not a repo yet: git itself will say so
  if (!st.isDirectory()) return "its .git is a gitfile pointing elsewhere";
  const file = join(dotGit, "config");
  const fst = await stat(file).catch(() => null);
  if (!fst) return null;
  const seen = memo.get(file);
  if (seen && seen.mtime === fst.mtimeMs && seen.size === fst.size) return seen.refusal;
  // Bun.spawn, not exec(): exec.ts imports this file, and the guard must not
  // route back through git()
  const p = Bun.spawn(["git", "config", "--file", file, "--no-includes", "--list", "--null"], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", HOME: "/nonexistent" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const [out, code] = await Promise.all([new Response(p.stdout).text(), p.exited]);
  const refusal = code !== 0 ? "its .git/config does not parse" : seedConfigRefusal(parseList(out));
  memo.set(file, { mtime: fst.mtimeMs, size: fst.size, refusal });
  return refusal;
}
```

- [ ] **Step 4: Wire the guard into `git()`** (`src/core/exec.ts`). `seedgit.ts` imports nothing from `exec.ts`, so a static import is safe. Add `export const seedRootsNow = (): readonly string[] => seedRoots;` to `seedgit.ts`, then:

```ts
import { guardSeed, SEED_GIT_FLAGS, seedBusy, seedRootsNow, underSeeds } from "./seedgit";

export async function git(repoPath: string, args: string[], timeoutMs = 30_000, env?: Record<string, string>): Promise<ExecResult> {
  const { host, path } = parseLocator(repoPath);
  const opts = { timeoutMs, env: { GIT_OPTIONAL_LOCKS: "0", ...env } };
  if (host === null && underSeeds(path, seedRootsNow())) {
    if (seedBusy(path)) return { code: 128, stdout: "", stderr: "canopy waits for the stage running in this seed" };
    const refused = await guardSeed(path);
    if (refused) return { code: 128, stdout: "", stderr: `canopy will not run git in this seed: ${refused}` };
    return onHost(host, ["git", ...SEED_GIT_FLAGS, "-C", path, ...args], opts);
  }
  return onHost(host, ["git", "-C", path, ...args], opts);
}
```

Keep `git()`'s real current signature. If it differs from the one above, change only the body. This also closes the re-review's finding that the background `fetchLocal` runs `git fetch` in a seed whose `remote.x.uploadpack` names a command: that key is off the allowlist, so the fetch is refused.

- [ ] **Step 5: Wire it into the three other git call sites**
- **`src/core/seed.ts`.** Its own `git(work, args)` helper calls `guardSeed(work)` first and throws `canopy will not run git in this seed: <reason>` on a refusal. Its existing `NO_HOOKS` stays.
- **`src/core/shipper.ts`.** Before each `git clone ... seedPath`, run `const refused = await guardSeed(seedPath); if (refused) throw new Error(\`the seed: ${refused}\`);`. The sprout parks with that reason.
- **`src/core/peersync.ts`.** In `gateCommand`, after `safeId` resolves a path under a seeds dir, refuse the same way as for an unsafe id.
- **`src/server/index.ts`.** Before the first scan, call `setSeedRoots([join(root, SEEDS_DIR)])`. In `scheduleRefresh`, skip a path for which `seedBusy(path)` is true and leave its last status on the card. The Runner's end-of-run status read runs after the process has exited, and Task 8 clears the busy flag at exit, so that read still happens.
- **The busy wiring before Part 3.** Until Task 8, wire `setSeedBusy` to `(path) => runner.activeFor(idOf(path)) !== undefined` in the server, which covers the run but not a check. Task 8 replaces it with the precise hook.

Add a test to `src/core/shipper.test.ts`: a seed under a dir passed to `setSeedRoots`, with `core.fsmonitor` set, makes `push` reject with `core.fsmonitor`, and the fake exec records no clone.

- [ ] **Step 6: Run the gates**

Run: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

- [ ] **Step 7: Commit**

```bash
git add src/core/seedgit.ts src/core/seedgit.test.ts src/core/exec.ts src/core/seed.ts src/core/shipper.ts src/core/shipper.test.ts src/core/peersync.ts src/server/index.ts
git commit -m "fix(incubator): canopy runs git in a seed only when its config holds keys canopy expects" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 2: a stage reads no settings the seed carries

**Files:**
- Modify: `src/core/claudedrive.ts` (`cliArgs` takes `stage`)
- Create: `src/core/codextrust.ts`
- Modify: `src/core/codexrun.ts` (`appServerArgs` takes `stage` and the cwd)
- Modify: `src/server/index.ts` (sweep at start)
- Test: `src/core/claudedrive.test.ts`, `src/core/codextrust.test.ts`

**Interfaces:**
- Produces:
  - `cliArgs(spec, agent, stage = false)`: a stage gets `--setting-sources user`.
  - `dropSeedProjects(toml: string, seeds: string): string` (pure).
  - `sweepCodexTrust(codexHome: string, seeds: string): Promise<boolean>` (Bun).
  - The Codex driver sweeps before every stage run (seeds dir = `dirname(ctx.cwd)`), and the server sweeps once at start.
- Ruled out: a `-c projects."<cwd>".trust_level=...` override. Codex's `-c` splits its key on dots, and whether it takes a quoted segment holding a path with dots is not something to bet a boundary on. The sweep before each run does the same job with no guess. `codex app-server` never asks to trust a folder, so nothing writes the table back between the sweep and the run's start.

- [ ] **Step 1: Write the failing tests**

In `src/core/claudedrive.test.ts`:

```ts
test("a stage run reads the user's settings only, never the seed's .claude/", () => {
  const args = cliArgs({ allowedTools: [], maxTurns: 5 }, DEFAULT_AGENT, true);
  expect(args[args.indexOf("--setting-sources") + 1]).toBe("user");
  const plain = cliArgs({ allowedTools: [], maxTurns: 5 }, DEFAULT_AGENT);
  expect(plain[plain.indexOf("--setting-sources") + 1]).toBe("user,project,local");
});
```

In a new `src/core/codextrust.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dropSeedProjects, sweepCodexTrust } from "./codextrust";

describe("codex never trusts a seed", () => {
  test("the sweep rewrites the file only when a seed's table is there", async () => {
    const home = await mkdtemp(join(tmpdir(), "canopy-codexhome-"));
    const file = join(home, "config.toml");
    await writeFile(file, '[projects."/w/_incubator/coin"]\ntrust_level = "trusted"\n');
    expect(await sweepCodexTrust(home, "/w/_incubator")).toBe(true);
    expect(await Bun.file(file).text()).not.toContain("_incubator");
    expect(await sweepCodexTrust(home, "/w/_incubator")).toBe(false);
    expect(await sweepCodexTrust(join(home, "none"), "/w/_incubator")).toBe(false);
    await rm(home, { recursive: true, force: true });
  });
  test("the sweep drops a seed's project table and keeps the rest byte for byte", () => {
    const toml = [
      'model = "gpt-5"',
      "",
      '[projects."/w/dev/canopy"]',
      'trust_level = "trusted"',
      "",
      '[projects."/w/_incubator/coin"]',
      'trust_level = "trusted"',
      "",
      "[tui]",
      "x = 1",
      "",
    ].join("\n");
    const out = dropSeedProjects(toml, "/w/_incubator");
    expect(out).toContain('[projects."/w/dev/canopy"]');
    expect(out).not.toContain("_incubator");
    expect(out).toContain("[tui]\nx = 1");
    expect(dropSeedProjects(out, "/w/_incubator")).toBe(out);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/core/claudedrive.test.ts src/core/codextrust.test.ts`
Expected: FAIL. `cliArgs` ignores its third argument, and `./codextrust` is missing.

Once Task 11 lands, the stage's codex has its own `CODEX_HOME` in the stages container, which canopy cannot reach. That home is only ever used by `codex app-server` and Eric's one `codex login`, neither of which trusts a folder, so the sweep there is not needed.

- [ ] **Step 3: Implement**

In `cliArgs`, add the parameter `stage = false` and replace the literal `"user,project,local"` with `stage ? "user" : "user,project,local"`. Add a comment: a stage's earlier step could have written `.claude/settings.json` with hooks or wider rules. `drive()` passes `ctx.stage ?? false`.

`src/core/codextrust.ts`:

```ts
/**
 * Codex writes `[projects."<dir>"] trust_level = "trusted"` into its config
 * once it trusts a folder, and a trusted folder's own `.codex/` config is
 * read. A seed is written by agents, so no seed stays trusted: a stage's
 * app-server keeps its cwd untrusted, and canopy drops any seed's table it
 * finds at start. `dropSeedProjects` is pure; `sweepCodexTrust` is Bun.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HEADER = /^\s*\[projects\."([^"]+)"\]\s*$/;
const ANY_HEADER = /^\s*\[/;

/** the config without any `[projects."<seeds>/…"]` table */
export function dropSeedProjects(toml: string, seeds: string): string {
  const prefix = seeds.endsWith("/") ? seeds : `${seeds}/`;
  const out: string[] = [];
  let skipping = false;
  for (const line of toml.split("\n")) {
    const head = HEADER.exec(line);
    if (head) skipping = (head[1] ?? "").startsWith(prefix);
    else if (ANY_HEADER.test(line)) skipping = false;
    if (!skipping) out.push(line);
  }
  return out.join("\n");
}

/** true when the file changed */
export async function sweepCodexTrust(codexHome: string, seeds: string): Promise<boolean> {
  const file = join(codexHome, "config.toml");
  const text = await readFile(file, "utf8").catch(() => null);
  if (text === null) return false;
  const next = dropSeedProjects(text, seeds);
  if (next === text) return false;
  await writeFile(file, next);
  return true;
}
```

In `codexrun.ts`, before the app-server spawn, add `if (ctx.stage) await sweepCodexTrust(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), dirname(ctx.cwd));`. In `src/server/index.ts` at start, call `void sweepCodexTrust(process.env["CODEX_HOME"] ?? join(homedir(), ".codex"), join(root, SEEDS_DIR))`, and log a line when it returns true.

- [ ] **Step 4: Run them and watch them pass**

Run: `SHELL=/bin/bash bun test src/core/claudedrive.test.ts src/core/codextrust.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates, then commit**

```bash
git add src/core/claudedrive.ts src/core/claudedrive.test.ts src/core/codextrust.ts src/core/codextrust.test.ts src/core/codexrun.ts src/server/index.ts
git commit -m "fix(incubator): a stage reads only the user's Claude settings, and codex never trusts a seed" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 3: nothing canopy starts on its own runs in a seed

**Files:**
- Modify: `src/core/sprout.ts` (`isSeedId`, pure)
- Modify: `src/server/index.ts` (the task hub's `own`, the shell socket's `start`, resume, restore, suggest, the launcher build)
- Modify: `src/core/suggest.ts` (`suggestMessage` takes `seed`)
- Modify: `ui/src/store.ts` (the `panelsShelled` subscription)
- Test: `src/core/sprout.test.ts`, `src/core/suggest.test.ts`, `src/server/start.test.ts`, `src/server/tasks.test.ts`

**Interfaces:**
- Produces:
  - `isSeedId(repoId: string): boolean`: a launch-source id under `_incubator/`, not a dot folder. It is pure and browser-safe, for the UI.
  - `SEED_AGENT_REFUSAL = "a seed's agents run through the incubator; open a plain shell to work in it yourself"`.
  - `suggestMessage(repoPath, files, agent, { seed?: boolean })`. With `seed`, either harness runs from a scratch folder (the diff is in the prompt) with `stageEnv(process.env)`, so no seed `CLAUDE.md`, `.claude/`, `AGENTS.md` or `.codex/` is read.
- Behaviour:
  - The task hub's `own(repo)` is false for a seed, so `keep` and start-with-panel never start an agent-written command. Starting a task by hand still works.
  - A shell socket asking `start=agent` (or `start=claude`) in a seed is refused with `SEED_AGENT_REFUSAL` through the existing `refused` path, before any shell starts. A plain shell in a seed still opens.
  - `POST /api/repos/resume` and `POST /api/terms/restore` with `resume: true` answer 400 with the same words for a seed.
  - The UI's `panelsShelled` subscription never puts `start: "agent"` on the tab it opens for a seed, so opening a seed's panel at intermediate level gives a plain shell.
  - `POST /api/repos/build` answers 400 for a seed: "a seed is built by its own stages; the launcher builds it once it ships".

- [ ] **Step 1: Write the failing tests**

In `src/core/sprout.test.ts`:

```ts
test("isSeedId: a sprout's seed on the launch root, not the making folder or a lookalike", () => {
  expect(isSeedId("_incubator/coin")).toBe(true);
  expect(isSeedId("_incubator/.coin.abc.making")).toBe(false);
  expect(isSeedId("_incubator")).toBe(false);
  expect(isSeedId("_incubatorx/coin")).toBe(false);
  expect(isSeedId("src2:_incubator/coin")).toBe(false);
  expect(isSeedId("mini|_incubator/coin")).toBe(true);
});
```

`mini|` is a qualified id from another backend (`ui/src/registry.ts`'s `qual`). A seed is a seed on whichever backend holds it, so `isSeedId` strips a `<name>|` prefix first.

In `src/core/suggest.test.ts`, assert through an injected spawn or `exec` stand-in, whichever the file already uses for `askCodex`. With `{ seed: true }`, the cwd is the scratch folder for both harnesses. For codex, `-C` is the scratch folder too. The env holds no `GH_TOKEN` when the test's `process.env` has one. If the file has no seam for this, add one: an optional `run` parameter defaulting to `exec`.

In `src/server/start.test.ts`, next to the existing `start=agent` tests, using the file's own server fixture with a repo at `_incubator/coin` under its root:

```ts
test("start=agent in a seed is refused before a shell starts, and a plain shell opens", async () => {
  const refused = await openSocket({ id: "_incubator/coin", start: "agent" });
  expect(refused.closeCode).toBe(1011);
  expect(refused.closeReason).toContain("a seed's agents run through the incubator");
  expect(typed()).toEqual([]);
  const plain = await openSocket({ id: "_incubator/coin" });
  expect(plain.opened).toBe(true);
});
```

Use the file's real helper names for opening a socket and reading what `agentLine` typed.

In `src/server/tasks.test.ts`, check that a seed with a `.canopy/tasks.json` saying `keep: true` and a pushable GitHub remote lists its task with `keep` off, and that nothing starts it.

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/core/sprout.test.ts src/core/suggest.test.ts src/server/start.test.ts src/server/tasks.test.ts`
Expected: FAIL on each new test.

- [ ] **Step 3: Implement**

In `src/core/sprout.ts`:

```ts
export const SEED_AGENT_REFUSAL = "a seed's agents run through the incubator; open a plain shell to work in it yourself";

/** a sprout's seed by repo id: `_incubator/<slug>` on the launch root,
 *  bare or qualified with another backend's `<name>|`; never a dot folder */
export function isSeedId(repoId: string): boolean {
  const plain = repoId.includes("|") ? repoId.slice(repoId.indexOf("|") + 1) : repoId;
  const m = /^_incubator\/([^/]+)$/.exec(plain);
  return m !== null && !(m[1] ?? "").startsWith(".");
}
```

In `src/server/index.ts`:
- **Tasks.** The task hub's `own` starts with `if (isSeedPath(root, repo.path)) return false;`.
- **The socket.** After `const refused = start ? await harnessRefusal(...) : null;`, use `const refused = start && isSeedPath(root, repo.path) ? SEED_AGENT_REFUSAL : start ? await harnessRefusal(state, start.harness, repo.path) : null;`.
- **Resume and restore.** Both answer `json({ error: SEED_AGENT_REFUSAL }, 400)` for a seed when an agent would be typed in.
- **Suggest.** The route passes `{ seed: isSeedPath(root, repo.path) }` to `suggestMessage`.
- **The launcher build.** `repos/build` refuses a seed before it calls the launcher.

In `src/core/suggest.ts`, `suggestMessage` takes `opts: { seed?: boolean } = {}`. When `seed` is set:
- It makes a scratch folder (`mkdtemp`, removed after) and runs the harness there.
- For codex, `codexSuggestDir` is skipped and the scratch folder is `dir`.
- For claude, the scratch folder is the `cwd`.
- Both get `base: stageEnv(process.env)` in their exec options.

In `ui/src/store.ts`'s `panelsShelled` subscription, the tab it opens for a repo where `isSeedId(repoId)` is true has no `start`, `prompt`, `harness` or `profile`.

- [ ] **Step 4: Run them and watch them pass, then the gates**

Run: `SHELL=/bin/bash bun test src/core/sprout.test.ts src/core/suggest.test.ts src/server/start.test.ts src/server/tasks.test.ts && bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/sprout.ts src/core/sprout.test.ts src/core/suggest.ts src/core/suggest.test.ts src/server/index.ts src/server/start.test.ts src/server/tasks.test.ts ui/src/store.ts
git commit -m "fix(incubator): canopy starts no agent, task or build in a seed on its own" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 4: built-in checks run in canopy, every other seed check runs as shell

**Files:**
- Create: `src/core/builtincheck.ts`
- Create: `src/core/builtincheck.test.ts`
- Modify: `src/server/index.ts` (the flows' `check` hook)
- Modify: `lib/workflows/scout.md` (`check: @pick-check`)
- Modify: `lib/workflows/clarify.md` (`check: @questions`)
- Modify: `src/core/workflows.test.ts` (the two check lines)

**Interfaces:**
- Consumes: `readSeed(path, rel): Promise<string | null>` (`src/core/seed.ts`), plus `parsePick`, `pickRefusal` and `parseQuestions` (`src/core/sprout.ts`).
- Produces: `isBuiltinCheck(command: string): boolean` and `builtinCheck(command: string, seedPath: string): Promise<CheckResult>`. An unknown `@name` answers exit 2 with "no built-in check @name".

- [ ] **Step 1: Write the failing tests** (`src/core/builtincheck.test.ts`)

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { builtinCheck, isBuiltinCheck } from "./builtincheck";

let dir = "";
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "canopy-builtin-"));
  await mkdir(join(dir, ".canopy"));
});
afterAll(() => rm(dir, { recursive: true, force: true }));
const put = (rel: string, text: string) => writeFile(join(dir, rel), text);

describe("built-in checks", () => {
  test("only an @name line is one", () => {
    expect(isBuiltinCheck("@pick-check")).toBe(true);
    expect(isBuiltinCheck(" @pick-check")).toBe(false);
    expect(isBuiltinCheck("bun test")).toBe(false);
  });

  test("@pick-check: missing, bad, refused, then ok", async () => {
    expect((await builtinCheck("@pick-check", dir)).output).toContain("pick.json is missing");
    await put(".canopy/pick.json", "{");
    expect((await builtinCheck("@pick-check", dir)).exit).toBe(1);
    await put(".canopy/pick.json", JSON.stringify({ kind: "renovate", host: "vercel", why: "x", target: "https://github.com/a/b" }));
    expect((await builtinCheck("@pick-check", dir)).output).toContain("SPDX");
    await put(".canopy/pick.json", JSON.stringify({ kind: "new", host: "vercel", why: "nothing close" }));
    expect((await builtinCheck("@pick-check", dir)).output).toContain("research.md is missing");
    await put(".canopy/research.md", "# research\n");
    expect(await builtinCheck("@pick-check", dir)).toEqual({ exit: 0, output: "pick ok: new on vercel" });
  });

  test("@questions: absent is fine, a bad list is not", async () => {
    expect((await builtinCheck("@questions", dir)).exit).toBe(0);
    await put(".canopy/questions.json", '[{"q": 1}]');
    expect((await builtinCheck("@questions", dir)).exit).toBe(1);
    await put(".canopy/questions.json", '[{"question": "who is it for?"}]');
    expect((await builtinCheck("@questions", dir)).exit).toBe(0);
  });

  test("a seed's bunfig preload never runs: nothing here starts bun", async () => {
    await put("bunfig.toml", 'preload = ["./p.ts"]\n');
    await put("p.ts", `await Bun.write(${JSON.stringify(join(dir, "ran"))}, "x");\n`);
    await builtinCheck("@pick-check", dir);
    await builtinCheck("@questions", dir);
    expect(await Bun.file(join(dir, "ran")).exists()).toBe(false);
  });

  test("an unknown name says so", async () => {
    expect(await builtinCheck("@nope", dir)).toEqual({ exit: 2, output: "no built-in check @nope" });
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/core/builtincheck.test.ts`
Expected: FAIL with `Cannot find module './builtincheck'`.

- [ ] **Step 3: Write `src/core/builtincheck.ts`**

```ts
/**
 * Checks canopy runs in its own process, over files it reads through
 * readSeed: nothing a seed holds (a bunfig preload, a .env, a node_modules)
 * is loaded or run. A workflow names one as `check: @<name>`. Every other
 * check line is shell, which for a seed runs in the stages container.
 */
import type { CheckResult } from "./flow";
import { readSeed } from "./seed";
import { parsePick, parseQuestions, pickRefusal } from "./sprout";

export const isBuiltinCheck = (command: string): boolean => /^@[a-z][a-z-]*$/.test(command);

const fail = (output: string): CheckResult => ({ exit: 1, output });

async function pickCheck(seed: string): Promise<CheckResult> {
  const text = await readSeed(seed, ".canopy/pick.json");
  if (text === null) return fail(".canopy/pick.json is missing: research ends by writing it");
  const parsed = parsePick(text);
  if (!parsed.ok) return fail(`.canopy/pick.json: ${parsed.error}`);
  const refused = pickRefusal(parsed.pick);
  if (refused) return fail(`.canopy/pick.json: ${refused}`);
  if ((await readSeed(seed, ".canopy/research.md")) === null) return fail(".canopy/research.md is missing: research writes it before the pick");
  return { exit: 0, output: `pick ok: ${parsed.pick.kind} on ${parsed.pick.host}` };
}

async function questionsCheck(seed: string): Promise<CheckResult> {
  const text = await readSeed(seed, ".canopy/questions.json");
  if (text === null) return { exit: 0, output: "no questions" };
  const parsed = parseQuestions(text);
  return parsed.ok ? { exit: 0, output: `${parsed.questions.length} questions` } : fail(`.canopy/questions.json: ${parsed.error}`);
}

const BUILTINS: Readonly<Record<string, (seed: string) => Promise<CheckResult>>> = {
  "pick-check": pickCheck,
  questions: questionsCheck,
};

export async function builtinCheck(command: string, seedPath: string): Promise<CheckResult> {
  const name = command.slice(1);
  const run = Object.hasOwn(BUILTINS, name) ? BUILTINS[name] : undefined;
  return run ? run(seedPath) : { exit: 2, output: `no built-in check ${command}` };
}
```

Check `parseQuestions`'s return shape in `src/core/sprout.ts:220` before relying on `.ok`, `.questions` and `.error`, and use its real field names. The test fixes the behaviour, not the names.

- [ ] **Step 4: Route built-ins in the server's check hook** (`src/server/index.ts:2772`)

```ts
check: (repo, command) =>
  isBuiltinCheck(command) ? builtinCheck(command, repo.path) : runCheck(repo, command, isSeedPath(root, repo.path)),
```

Then edit the two bundled workflows:
- In `lib/workflows/scout.md`, replace `check: "$CANOPY_CLI" incubator pick-check` with `check: @pick-check`.
- In `lib/workflows/clarify.md`, replace the long `bun -e` line with `check: @questions`.

Update the expectations in `src/core/workflows.test.ts` that quote either line. Leave `canopy incubator pick-check` in the CLI for people to run by hand.

- [ ] **Step 5: Run the tests and watch them pass, then the gates**

Run: `SHELL=/bin/bash bun test src/core/builtincheck.test.ts src/core/workflows.test.ts && bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/core/builtincheck.ts src/core/builtincheck.test.ts src/server/index.ts lib/workflows/scout.md lib/workflows/clarify.md src/core/workflows.test.ts
git commit -m "feat(incubator): scout's and clarify's checks are built in and run in canopy over readSeed" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 5: the stage wire, pure

**Files:**
- Create: `src/core/stagewire.ts`
- Create: `src/core/stagewire.test.ts`

**Interfaces:**
- Produces:

```ts
export type StageRequest =
  | { t: "hello" }
  | { t: "spawn"; argv: string[]; cwd: string; env: Record<string, string> };
export type StageFrame =
  | { t: "in"; d: string }        // base64 stdin chunk, client to runner
  | { t: "eof" }                  // stdin closed
  | { t: "kill" }
  | { t: "out"; d: string }       // base64 stdout chunk, runner to client
  | { t: "err"; d: string }
  | { t: "exit"; code: number | null }
  | { t: "refused"; reason: string }
  | { t: "hello"; harnesses: string[] };
export const STAGE_PROGRAMS: readonly string[]; // ["claude", "codex", "sh"]
export const STAGE_PASSED_ENV: readonly string[]; // ["CANOPY_RUN", "CANOPY_REPO", "CANOPY_BACKEND"]
export const STAGE_BASE_ENV: readonly string[];   // ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "CLAUDE_CONFIG_DIR", "CODEX_HOME"]
export function encodeFrame(f: StageFrame | StageRequest): string;      // JSON + "\n"
export function parseFrame(line: string): StageFrame | StageRequest | null;
export function requestRefusal(req: StageRequest): string | null;      // argv/env shape; cwd containment is the runner's
export function childEnv(own: Record<string, string | undefined>, asked: Record<string, string>): Record<string, string>;
export function chunkB64(bytes: Uint8Array, max?: number): string[]; // base64 of slices of at most `max` (64 KiB) bytes
export const lineSplitter: () => (chunk: string) => string[]; // whole lines, keeping a partial tail
export const fromB64: (d: string) => Uint8Array;
export const STAGE_AWAY = "the stage runner is not answering";
export class StageAwayError extends Error {} // message STAGE_AWAY; flow.ts parks on it, so it lives here, browser-safe
```

- [ ] **Step 1: Write the failing tests** (`src/core/stagewire.test.ts`)

```ts
import { describe, expect, test } from "bun:test";
import { childEnv, chunkB64, encodeFrame, lineSplitter, parseFrame, requestRefusal } from "./stagewire";

describe("stage wire", () => {
  test("frames round-trip one per line", () => {
    const f = { t: "out", d: Buffer.from("hé\n").toString("base64") } as const;
    const line = encodeFrame(f);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseFrame(line)).toEqual(f);
  });
  test("a frame that is not one of ours is null", () => {
    expect(parseFrame("{}")).toBe(null);
    expect(parseFrame("nope")).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "out", d: 3 }))).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "spawn", argv: "sh", cwd: "/x", env: {} }))).toBe(null);
  });
  test("the runner starts only claude, codex or sh, by bare name", () => {
    const ok = { t: "spawn", argv: ["claude", "-p"], cwd: "/s/coin", env: {} } as const;
    expect(requestRefusal(ok)).toBe(null);
    for (const argv0 of ["/bin/sh", "bun", "../claude", "claude ", ""]) {
      expect(requestRefusal({ ...ok, argv: [argv0] })).toContain("program");
    }
    expect(requestRefusal({ ...ok, argv: [] })).toContain("program");
    expect(requestRefusal({ ...ok, cwd: "relative" })).toContain("cwd");
    expect(requestRefusal({ t: "hello" })).toBe(null);
  });
  test("the child env is the runner's base plus three names, whatever canopy sends", () => {
    const own = { PATH: "/usr/bin", HOME: "/home/bun", CLAUDE_CONFIG_DIR: "/c", SECRET: "no", GH_TOKEN: "no" };
    const asked = { CANOPY_RUN: "r1", CANOPY_REPO: "_incubator/coin", GH_TOKEN: "ghp_x", VERCEL_TOKEN: "v", PATH: "/evil", LD_PRELOAD: "/x.so" };
    expect(childEnv(own, asked)).toEqual({ PATH: "/usr/bin", HOME: "/home/bun", CLAUDE_CONFIG_DIR: "/c", CANOPY_RUN: "r1", CANOPY_REPO: "_incubator/coin" });
  });
  test("big output goes in 64 KiB slices", () => {
    const bytes = new Uint8Array(150_000).fill(65);
    const parts = chunkB64(bytes);
    expect(parts).toHaveLength(3);
    expect(Buffer.concat(parts.map((p) => Buffer.from(p, "base64"))).equals(Buffer.from(bytes))).toBe(true);
  });
  test("the splitter keeps a partial line for the next chunk", () => {
    const split = lineSplitter();
    expect(split('{"t":"ex')).toEqual([]);
    expect(split('it","code":0}\n{"t":"eo')).toEqual(['{"t":"exit","code":0}']);
    expect(split('f"}\n')).toEqual(['{"t":"eof"}']);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/core/stagewire.test.ts`
Expected: FAIL with `Cannot find module './stagewire'`.

- [ ] **Step 3: Write `src/core/stagewire.ts`**

```ts
/**
 * The wire between canopy and the stage runner: one unix-socket connection
 * per process, one JSON object per line, bytes as base64. Pure and
 * browser-safe (no Buffer: base64 through btoa/atob over byte strings).
 */
export type StageRequest = { t: "hello" } | { t: "spawn"; argv: string[]; cwd: string; env: Record<string, string> };
export type StageFrame =
  | { t: "in"; d: string }
  | { t: "eof" }
  | { t: "kill" }
  | { t: "out"; d: string }
  | { t: "err"; d: string }
  | { t: "exit"; code: number | null }
  | { t: "refused"; reason: string }
  | { t: "hello"; harnesses: string[] };

export const STAGE_PROGRAMS: readonly string[] = ["claude", "codex", "sh"];
export const STAGE_PASSED_ENV: readonly string[] = ["CANOPY_RUN", "CANOPY_REPO", "CANOPY_BACKEND"];
export const STAGE_BASE_ENV: readonly string[] = ["PATH", "HOME", "LANG", "LC_ALL", "TERM", "CLAUDE_CONFIG_DIR", "CODEX_HOME"];
const CHUNK = 64 * 1024;

export const encodeFrame = (f: StageFrame | StageRequest): string => `${JSON.stringify(f)}\n`;

const isStr = (v: unknown): v is string => typeof v === "string";
const isStrMap = (v: unknown): v is Record<string, string> =>
  typeof v === "object" && v !== null && !Array.isArray(v) && Object.values(v).every(isStr);

export function parseFrame(line: string): StageFrame | StageRequest | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null) return null;
  const o = v as Record<string, unknown>;
  switch (o["t"]) {
    case "in":
    case "out":
    case "err":
      return isStr(o["d"]) ? ({ t: o["t"], d: o["d"] } as StageFrame) : null;
    case "eof":
    case "kill":
    case "hello":
      if (o["t"] === "hello" && "harnesses" in o) {
        return Array.isArray(o["harnesses"]) && o["harnesses"].every(isStr) ? { t: "hello", harnesses: o["harnesses"] } : null;
      }
      return { t: o["t"] } as StageFrame | StageRequest;
    case "exit":
      return o["code"] === null || typeof o["code"] === "number" ? { t: "exit", code: o["code"] } : null;
    case "refused":
      return isStr(o["reason"]) ? { t: "refused", reason: o["reason"] } : null;
    case "spawn":
      return Array.isArray(o["argv"]) && o["argv"].every(isStr) && isStr(o["cwd"]) && isStrMap(o["env"])
        ? { t: "spawn", argv: o["argv"], cwd: o["cwd"], env: o["env"] }
        : null;
    default:
      return null;
  }
}

export function requestRefusal(req: StageRequest): string | null {
  if (req.t === "hello") return null;
  const prog = req.argv[0];
  if (prog === undefined || !STAGE_PROGRAMS.includes(prog)) return `the stage runner starts only ${STAGE_PROGRAMS.join(", ")}, by bare program name`;
  if (!req.cwd.startsWith("/")) return "the cwd must be an absolute path";
  return null;
}

export function childEnv(own: Record<string, string | undefined>, asked: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of STAGE_BASE_ENV) {
    const v = own[k];
    if (v !== undefined) out[k] = v;
  }
  for (const k of STAGE_PASSED_ENV) {
    const v = asked[k];
    if (v !== undefined) out[k] = v;
  }
  return out;
}

const toB64 = (bytes: Uint8Array): string => {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i] ?? 0);
  return btoa(s);
};
export const fromB64 = (d: string): Uint8Array => Uint8Array.from(atob(d), (c) => c.charCodeAt(0));

export function chunkB64(bytes: Uint8Array, max = CHUNK): string[] {
  const out: string[] = [];
  for (let i = 0; i < bytes.length; i += max) out.push(toB64(bytes.subarray(i, i + max)));
  return out;
}

export const STAGE_AWAY = "the stage runner is not answering";
/** what the Runner throws for a stage while the runner is away: a flow
 *  parks on it instead of failing */
export class StageAwayError extends Error {
  constructor() {
    super(STAGE_AWAY);
    this.name = "StageAwayError";
  }
}

export function lineSplitter(): (chunk: string) => string[] {
  let tail = "";
  return (chunk) => {
    const parts = (tail + chunk).split("\n");
    tail = parts.pop() ?? "";
    return parts.filter((p) => p.length > 0);
  };
}
```

- [ ] **Step 4: Run them and watch them pass**

Run: `SHELL=/bin/bash bun test src/core/stagewire.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates, then commit**

```bash
git add src/core/stagewire.ts src/core/stagewire.test.ts
git commit -m "feat(stages): the stage runner's wire, frames, refusals and the child env" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 6: the stage runner daemon

**Files:**
- Create: `src/stage/runner.ts`
- Create: `src/stage/main.ts`
- Create: `src/stage/runner.test.ts`

**Interfaces:**
- Consumes: Task 5's wire. `descendants` and `processTree`'s proc reader from `src/core/procs.ts`. Read that file's exports before using them, and use whichever lists `{pid, ppid}` for every process.
- Produces:
  - `startStageRunner(opts: { socket: string; root: string; env?: Record<string, string | undefined>; programs?: Record<string, string> }): Promise<{ stop(): Promise<void> }>`
  - `opts.programs` maps a bare name to the command it runs. Tests map `claude` to a stand-in script. The real daemon maps each name to itself.
  - `src/stage/main.ts` reads `CANOPY_STAGE_SOCKET` and `CANOPY_STAGE_ROOT` and starts it.

- [ ] **Step 1: Write the failing tests** (`src/stage/runner.test.ts`)

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { encodeFrame, fromB64, lineSplitter, parseFrame, type StageFrame, type StageRequest } from "../core/stagewire";
import { startStageRunner } from "./runner";

let dir = "";
let root = "";
let sock = "";
let stop: () => Promise<void> = async () => {};

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cs-"));
  root = join(dir, "_incubator");
  await mkdir(join(root, "coin"), { recursive: true });
  await mkdir(join(root, ".shared"), { recursive: true });
  await mkdir(join(root, "coin", "sub"), { recursive: true });
  await symlink("/", join(root, "escape"));
  sock = join(dir, "s.sock");
  const r = await startStageRunner({ socket: sock, root, env: { PATH: process.env["PATH"], HOME: dir, GH_TOKEN: "own-secret" } });
  stop = r.stop;
});
afterAll(async () => {
  await stop();
  await rm(dir, { recursive: true, force: true });
});

/** one connection: send the request and frames, collect every frame back until exit or refused */
async function talk(req: StageRequest, frames: StageFrame[] = [], waitMs = 5000): Promise<StageFrame[]> {
  const got: StageFrame[] = [];
  const split = lineSplitter();
  return new Promise((resolve, reject) => {
    const c = connect(sock, () => {
      c.write(encodeFrame(req));
      for (const f of frames) c.write(encodeFrame(f));
    });
    const t = setTimeout(() => (c.destroy(), reject(new Error(`no end: ${JSON.stringify(got)}`))), waitMs);
    c.on("data", (b) => {
      for (const line of split(b.toString())) {
        const f = parseFrame(line) as StageFrame | null;
        if (!f) continue;
        got.push(f);
        if (f.t === "exit" || f.t === "refused" || f.t === "hello") (clearTimeout(t), c.end(), resolve(got));
      }
    });
    c.on("error", reject);
  });
}
const text = (fs: StageFrame[], t: "out" | "err") =>
  Buffer.concat(fs.filter((f) => f.t === t).map((f) => Buffer.from(fromB64((f as { d: string }).d)))).toString();

describe("the stage runner", () => {
  test("hello lists the harnesses on its PATH", async () => {
    const [f] = await talk({ t: "hello" });
    expect(f?.t).toBe("hello");
  });

  test("sh runs in a seed, stdin in, stdout out, the exit code back", async () => {
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "cat; echo $PWD; exit 3"], cwd: join(root, "coin"), env: {} }, [
      { t: "in", d: btoa("hello\n") },
      { t: "eof" },
    ]);
    expect(text(fs, "out")).toBe(`hello\n${join(root, "coin")}\n`);
    expect(fs.at(-1)).toEqual({ t: "exit", code: 3 });
  });

  test("the child's env holds no token, its own or one canopy sent", async () => {
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "env"], cwd: join(root, "coin"), env: { GH_TOKEN: "sent", CANOPY_RUN: "r1" } });
    const env = text(fs, "out");
    expect(env).not.toContain("GH_TOKEN");
    expect(env).toContain("CANOPY_RUN=r1");
  });

  test.each([
    ["a symlink out of the root", () => join(root, "escape")],
    ["a dot folder", () => join(root, ".shared")],
    ["a nested folder", () => join(root, "coin", "sub")],
    ["the root itself", () => root],
    ["a missing folder", () => join(root, "nope")],
  ])("%s is refused before anything starts", async (_name, cwd) => {
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", `touch ${join(dir, "ran")}`], cwd: cwd(), env: {} });
    expect(fs.at(-1)?.t).toBe("refused");
    expect(await Bun.file(join(dir, "ran")).exists()).toBe(false);
  });

  test("a program not on the list is refused", async () => {
    const fs = await talk({ t: "spawn", argv: ["/bin/sh", "-c", "true"], cwd: join(root, "coin"), env: {} });
    expect(fs.at(-1)?.t).toBe("refused");
  });

  test("closing the connection kills the child and its grandchildren", async () => {
    const pidFile = join(dir, "grandchild.pid");
    const c = connect(sock);
    await new Promise<void>((r) => c.on("connect", () => r()));
    // the grandchild is a backgrounded sleep that would outlive a plain kill of sh
    c.write(encodeFrame({ t: "spawn", argv: ["sh", "-c", `sleep 300 & echo $! > ${pidFile}; wait`], cwd: join(root, "coin"), env: {} }));
    for (let i = 0; i < 100 && !(await Bun.file(pidFile).exists()); i++) await Bun.sleep(20);
    const pid = Number((await Bun.file(pidFile).text()).trim());
    expect(() => process.kill(pid, 0)).not.toThrow();
    c.destroy();
    let alive = true;
    for (let i = 0; i < 100 && alive; i++) {
      await Bun.sleep(20);
      try {
        process.kill(pid, 0);
      } catch {
        alive = false;
      }
    }
    expect(alive).toBe(false);
  });

  test("a kill frame ends the process and the exit frame still comes", async () => {
    const fs = await talk({ t: "spawn", argv: ["sh", "-c", "sleep 300"], cwd: join(root, "coin"), env: {} }, [{ t: "kill" }]);
    expect(fs.at(-1)?.t).toBe("exit");
  });
});
```

`fromB64` is exported from `stagewire.ts` in Task 5. Add it to that task's export list if it is missing there.

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/stage/runner.test.ts`
Expected: FAIL with `Cannot find module './runner'`.

- [ ] **Step 3: Write `src/stage/runner.ts`**

```ts
/**
 * The stage runner: the one way canopy starts a process in the stages
 * container. It listens on a unix socket shared with canopy's container; a
 * connection carries one request. It starts only claude, codex or sh, only
 * in a seed (a direct, non-dot child of the stage root, by realpath), with an
 * env built from its own base and three CANOPY_* names, never what canopy
 * sends. A connection that closes, or a kill frame, ends the process and
 * every descendant.
 */
import { realpath, rm } from "node:fs/promises";
import { createServer, type Socket } from "node:net";
import { basename, dirname } from "node:path";
import { childEnv, chunkB64, encodeFrame, fromB64, lineSplitter, parseFrame, requestRefusal, STAGE_PROGRAMS, type StageFrame, type StageRequest } from "../core/stagewire";

export interface RunnerOptions {
  socket: string;
  root: string;
  env?: Record<string, string | undefined>;
  programs?: Record<string, string>;
}

async function seedRefusal(root: string, cwd: string): Promise<string | null> {
  const real = await realpath(cwd).catch(() => null);
  if (real === null) return "the cwd does not exist";
  const realRoot = await realpath(root);
  if (dirname(real) !== realRoot || basename(real).startsWith(".")) return "the cwd is not a seed under the stage root";
  return null;
}

/** every pid below `root`, deepest first, read from /proc */
async function tree(root: number): Promise<number[]> {
  const { readdir, readFile } = await import("node:fs/promises");
  const kids = new Map<number, number[]>();
  for (const name of await readdir("/proc").catch(() => [] as string[])) {
    if (!/^\d+$/.test(name)) continue;
    const stat = await readFile(`/proc/${name}/stat`, "utf8").catch(() => "");
    const ppid = Number(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[1]);
    if (!Number.isFinite(ppid)) continue;
    kids.set(ppid, [...(kids.get(ppid) ?? []), Number(name)]);
  }
  const out: number[] = [];
  const walk = (p: number) => {
    for (const c of kids.get(p) ?? []) {
      walk(c);
      out.push(c);
    }
  };
  walk(root);
  return out;
}

async function killTree(pid: number): Promise<void> {
  const below = process.platform === "linux" ? await tree(pid) : [];
  for (const p of [...below, pid]) {
    try {
      process.kill(p, "SIGKILL");
    } catch {
      // already gone
    }
  }
}
```

A Mac has no `/proc`, so there `killTree` walks the tree with `pgrep -P` instead. The kill-the-grandchild test runs on both, which is what lets the suite pass on the Mac and still prove the Linux path in the container build. Write that branch:

```ts
async function treeMac(root: number): Promise<number[]> {
  const out: number[] = [];
  const walk = async (p: number) => {
    const r = Bun.spawnSync(["pgrep", "-P", String(p)]);
    for (const line of r.stdout.toString().split("\n")) {
      const c = Number(line.trim());
      if (!c) continue;
      await walk(c);
      out.push(c);
    }
  };
  await walk(root);
  return out;
}
```

`killTree` uses `process.platform === "linux" ? tree(pid) : treeMac(pid)`, and the test runs on both.

```ts
export async function startStageRunner(opts: RunnerOptions): Promise<{ stop(): Promise<void> }> {
  const own = opts.env ?? process.env;
  const programs = opts.programs ?? Object.fromEntries(STAGE_PROGRAMS.map((p) => [p, p]));
  await rm(opts.socket, { force: true });
  const live = new Set<Socket>();

  const server = createServer((sock) => {
    live.add(sock);
    const split = lineSplitter();
    const send = (f: StageFrame) => {
      if (!sock.destroyed) sock.write(encodeFrame(f));
    };
    let proc: ReturnType<typeof Bun.spawn> | null = null;
    let started = false;
    const pending: StageFrame[] = [];

    const handle = async (f: StageFrame | StageRequest) => {
      if (!started) {
        started = true;
        if (f.t === "hello") {
          const harnesses = ["claude", "codex"].filter((h) => Bun.which(programs[h] ?? h, { PATH: own["PATH"] ?? "" }));
          send({ t: "hello", harnesses });
          return;
        }
        if (f.t !== "spawn") return send({ t: "refused", reason: "the first frame must be a request" });
        const refused = requestRefusal(f) ?? (await seedRefusal(opts.root, f.cwd));
        if (refused) return send({ t: "refused", reason: refused });
        const [prog, ...rest] = f.argv;
        proc = Bun.spawn([programs[prog ?? ""] ?? "", ...rest], {
          cwd: f.cwd,
          env: childEnv(own, f.env),
          stdin: "pipe",
          stdout: "pipe",
          stderr: "pipe",
        });
        const pump = async (stream: ReadableStream<Uint8Array>, t: "out" | "err") => {
          for await (const bytes of stream) for (const d of chunkB64(bytes)) send({ t, d });
        };
        const p = proc;
        void Promise.all([pump(p.stdout as ReadableStream<Uint8Array>, "out"), pump(p.stderr as ReadableStream<Uint8Array>, "err"), p.exited]).then(() => {
          send({ t: "exit", code: p.exitCode });
          sock.end();
        });
        for (const q of pending.splice(0)) await handle(q);
        return;
      }
      if (!proc) return pending.push(f as StageFrame);
      const stdin = (proc as { stdin: { write(b: Uint8Array): unknown; flush(): unknown; end(): unknown } }).stdin;
      if (f.t === "in") (stdin.write(fromB64(f.d)), stdin.flush());
      else if (f.t === "eof") stdin.end();
      else if (f.t === "kill") await killTree(proc.pid);
    };

    let chain = Promise.resolve();
    sock.on("data", (b) => {
      for (const line of split(b.toString("utf8"))) {
        const f = parseFrame(line);
        if (f) chain = chain.then(() => handle(f));
      }
    });
    sock.on("close", () => {
      live.delete(sock);
      if (proc && proc.exitCode === null) void killTree(proc.pid);
    });
    sock.on("error", () => {});
  });

  await new Promise<void>((resolve) => server.listen(opts.socket, resolve));
  return {
    stop: async () => {
      for (const s of live) s.destroy();
      await new Promise<void>((r) => server.close(() => r()));
      await rm(opts.socket, { force: true });
    },
  };
}
```

`src/stage/main.ts`:

```ts
import { startStageRunner } from "./runner";

import { StageClient } from "../core/stageclient";

const socket = process.env["CANOPY_STAGE_SOCKET"];
const root = process.env["CANOPY_STAGE_ROOT"];
if (!socket || !root) {
  console.error("canopy-stage-runner needs CANOPY_STAGE_SOCKET and CANOPY_STAGE_ROOT");
  process.exit(2);
}
if (process.argv.includes("--health")) {
  // compose's healthcheck: the runner answers a hello on its own socket
  process.exit((await new StageClient(socket).hello(2000)) ? 0 : 1);
}
await startStageRunner({ socket, root });
console.log(`canopy-stage-runner on ${socket}, seeds under ${root}`);
```

`StageClient` arrives in Task 7. Write `main.ts` without the `--health` branch here, and add the branch in Task 7, whose commit then includes `src/stage/main.ts`.

- [ ] **Step 4: Run them and watch them pass**

Run: `SHELL=/bin/bash bun test src/stage/runner.test.ts`
Expected: PASS. The socket path must stay under the 104-byte unix limit, which is why the temp dir is named `cs-`.

- [ ] **Step 5: Gates, then commit.** The root `tsconfig.json` must include `src/stage/`, so check its `include` list.

```bash
git add src/stage/runner.ts src/stage/main.ts src/stage/runner.test.ts tsconfig.json
git commit -m "feat(stages): the stage runner daemon, one process per connection, its tree killed on close" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 7: the stage client

**Files:**
- Create: `src/core/stageclient.ts`
- Create: `src/core/stageclient.test.ts`
- Modify: `src/stage/main.ts` (the `--health` branch)

**Interfaces:**
- Consumes: Task 5's wire. `RpcSpawn`, `RpcProc` and `RpcWriter` from `src/core/codexrpc.ts`. `ExecResult` from `src/core/exec.ts`.
- Produces:

```ts
export class StageClient {
  constructor(socket: string);
  readonly spawn: RpcSpawn;                       // a proc whose stdio rides the socket
  exec(argv: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<ExecResult>;
  hello(timeoutMs?: number): Promise<string[] | null>; // null: not answering
  harnessesNow(): string[] | null;               // the last hello, refreshed by watch()
  watch(everyMs?: number, onUp?: () => void): () => void; // re-hellos on a timer; onUp on each answer after a miss; returns stop
}
```

- [ ] **Step 1: Write the failing tests** (`src/core/stageclient.test.ts`). They run the real daemon from Task 6.

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStageRunner } from "../stage/runner";
import { StageClient } from "./stageclient";

let dir = "";
let seed = "";
let client: StageClient;
let stop: () => Promise<void> = async () => {};
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "cc-"));
  const root = join(dir, "_incubator");
  seed = join(root, "coin");
  await mkdir(seed, { recursive: true });
  const sock = join(dir, "s.sock");
  stop = (await startStageRunner({ socket: sock, root, env: { PATH: process.env["PATH"], HOME: dir } })).stop;
  client = new StageClient(sock);
});
afterAll(async () => {
  await stop();
  await rm(dir, { recursive: true, force: true });
});

describe("the stage client", () => {
  test("exec runs a check and hands back code, stdout and stderr", async () => {
    const r = await client.exec(["sh", "-c", "echo out; echo err >&2; exit 4"], { cwd: seed, timeoutMs: 5000 });
    expect(r).toEqual({ code: 4, stdout: "out\n", stderr: "err\n" });
  });

  test("a refusal is an exit 126 with the reason, and nothing runs", async () => {
    const r = await client.exec(["sh", "-c", "true"], { cwd: dir, timeoutMs: 5000 });
    expect(r.code).toBe(126);
    expect(r.stderr).toContain("not a seed");
  });

  test("spawn: a JSON line written before the child reads arrives whole, and 1 MB comes back byte for byte", async () => {
    const line = '{"type":"user","message":"hi"}';
    const p = client.spawn(["sh", "-c", "head -n1; head -c 1048576 /dev/zero | tr '\\0' a"], { cwd: seed, env: {} });
    p.stdin.write(`${line}\n`);
    p.stdin.end();
    const out = await new Response(p.stdout).text();
    expect(out.startsWith(`${line}\n`)).toBe(true);
    expect(out.length).toBe(line.length + 1 + 1_048_576);
    expect(await p.exited).toBe(0);
  });

  test("kill ends a spawned process", async () => {
    const p = client.spawn(["sh", "-c", "sleep 300"], { cwd: seed, env: {} });
    await Bun.sleep(50);
    p.kill();
    expect(await p.exited).not.toBe(0);
  });

  test("a timeout kills and says so", async () => {
    const r = await client.exec(["sh", "-c", "sleep 300"], { cwd: seed, timeoutMs: 200 });
    expect(r.code).not.toBe(0);
  });

  test("watch calls onUp once when the runner first answers", async () => {
    let ups = 0;
    const stopWatch = client.watch(50, () => ups++);
    await Bun.sleep(200);
    stopWatch();
    expect(ups).toBe(1);
  });

  test("hello answers, and a dead socket reads as not answering", async () => {
    expect(await client.hello()).toEqual(expect.any(Array));
    expect(await new StageClient(join(dir, "none.sock")).hello(300)).toBe(null);
  });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/core/stageclient.test.ts`
Expected: FAIL with `Cannot find module './stageclient'`.

- [ ] **Step 3: Write `src/core/stageclient.ts`**

```ts
/**
 * canopy's side of the stage runner: a process in the stages container as
 * the RpcProc the drivers already speak (stdin writer, stdout and stderr
 * streams, an exit promise, kill), plus exec for a check and hello for what
 * the runner has. Bun.
 */
import { connect, type Socket } from "node:net";
import type { RpcProc, RpcSpawn } from "./codexrpc";
import type { ExecResult } from "./exec";
import { chunkB64, encodeFrame, fromB64, lineSplitter, parseFrame, type StageFrame, type StageRequest } from "./stagewire";

const enc = new TextEncoder();

export class StageClient {
  private last: string[] | null = null;
  constructor(private readonly socket: string) {}

  readonly spawn: RpcSpawn = (argv, { cwd, env }) => this.open({ t: "spawn", argv: [...argv], cwd, env: clean(env) });

  private open(req: StageRequest): RpcProc & { refused: Promise<string | null> } {
    const sock: Socket = connect(this.socket);
    let outCtl!: ReadableStreamDefaultController<Uint8Array>;
    let errCtl!: ReadableStreamDefaultController<Uint8Array>;
    const stdout = new ReadableStream<Uint8Array>({ start: (c) => void (outCtl = c) });
    const stderr = new ReadableStream<Uint8Array>({ start: (c) => void (errCtl = c) });
    let settle!: (code: number | null) => void;
    let refuse!: (r: string | null) => void;
    const exited = new Promise<number | null>((r) => (settle = r));
    const refused = new Promise<string | null>((r) => (refuse = r));
    let done = false;
    const finish = (code: number | null, reason: string | null) => {
      if (done) return;
      done = true;
      refuse(reason);
      try { outCtl.close(); } catch {}
      try { errCtl.close(); } catch {}
      settle(code);
    };
    const write = (f: StageFrame | StageRequest) => {
      if (!sock.destroyed) sock.write(encodeFrame(f));
    };
    sock.on("connect", () => write(req));
    const split = lineSplitter();
    sock.on("data", (b) => {
      for (const line of split(b.toString("utf8"))) {
        const f = parseFrame(line);
        if (!f) continue;
        if (f.t === "out") outCtl.enqueue(fromB64(f.d));
        else if (f.t === "err") errCtl.enqueue(fromB64(f.d));
        else if (f.t === "exit") finish(f.code, null);
        else if (f.t === "refused") {
          errCtl.enqueue(enc.encode(`${f.reason}\n`));
          finish(126, f.reason);
        }
      }
    });
    sock.on("error", (e) => {
      errCtl.enqueue(enc.encode(`the stage runner is not answering: ${e.message}\n`));
      finish(127, "the stage runner is not answering");
    });
    sock.on("close", () => finish(null, null));
    return {
      stdin: {
        write: (chunk: string) => {
          for (const d of chunkB64(enc.encode(chunk))) write({ t: "in", d });
        },
        flush: () => undefined,
        end: () => write({ t: "eof" }),
      },
      stdout,
      stderr,
      exited,
      refused,
      kill: () => write({ t: "kill" }),
    };
  }

  async exec(argv: string[], opts: { cwd: string; timeoutMs: number; env?: Record<string, string> }): Promise<ExecResult> {
    const p = this.open({ t: "spawn", argv, cwd: opts.cwd, env: opts.env ?? {} });
    p.stdin.end();
    const timer = setTimeout(() => p.kill(), opts.timeoutMs);
    const [stdout, stderr, code] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text(), p.exited]);
    clearTimeout(timer);
    return { code: code ?? 137, stdout, stderr };
  }

  async hello(timeoutMs = 2000): Promise<string[] | null> {
    const answer = await new Promise<string[] | null>((resolve) => {
      const sock = connect(this.socket);
      const t = setTimeout(() => (sock.destroy(), resolve(null)), timeoutMs);
      const split = lineSplitter();
      sock.on("connect", () => sock.write(encodeFrame({ t: "hello" })));
      sock.on("data", (b) => {
        for (const line of split(b.toString("utf8"))) {
          const f = parseFrame(line);
          if (f && f.t === "hello" && "harnesses" in f) (clearTimeout(t), sock.end(), resolve(f.harnesses));
        }
      });
      sock.on("error", () => (clearTimeout(t), resolve(null)));
    });
    this.last = answer;
    return answer;
  }

  harnessesNow(): string[] | null {
    return this.last;
  }

  watch(everyMs = 15_000, onUp?: () => void): () => void {
    let up = false;
    const beat = async () => {
      const now = (await this.hello()) !== null;
      if (now && !up) onUp?.();
      up = now;
    };
    void beat();
    const t = setInterval(() => void beat(), everyMs);
    return () => clearInterval(t);
  }
}

const clean = (env: Record<string, string | undefined>): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined) out[k] = v;
  return out;
};
```

`RpcWriter.write` takes a string, and that is what both drivers write: JSON lines. If `RpcSpawn`'s option type requires more fields, match it exactly.

- [ ] **Step 4: Run them and watch them pass**

Run: `SHELL=/bin/bash bun test src/core/stageclient.test.ts`
Expected: PASS.

- [ ] **Step 5: Gates, then commit**

Then add the `--health` branch to `src/stage/main.ts` that Task 6 left out.

```bash
git add src/core/stageclient.ts src/core/stageclient.test.ts src/stage/main.ts
git commit -m "feat(stages): the stage client, an RpcSpawn and an exec over the runner's socket" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 8: stage runs and checks go through the client

**Files:**
- Modify: `src/core/driver.ts` (`DriveCtx.spawn?`)
- Modify: `src/core/claudedrive.ts` (spawns through `RpcSpawn`)
- Modify: `src/core/codexrun.ts` (`ctx.spawn` first)
- Modify: `src/core/runner.ts` (`RunnerOptions.stageExec`)
- Modify: `src/core/check.ts` (a stage check through the client)
- Test: `src/core/runner-drivers.test.ts`, `src/core/check.test.ts` (create if missing)

**Interfaces:**
- Consumes: `StageClient` (Task 7).
- Produces:
  - `DriveCtx.spawn?: RpcSpawn`. When set, the driver starts its harness through it, by bare program name (`claude` or `codex`), never `claudeBinary()`'s local path.
  - `RunnerOptions.stageExec?: () => StageClient | null`. A stage run with no client gets `null` and throws `StageAwayError` (Task 5).
  - `Runner.liveIn(path: string): boolean`: true from a run's spawn until its process has exited, before the end-of-run status read. With the flows' running checks it is what `setSeedBusy` (Task 1) reads.
  - `Flows.checking(path: string): boolean`: true while a step's check runs on that repo.
  - A flow whose step start throws `StageAwayError` parks through the same path a spent budget takes, with the reason, so `resume` continues it. Any other throw still fails the flow, as today (`flow.ts:676`).
  - A stage run's harness check reads `harnessesNow()`.
  - `runCheck(repo, command, stage, client?: StageClient | null)`. A stage check runs `client.exec(["sh", "-lc", command], {cwd, timeoutMs})`. A stage check with `client === null` returns `{exit: 127, output: "the stage runner is not answering"}`.
  - An `undefined` client means unisolated mode, which keeps today's local exec.

- [ ] **Step 1: Write the failing tests**

In `src/core/runner-drivers.test.ts`, add a recording spawn:

```ts
test("a stage run starts through the stage spawn by bare name, and a plain run does not", async () => {
  const seen: { argv: readonly string[]; cwd: string }[] = [];
  const fakeSpawn: RpcSpawn = (argv, { cwd }) => {
    seen.push({ argv, cwd });
    return bunSpawn([process.execPath, FAKE_CLAUDE], { cwd, env: process.env });
  };
  const stageClient = { spawn: fakeSpawn, harnessesNow: () => ["claude"] } as unknown as StageClient;
  const runner = new Runner({ onChange: () => {} }, { stage: (r) => r.path.includes("/_incubator/"), stageExec: () => stageClient });
  // a seed repo and a plain repo, each started as a claude job; use the file's existing repo fixture helper
  // ...start both, wait for both to end...
  expect(seen).toHaveLength(1);
  expect(seen[0]?.argv[0]).toBe("claude");
  expect(seen[0]?.cwd).toContain("/_incubator/");
});

test("a stage run with no stage runner refuses before a run exists", () => {
  const runner = new Runner({ onChange: () => {} }, { stage: () => true, stageExec: () => null });
  expect(() => runner.start(seedRepo, "ask", "go", { ...DEFAULT_AGENT })).toThrow(StageAwayError);
});

test("liveIn holds from spawn to exit, and is clear by the end-of-run status read", async () => {
  const seenAtRead: boolean[] = [];
  let runner!: Runner;
  runner = new Runner(
    {
      onChange: () => {},
      onGone: () => {},
      // the runner's settle() reads status once the process is over
      status: async () => (seenAtRead.push(runner.liveIn(seedRepo.path)), null),
    },
    { stage: () => true, stageExec: () => stageClient },
  );
  const run = runner.start(seedRepo, "ask", spec, "", { ...DEFAULT_AGENT });
  await waitFor(() => runner.liveIn(seedRepo.path));
  await waitFor(() => runner.get(run.id)?.status !== "running");
  expect(seenAtRead).toEqual([false]);
  expect(runner.liveIn(seedRepo.path)).toBe(false);
});

test("a stage run whose runner lacks the harness refuses in words", () => {
  const client = { spawn: (() => { throw new Error("no"); }) as RpcSpawn, harnessesNow: () => ["claude"] } as unknown as StageClient;
  const runner = new Runner({ onChange: () => {} }, { stage: () => true, stageExec: () => client });
  expect(() => runner.start(seedRepo, "ask", "go", { ...DEFAULT_AGENT, harness: "codex" })).toThrow("codex is not installed in the stages container");
});
```

Use the file's existing names for the fake claude script, the repo fixture and `Runner`'s constructor arguments. Read the top of the file first, and match its `start` signature exactly. `stageClient` is the recording client from the first test; `spec` and `waitFor` are whatever the file already uses for an `ActionSpec` and a poll, and if it has no poll, add a ten-line one that checks every 10 ms for 5 s. The runner's real `start` is `start(repo, action, spec, note, agent)`.

In `src/core/flow.test.ts`, with the file's fake `FlowRunner`:

```ts
test("a step whose start finds the stage runner away parks, and resume runs it", async () => {
  let away = true;
  const runner = fakeRunner({ start: () => { if (away) throw new StageAwayError(); return fakeRun(); } });
  const flows = makeFlows(runner);
  const f = flows.start(repo, workflow, "");
  expect(flows.get(f.id)?.status).toBe("parked");
  expect(flows.get(f.id)?.parkedFor).toContain("the stage runner is not answering");
  away = false;
  flows.resume(f.id, "continue");
  expect(flows.get(f.id)?.status).toBe("working");
});
```

Use the file's real fake and status names. Read how a spent budget parks first (`parkedFor`), and park the same way.

In `src/core/check.test.ts`:

```ts
test("a stage check runs through the client, and with none it says the runner is not answering", async () => {
  const calls: { argv: string[]; cwd: string }[] = [];
  const client = { exec: async (argv: string[], o: { cwd: string }) => (calls.push({ argv, cwd: o.cwd }), { code: 0, stdout: "ok", stderr: "" }) } as unknown as StageClient;
  expect(await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, client)).toEqual({ exit: 0, output: "ok" });
  expect(calls).toEqual([{ argv: ["sh", "-lc", "bun test"], cwd: "/w/_incubator/coin" }]);
  expect(await runCheck({ path: "/w/_incubator/coin" }, "bun test", true, null)).toEqual({ exit: 127, output: "the stage runner is not answering" });
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/core/runner-drivers.test.ts src/core/check.test.ts`
Expected: FAIL. `stageExec` is ignored, and `runCheck` takes no client.

- [ ] **Step 3: Implement**
- **`driver.ts`.** Add `readonly spawn?: RpcSpawn` to `DriveCtx` (and to `RunCtx`'s init), with the comment: "a stage's process, started in the stages container; its env is the runner's own, so `spawnEnv` is only what the runner may pass on".
- **`claudedrive.ts`.**
  - Change `proc` to `RpcProc | null`.
  - In `drive()`, use `const spawn = ctx.spawn ?? this.opts.spawn ?? bunSpawn;`.
  - Set `const command = ctx.spawn ? ["claude"] : (this.opts.command?.length ? [...this.opts.command] : [this.bin ?? claudeBinary() ?? "claude"]);`.
  - Start it with `proc = spawn([...command, ...cliArgs(ctx.spec, agent, ctx.stage ?? false)], { cwd: ctx.cwd, env: spawnEnv(ctx) });`.
  - `send()` writes through `proc.stdin.write(...)` and awaits `proc.stdin.flush?.()`.
  - Stop and kill go through `proc.kill()`.
  - `new Response(proc.stderr ?? new ReadableStream())` reads stderr.
  - `proc.exited` resolves the code.
  - Add `spawn?: RpcSpawn` to `ClaudeOptions` for tests.
  - The existing tests against `testdata/fake-claude.ts` must still pass unchanged.
- **`codexrun.ts`.** At the spawn site, use `(ctx.spawn ?? this.opts.spawn ?? bunSpawn)`. When `ctx.spawn` is set, the command is `["codex"]`, not a resolved path.
- **`runner.ts`.**
  - Add `stageExec?: () => StageClient | null` to `RunnerOptions`.
  - In `start`, after the busy and note checks, compute `const stage = this.opts.stage?.(repo) ?? false;` and `const client = stage && this.opts.stageExec ? this.opts.stageExec() : undefined;`.
  - If `client === null`, throw `new StageAwayError()`.
  - Keep a `Set<string>` of repo paths with a live process. Add the path when the driver spawns, and drop it when the process's `exited` settles, before the end-of-run status read. `liveIn(path)` reads it.
  - If `client`, replace `driver.check()` with `client.harnessesNow()?.includes(agent.harness) ? null : \`${agent.harness} is not installed in the stages container\``.
  - Otherwise keep `driver.check()`.
  - Pass `spawn: client?.spawn` into the ctx.
- **`flow.ts`.** In the `catch` at the step start (`flow.ts:676`), an error with `name === "StageAwayError"` parks the flow with its message instead of failing it. Compare by name, so `flow.ts` imports nothing new. Keep a `Set` of repo paths whose check is running, and expose it as `checking(path)`.
- **`check.ts`.**
  - Add the fourth parameter `client?: StageClient | null`.
  - For `stage && client === null`, return the refusal.
  - For `stage && client`, run `client.exec(["sh", "-lc", command], { cwd: path, timeoutMs: CHECK_TIMEOUT })` and fold the result through the same output cap.
  - Everything else is unchanged.

- [ ] **Step 4: Run them and watch them pass, then the whole suite**

Run: `SHELL=/bin/bash bun test src/core/runner-drivers.test.ts src/core/check.test.ts src/core/claudedrive.test.ts src/core/codexrun.test.ts && bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/core/driver.ts src/core/claudedrive.ts src/core/codexrun.ts src/core/runner.ts src/core/flow.ts src/core/check.ts src/core/runner-drivers.test.ts src/core/flow.test.ts src/core/check.test.ts
git commit -m "feat(stages): stage runs and checks start through the stage runner, by bare program name" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 9: the server wires it, fails closed and says so

**Files:**
- Modify: `src/server/index.ts` (read the env, build the client, pass `stageExec` and the client to checks, `isolation`)
- Modify: `src/core/incubator.ts` (`IncubatorDeps.isolation`, gate in `pump`)
- Modify: `src/server/incubator.ts` (`isolated` in `GET /api/incubator`)
- Modify: `src/core/types.ts` (the incubator info type gains `isolated: boolean`)
- Modify: `ui/src/components/Incubator.tsx` (the word)
- Test: `src/core/incubator.test.ts`, `src/server/incubator.test.ts`

**Interfaces:**
- Consumes: Tasks 7 and 8.
- Produces:
  - `IncubatorDeps.isolation?: () => string | null`. A string is why stages cannot start now. `pump` then leaves the queued sprout queued, starts nothing and claims no slot. Null means go.
  - `Incubator.waiting(): string | null` is that reason, for the API.
  - `StageClient.watch(everyMs, onUp)`: `onUp` fires when a hello answers after one that did not, or after the first. The server's `onUp` is `incubator.pump()`, so queued sprouts start on their own once the runner is back.
  - `startServer({ incubator: { stage } })` takes a `StageClient | null` for tests.
  - The server rule:

```ts
const socket = process.env["CANOPY_STAGE_SOCKET"];
const unisolated = process.env["CANOPY_INCUBATOR_UNISOLATED"] === "1";
const stage: StageClient | null = opts.incubator?.stage !== undefined ? opts.incubator.stage : socket ? new StageClient(socket) : null;
const isolation = (): string | null =>
  stage ? (stage.harnessesNow() ? null : "the stage runner is not answering")
    : unisolated ? null
    : "stages need the stage runner (CANOPY_STAGE_SOCKET), or CANOPY_INCUBATOR_UNISOLATED=1";
// Runner: stageExec: () => (stage ? (stage.harnessesNow() ? stage : null) : unisolated ? undefined : null)
```

`stageExec` returning `undefined` means unisolated: run locally as today. Widen the Task 8 type to `() => StageClient | null | undefined` and keep the semantics. `stage.watch(15_000, () => void incubator.pump())` starts with the server and is stopped on server stop. Before the flows' `restore()` and the incubator's first `pump`, the server awaits one `stage.hello(10_000)`, so a restored mid-step flow finds the runner when compose started both together. If that hello fails, the flow parks (Task 8) and the sprouts wait.

`setSeedBusy` (Task 1) becomes `(path) => runner.liveIn(path) || flows.checking(path)`.

- [ ] **Step 1: Write the failing tests**

In `src/core/incubator.test.ts`, inside the "scout and build-new" describe:

```ts
test("with no isolation a queued sprout waits, holds no slot, and starts on the next pump once isolation answers", async () => {
  let why: string | null = "the stage runner is not answering";
  const w = world({ isolation: () => why });
  const s = await w.inc.create(intake({ text: "coin counter" }));
  await w.inc.idle();
  expect(now(w, s.id).status).toBe("queued");
  expect(now(w, s.id).flows).toHaveLength(0);
  expect(w.inc.waiting()).toBe("the stage runner is not answering");
  why = null;
  await w.inc.pump();
  await w.inc.idle();
  expect(now(w, s.id).status).toBe("clarifying");
  expect(w.inc.waiting()).toBe(null);
});
```

`world()` must accept an `isolation` override. Add it to the fixture's deps the same way `ship` was added.

In `src/server/incubator.test.ts`, check the API and the env rule. The suite's server is started with `CANOPY_INCUBATOR_UNISOLATED` unset and `stage: null`:

```ts
test("the incubator says whether stages are isolated", async () => {
  const info = await (await fetch(`${base}/api/incubator`)).json();
  expect(info.isolated).toBe(false);
});
```

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts src/server/incubator.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**
- **`incubator.ts`.** At the top of `pump`, read `const why = this.deps.isolation?.() ?? null`. While it is set, launch no stage. `ship` runs in canopy, so it still goes. Keep the reason as `waiting()`, and emit once when it changes so the view updates. If `pump` is private, make it public: the server calls it from `onUp`.
- **`src/server/index.ts`.**
  - Apply the rule above.
  - Pass `isolation` into the Incubator deps.
  - Pass `stageExec` into `runnerOpts`.
  - Change the flows' `check` hook to `runCheck(repo, command, seed, seed ? stageFor() : undefined)`, where `stageFor()` is the same three-way value as `stageExec`.
  - Start `stage.watch()` when a client exists.
  - Log one line at start, either `stages: isolated through <socket>` or `stages: not isolated (CANOPY_INCUBATOR_UNISOLATED=1)`, or `stages: off until the stage runner is set up`.
- **`src/server/incubator.ts`.** Add `isolated: stage !== null && stage.harnessesNow() !== null` and `waiting: incubator.waiting()` to the info answer.
- **`types.ts`.** Add `isolated: boolean` and `waiting: string | null`.
- **`Incubator.tsx`.** In the view's header, next to the title, render `isolated` as a dim "stages isolated" or a rust "stages not isolated", with a title attribute explaining which env is set. When `waiting` is set, show it as one rust line under the header ("queued: the stage runner is not answering").
- **Server test setup.** The existing `src/server/incubator.test.ts` suite starts stages unisolated today. Pass `stage: null` and set `process.env["CANOPY_INCUBATOR_UNISOLATED"] = "1"` in its `beforeAll`, deleting it in `afterAll`, so its existing flows still run. Then add a second small describe with the variable unset that asserts `waiting` through the API.

- [ ] **Step 4: Run them and watch them pass, then the gates**

Run: `SHELL=/bin/bash bun test src/core/incubator.test.ts src/server/incubator.test.ts && bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/core/incubator.ts src/core/incubator.test.ts src/server/incubator.ts src/server/incubator.test.ts src/core/types.ts ui/src/components/Incubator.tsx
git commit -m "feat(stages): the server routes stages through the runner, waits while it is away, and says whether stages are isolated" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 10: a stage reads its inputs and the workspace from `.shared`

**Files:**
- Create: `src/core/stageshare.ts`
- Create: `src/core/stageshare.test.ts`
- Modify: `src/core/incubator.ts` (`launch`: share before clarify and scout; the paths it hands `withInputsRead`, `withWorkspaceRead` and `stageNote`)
- Modify: `src/core/sprout.ts` (`withWorkspaceRead` takes the snapshot dir; `workspaceLine` names the snapshot's files)

**Interfaces:**
- Produces:
  - `SHARED_DIR = ".shared"`
  - `shareInputs(seeds: string, sproutId: string, from: string): Promise<string>`, which returns `<seeds>/.shared/inputs/<id>`
  - `shareWorkspace(seeds: string, root: string, cap?: { files: number; bytes: number }): Promise<string>`, which returns `<seeds>/.shared/workspace`
  - `withWorkspaceRead(wf, dir)` adds `Read(/${dir}/**)` and nothing else.

- [ ] **Step 1: Write the failing tests** (`src/core/stageshare.test.ts`)

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { shareInputs, shareWorkspace } from "./stageshare";

let root = "";
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "canopy-share-"));
  await mkdir(join(root, "_devhub"), { recursive: true });
  await mkdir(join(root, "web-apps", "tally"), { recursive: true });
  await mkdir(join(root, "dev-tools", "canopy"), { recursive: true });
  await writeFile(join(root, ".env"), "GH_TOKEN=secret\n");
  await writeFile(join(root, "web-apps", "tally", "README.md"), "# tally\n");
  await writeFile(join(root, "dev-tools", "canopy", "README.md"), "# canopy\n");
  await symlink(join(root, ".env"), join(root, "web-apps", "tally", "LINK.md"));
  await writeFile(
    join(root, "_devhub", "manifest.json"),
    JSON.stringify({
      categories: {
        "web-apps": { projects: [{ name: "tally", path: "web-apps/tally" }, { name: "x", path: "../../etc" }] },
        "dev-tools": { projects: [{ name: "canopy", path: "dev-tools/canopy" }] },
      },
    }),
  );
  await writeFile(join(root, "_devhub", "references.json"), "{}");
});
afterAll(() => rm(root, { recursive: true, force: true }));

describe("stage share", () => {
  test("the workspace snapshot holds the two indexes and each listed project's README, nothing else", async () => {
    const dir = await shareWorkspace(join(root, "_incubator"), root);
    expect(dir).toBe(join(root, "_incubator", ".shared", "workspace"));
    expect((await readdir(dir)).sort()).toEqual(["READMEs", "manifest.json", "references.json"]);
    expect((await readdir(join(dir, "READMEs"))).sort()).toEqual(["dev-tools__canopy.md", "web-apps__tally.md"]);
  });

  test("a README that is a symlink, a path out of the root or the .env never lands", async () => {
    const dir = await shareWorkspace(join(root, "_incubator"), root);
    const all = await readdir(join(dir, "READMEs"));
    for (const f of all) expect(await Bun.file(join(dir, "READMEs", f)).text()).not.toContain("GH_TOKEN");
  });

  test("the cap holds", async () => {
    const dir = await shareWorkspace(join(root, "_incubator"), root, { files: 1, bytes: 1_000_000 });
    expect(await readdir(join(dir, "READMEs"))).toHaveLength(1);
  });

  test("inputs are copied, replaced on the next share, and never follow a symlink", async () => {
    const from = join(root, "inputs-src");
    await mkdir(from, { recursive: true });
    await writeFile(join(from, "1.txt"), "an idea");
    await symlink(join(root, ".env"), join(from, "2.txt"));
    const to = await shareInputs(join(root, "_incubator"), "abc123", from);
    expect(await readdir(to)).toEqual(["1.txt"]);
    await writeFile(join(from, "3.txt"), "more");
    expect((await readdir(await shareInputs(join(root, "_incubator"), "abc123", from))).sort()).toEqual(["1.txt", "3.txt"]);
  });
});
```

The fixture follows devhub's real shape, checked against `~/dev/_devhub/manifest.json`: `categories.<key>.projects[]`, each with a root-relative `path`.

- [ ] **Step 2: Run them and watch them fail**

Run: `SHELL=/bin/bash bun test src/core/stageshare.test.ts`
Expected: FAIL with `Cannot find module './stageshare'`.

- [ ] **Step 3: Write `src/core/stageshare.ts`**

```ts
/**
 * What a stage may read beyond its own seed, copied by canopy under the seeds
 * dir's `.shared/`, which the stages container mounts read-only: a sprout's
 * inputs, and a snapshot of the workspace (devhub's two indexes and each
 * listed project's README). The stage never sees the launch root, its .env,
 * or canopy's config volume. Regular files only; a symlink is skipped.
 */
import { copyFile, lstat, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join, normalize, relative } from "node:path";

export const SHARED_DIR = ".shared";
const CAP = { files: 400, bytes: 4_000_000 };

async function regular(path: string): Promise<boolean> {
  const st = await lstat(path).catch(() => null);
  return st !== null && st.isFile();
}

async function swapIn(tmp: string, dest: string): Promise<void> {
  await rm(dest, { recursive: true, force: true });
  await rename(tmp, dest);
}

export async function shareInputs(seeds: string, sproutId: string, from: string): Promise<string> {
  const dest = join(seeds, SHARED_DIR, "inputs", sproutId);
  const tmp = `${dest}.${process.pid}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(tmp, { recursive: true });
  for (const name of await readdir(from).catch(() => [] as string[])) {
    if (await regular(join(from, name))) await copyFile(join(from, name), join(tmp, name));
  }
  await swapIn(tmp, dest);
  return dest;
}

export async function shareWorkspace(seeds: string, root: string, cap = CAP): Promise<string> {
  const dest = join(seeds, SHARED_DIR, "workspace");
  const tmp = `${dest}.${process.pid}.tmp`;
  await rm(tmp, { recursive: true, force: true });
  await mkdir(join(tmp, "READMEs"), { recursive: true });
  const hub = join(root, "_devhub");
  for (const f of ["manifest.json", "references.json"]) {
    if (await regular(join(hub, f))) await copyFile(join(hub, f), join(tmp, f));
  }
  const manifest: unknown = await readFile(join(hub, "manifest.json"), "utf8").then(JSON.parse).catch(() => null);
  const cats = typeof manifest === "object" && manifest !== null ? (manifest as { categories?: unknown }).categories : null;
  const projects: unknown[] =
    typeof cats === "object" && cats !== null
      ? Object.values(cats).flatMap((c) => (typeof c === "object" && c !== null && Array.isArray((c as { projects?: unknown }).projects) ? (c as { projects: unknown[] }).projects : []))
      : [];
  let files = 0;
  let bytes = 0;
  for (const p of projects) {
    const rel = typeof p === "object" && p !== null && typeof (p as { path?: unknown }).path === "string" ? (p as { path: string }).path : null;
    if (!rel) continue;
    const abs = normalize(join(root, rel, "README.md"));
    if (relative(root, abs).startsWith("..")) continue;
    if (!(await regular(abs))) continue;
    const text = await readFile(abs);
    if (files >= cap.files || bytes + text.length > cap.bytes) break;
    await writeFile(join(tmp, "READMEs", `${rel.replaceAll("/", "__")}.md`), text);
    files++;
    bytes += text.length;
  }
  await swapIn(tmp, dest);
  return dest;
}
```

- [ ] **Step 4: Point the stages at `.shared`**
- **Clarify.** In `Incubator.launch`, before clarify, set `const inputs = await shareInputs(seedsDir, s.id, this.deps.store.inputsDir(s.id));`. Use `inputs` in place of `this.deps.store.inputsDir(s.id)` for both `withInputsRead` and `stageNote`.
- **Scout.** Before scout, set `const ws = await shareWorkspace(seedsDir, this.deps.root);`, then `withWorkspaceRead(wf, ws)`, and give the note `workspaceLine(ws)`.
- **`withWorkspaceRead`.** It becomes `Read(/${dir}/**)` alone.
- **`workspaceLine`.** It names `${dir}/manifest.json`, `${dir}/references.json` and `${dir}/READMEs/`.
- **Tests.** Update the scout tool and note assertions in `src/core/incubator.test.ts` and `src/core/sprout.test.ts` to the new paths.
- **The scan.** `seedsDir` is `join(root, SEEDS_DIR)`. The scan already skips dot folders, so `.shared` never becomes a card. Assert that in `src/core/scan.test.ts` with a `_incubator/.shared/workspace/` holding a `.git`.

- [ ] **Step 5: Run the tests and the gates, then commit**

Run: `SHELL=/bin/bash bun test src/core/stageshare.test.ts src/core/incubator.test.ts src/core/sprout.test.ts src/core/scan.test.ts && bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`

```bash
git add src/core/stageshare.ts src/core/stageshare.test.ts src/core/incubator.ts src/core/incubator.test.ts src/core/sprout.ts src/core/sprout.test.ts src/core/scan.test.ts
git commit -m "feat(stages): a stage reads its inputs and a workspace snapshot from _incubator/.shared" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 11: the stages image and service

**Files:**
- Modify: `Dockerfile` (a `stages` stage; the build stage bundles the runner)
- Modify: `docker-compose.yml` (the `stages` service, its network and the `stage-sock` volume; canopy's socket mount and env)
- Create: `src/server/compose.test.ts`

**Interfaces:**
- Produces:
  - A compose service `stages`, with `CANOPY_STAGE_ROOT=${DEV_ROOT}/_incubator` and `CANOPY_STAGE_SOCKET=/run/canopy-stage/runner.sock`.
  - The `canopy` service gains the env `CANOPY_STAGE_SOCKET=/run/canopy-stage/runner.sock`, the mount `stage-sock:/run/canopy-stage` and `depends_on: stages`.

- [ ] **Step 1: Write the failing test** (`src/server/compose.test.ts`). It reads the file the mini runs.

```ts
import { describe, expect, test } from "bun:test";

const compose = Bun.YAML.parse(await Bun.file(new URL("../../docker-compose.yml", import.meta.url)).text()) as {
  services: Record<string, { environment?: string[] | Record<string, string>; volumes?: string[]; network_mode?: string; pid?: string; networks?: unknown; depends_on?: unknown }>;
  networks?: Record<string, { ipam?: { config?: { subnet?: string }[] } }>;
};
const envOf = (s: { environment?: string[] | Record<string, string> }): string[] =>
  Array.isArray(s.environment) ? s.environment : Object.entries(s.environment ?? {}).map(([k, v]) => `${k}=${v}`);

describe("the stages service", () => {
  const stages = compose.services["stages"];
  test("exists, shares no namespace with canopy or the shells", () => {
    expect(stages).toBeDefined();
    expect(stages?.network_mode).toBeUndefined();
    expect(stages?.pid).toBeUndefined();
  });
  test("inherits nothing: no env_file, no merge key, no extends", async () => {
    // read the raw text too: a YAML parser may resolve a merge key and hide where the env came from
    const raw = await Bun.file(new URL("../../docker-compose.yml", import.meta.url)).text();
    const start = raw.indexOf("\n  stages:\n");
    expect(start).toBeGreaterThan(-1);
    const rest = raw.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
    const block = next === -1 ? rest : rest.slice(0, next + 1);
    expect(block).not.toMatch(/<<:|env_file|extends:/);
    expect(stages).not.toHaveProperty("env_file");
    expect(stages).not.toHaveProperty("extends");
  });
  test("canopy starts only once the runner answers its healthcheck", () => {
    expect((stages as { healthcheck?: { test?: string[] } }).healthcheck?.test).toEqual(["CMD", "bun", "/app/stage-runner.js", "--health"]);
    expect((compose.services["canopy"]?.depends_on as Record<string, { condition?: string }>)?.["stages"]?.condition).toBe("service_healthy");
  });
  test("holds no token, key or secret, and mounts no ssh, git config, .env or docker socket", () => {
    for (const e of envOf(stages ?? {})) expect(e.split("=")[0]).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/);
    for (const v of stages?.volumes ?? []) expect(v).not.toMatch(/\.ssh|\.config\/git|\.env|docker\.sock|canopy-config|\/\.claude[:/]|\/\.codex[:/]/);
  });
  test("mounts the seeds read-write, .shared read-only over them, and the socket", () => {
    const vols = stages?.volumes ?? [];
    expect(vols.some((v) => /_incubator:\$\{DEV_ROOT[^}]*\}\/_incubator$/.test(v) || v.endsWith("/_incubator"))).toBe(true);
    expect(vols.some((v) => v.includes("_incubator/.shared") && v.endsWith(":ro"))).toBe(true);
    expect(vols).toContain("stage-sock:/run/canopy-stage");
  });
  test("sits on its own network outside ufw's docker range and the tailchan rule", () => {
    const subnet = compose.networks?.["stages-net"]?.ipam?.config?.[0]?.subnet;
    expect(subnet).toBe("10.250.13.0/24");
  });
  test("canopy reaches it only through the socket", () => {
    const canopy = compose.services["canopy"];
    expect(envOf(canopy ?? {})).toContain("CANOPY_STAGE_SOCKET=/run/canopy-stage/runner.sock");
    expect(canopy?.volumes ?? []).toContain("stage-sock:/run/canopy-stage");
    expect(compose.services["shells"]?.volumes ?? []).not.toContain("stage-sock:/run/canopy-stage");
  });
});
```

If `Bun.YAML` is missing in this Bun, use the `yaml` package already in the lockfile (`bun pm ls | grep yaml`). If neither is there, add `yaml` as a dev dependency with `bun add -d yaml`.

- [ ] **Step 2: Run it and watch it fail**

Run: `SHELL=/bin/bash bun test src/server/compose.test.ts`
Expected: FAIL, because `stages` is undefined.

- [ ] **Step 3: Write the image and the service**

In the `Dockerfile`'s `build` stage, after the UI build, add:

```dockerfile
RUN bun build src/stage/main.ts --target=bun --outfile /app/dist/stage-runner.js
```

Add a new stage after `shells`:

```dockerfile
# The incubator's stages: the shells' runtime, user, claude, codex, bun and
# git, without gh, and the stage runner. No canopy server code, no token.
FROM shells AS stages
USER root
RUN rm -f /usr/bin/gh
USER bun
COPY --from=build --chown=bun:bun /app/dist/stage-runner.js /app/stage-runner.js
ENV CLAUDE_CONFIG_DIR=/home/bun/.stage-claude CODEX_HOME=/home/bun/.stage-codex
ENTRYPOINT ["bun", "/app/stage-runner.js"]
```

Check how the `shells` stage installs gh, and remove the binary at the path it lands in. Keep `USER` as the shells stage's user.

In `docker-compose.yml`, add:

```yaml
  # The incubator's agents and their checks: no token, its own pid namespace
  # and network, the seeds and nothing else of the workspace. canopy starts
  # processes here only through the stage runner's socket.
  stages:
    build:
      context: .
      target: stages
      args:
        UID: ${HOST_UID:-1000}
        GID: ${HOST_GID:-1000}
    image: canopy-stages:latest
    environment:
      - CANOPY_STAGE_ROOT=${DEV_ROOT:-/home/eric/dev}/_incubator
      - CANOPY_STAGE_SOCKET=/run/canopy-stage/runner.sock
      - LANG=C.UTF-8
    volumes:
      - ${DEV_ROOT:-/home/eric/dev}/_incubator:${DEV_ROOT:-/home/eric/dev}/_incubator
      - ${DEV_ROOT:-/home/eric/dev}/_incubator/.shared:${DEV_ROOT:-/home/eric/dev}/_incubator/.shared:ro
      - ${HOST_HOME:-/home/eric}/.config/canopy-stages/claude:/home/bun/.stage-claude
      - ${HOST_HOME:-/home/eric}/.config/canopy-stages/codex:/home/bun/.stage-codex
      - stage-sock:/run/canopy-stage
    networks: [stages-net]
    init: true
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "bun", "/app/stage-runner.js", "--health"]
      interval: 10s
      timeout: 5s
      retries: 3
      start_period: 5s
```

Copy the `args` keys from the `shells` service exactly.

In `canopy`:
- Add `CANOPY_STAGE_SOCKET=/run/canopy-stage/runner.sock` to `environment`.
- Add `stage-sock:/run/canopy-stage` to `volumes`.
- Add `stages` to `depends_on` with `condition: service_healthy`.

Under `volumes:`, add `stage-sock:`. Add a top-level network:

```yaml
networks:
  stages-net:
    driver: bridge
    ipam:
      config:
        - subnet: 10.250.13.0/24
```

The existing `default` network stays implicit. If the file already has a `networks:` key, merge into it.

- [ ] **Step 4: Run it and watch it pass, then the gates**

Run: `SHELL=/bin/bash bun test src/server/compose.test.ts && bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

Do not run `docker compose up` here. The build is checked on the mini in Task 12.

- [ ] **Step 5: Commit**

```bash
git add Dockerfile docker-compose.yml src/server/compose.test.ts
git commit -m "feat(stages): the stages image and service, no token, own namespaces, the seeds and a socket" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 12: the network fence, its check, and the deploy docs

**Files:**
- Create: `scripts/stages-fence.sh`
- Create: `src/stage/fencecheck.ts`
- Create: `src/stage/fencecheck.test.ts`
- Modify: `Dockerfile` (bundle the check into the stages image)
- Modify: `docs/deploy.md`

**Interfaces:**
- Produces:
  - `fenceTargets(env): FenceTarget[]`, pure, with `FenceTarget = { name: string; url: string; expect: "blocked" | "open" }`.
  - `probe(target, fetchFn = fetch): Promise<"blocked" | "open">`. Any HTTP answer is open, and an error or a 4 s timeout is blocked.
  - Run as a file (`import.meta.main`), it probes every target, prints `ok  <name>` or `BAD <name>: expected <x>, got <y>`, and exits 1 on any BAD.
  - The image carries it as `/app/fence-check.js`. It lives under `src/stage/` because the stages image holds no canopy CLI.
  - `scripts/stages-fence.sh` prints its rules, and installs them with `--apply`.

- [ ] **Step 1: Write the failing test** (`src/stage/fencecheck.test.ts`)

```ts
import { expect, test } from "bun:test";
import { fenceTargets, probe } from "./fencecheck";

test("the fence probes canopy, the broker, the gateway and the LAN, and expects the internet open", () => {
  const t = fenceTargets({ CANOPY_FENCE_TAILNET_IP: "100.88.1.2", CANOPY_FENCE_LAN_IP: "192.168.1.10" });
  expect(t).toEqual([
    { name: "canopy on the tailnet", url: "http://100.88.1.2:7850/api/about", expect: "blocked" },
    { name: "tailchan broker", url: "http://100.88.1.2:7855/", expect: "blocked" },
    { name: "the bridge gateway", url: "http://10.250.13.1:7850/", expect: "blocked" },
    { name: "the LAN", url: "http://192.168.1.10/", expect: "blocked" },
    { name: "the internet", url: "https://api.anthropic.com/", expect: "open" },
  ]);
  expect(fenceTargets({}).filter((x) => x.expect === "blocked").map((x) => x.name)).toEqual(["the bridge gateway"]);
});

test("any answer is open, even a 403 or a redirect; a refusal or a timeout is blocked", async () => {
  const t = { name: "x", url: "http://h/", expect: "blocked" as const };
  expect(await probe(t, async () => new Response("", { status: 403 }))).toBe("open");
  expect(await probe(t, async () => new Response("", { status: 302, headers: { location: "/x" } }))).toBe("open");
  expect(await probe(t, async () => { throw new TypeError("connection refused"); })).toBe("blocked");
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `SHELL=/bin/bash bun test src/stage/fencecheck.test.ts`
Expected: FAIL with `Cannot find module './fencecheck'`.

- [ ] **Step 3: Write `src/stage/fencecheck.ts`**

```ts
/**
 * Run inside the stages container: what the fence must refuse (canopy, the
 * broker, the bridge gateway, the LAN) and what it must let through (the
 * internet the agents talk to). Bundled into the stages image as
 * /app/fence-check.js, since that image holds no canopy CLI.
 */
export interface FenceTarget {
  name: string;
  url: string;
  expect: "blocked" | "open";
}
export const STAGES_GATEWAY = "10.250.13.1";

export function fenceTargets(env: Record<string, string | undefined>): FenceTarget[] {
  const tail = env["CANOPY_FENCE_TAILNET_IP"];
  const lan = env["CANOPY_FENCE_LAN_IP"];
  const out: FenceTarget[] = [];
  if (tail) {
    out.push({ name: "canopy on the tailnet", url: `http://${tail}:7850/api/about`, expect: "blocked" });
    out.push({ name: "tailchan broker", url: `http://${tail}:7855/`, expect: "blocked" });
  }
  out.push({ name: "the bridge gateway", url: `http://${STAGES_GATEWAY}:7850/`, expect: "blocked" });
  if (lan) out.push({ name: "the LAN", url: `http://${lan}/`, expect: "blocked" });
  out.push({ name: "the internet", url: "https://api.anthropic.com/", expect: "open" });
  return out;
}

export async function probe(t: FenceTarget, fetchFn: typeof fetch = fetch): Promise<"blocked" | "open"> {
  try {
    await fetchFn(t.url, { redirect: "manual", signal: AbortSignal.timeout(4000) });
    return "open";
  } catch {
    return "blocked";
  }
}

if (import.meta.main) {
  let bad = 0;
  for (const t of fenceTargets(process.env)) {
    const got = await probe(t);
    if (got === t.expect) console.log(`ok  ${t.name}`);
    else (bad++, console.log(`BAD ${t.name}: expected ${t.expect}, got ${got}`));
  }
  process.exit(bad ? 1 : 0);
}
```

In the `Dockerfile`'s build stage, next to the runner's bundle line from Task 11, add `RUN bun build src/stage/fencecheck.ts --target=bun --outfile /app/dist/fence-check.js`. In the `stages` stage, add `COPY --from=build --chown=bun:bun /app/dist/fence-check.js /app/fence-check.js`.

- [ ] **Step 4: Write `scripts/stages-fence.sh`**

```sh
#!/bin/sh
# Fences the stages network (10.250.13.0/24): no private, tailnet or
# link-local address, the internet open. DOCKER-USER covers forwarded
# traffic. Traffic to the host itself is INPUT, which ufw's default deny
# incoming already refuses for this subnet, since ufw lets only
# 172.16.0.0/12 docker nets in. Docker's embedded DNS answers at 127.0.0.11
# inside the container's own namespace, so it is never forwarded and the
# 10.0.0.0/8 drop cannot reach it.
# Prints the rules; --apply installs them (needs root).
set -eu
NET=10.250.13.0/24
# -I puts each rule on top, so the last one listed ends up first: replies to
# connections the container opened go through before any drop
RULES="
-I DOCKER-USER -s $NET -d 10.0.0.0/8 -j DROP
-I DOCKER-USER -s $NET -d 172.16.0.0/12 -j DROP
-I DOCKER-USER -s $NET -d 192.168.0.0/16 -j DROP
-I DOCKER-USER -s $NET -d 100.64.0.0/10 -j DROP
-I DOCKER-USER -s $NET -d 169.254.0.0/16 -j DROP
-I DOCKER-USER -s $NET -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN
"
echo "$RULES"
if [ "${1:-}" = "--apply" ]; then
  echo "$RULES" | while read -r r; do [ -n "$r" ] && iptables $r; done
  ufw status | grep -q "Status: active" || echo "warning: ufw is not active; container-to-host traffic is not refused"
  echo "applied; persist them as docs/deploy.md says"
fi
```

Before the docs step, check on the mini that `10.250.13.0/24` is free: `ssh mini 'ip -4 route; docker network ls -q | xargs docker network inspect -f "{{range .IPAM.Config}}{{.Subnet}} {{end}}"'`. If it is taken, pick another `10.x.y.0/24`, and change it in the compose file, the compose test, `STAGES_GATEWAY` and this script together.

- [ ] **Step 5: Write the docs** (`docs/deploy.md`). Add a "Stages" section covering each of these:
- **Folders.** Create the host folders before the first `up`, or docker makes them as root: `mkdir -p ~/dev/_incubator/.shared ~/.config/canopy-stages/claude ~/.config/canopy-stages/codex`.
- **Build and start.** `docker compose build stages canopy && docker compose up -d`, then `docker compose exec stages claude --version` and `docker compose exec stages codex --version`.
- **Logins**, run once by Eric in a real terminal:
  - `docker compose exec -it stages claude`, then `/login`
  - `docker compose exec -it stages codex login --device-auth`
- **The fence.** Run `sh scripts/stages-fence.sh`, read the rules, then `sudo sh scripts/stages-fence.sh --apply`. Persist them by pasting the same rules, as `-A DOCKER-USER ...` lines in reverse order, into `/etc/ufw/after.rules` under a `*filter` block, then `sudo ufw reload`.
- **The fence check.** `docker compose exec -e CANOPY_FENCE_TAILNET_IP=$(tailscale ip -4) -e CANOPY_FENCE_LAN_IP=<the mini's LAN IP> stages bun /app/fence-check.js` prints `ok` on every line.
- **The incubator word.** The incubator view should now say "stages isolated".
- **A Mac backend** has no stages container. It runs the incubator only with `CANOPY_INCUBATOR_UNISOLATED=1`, which gives up all of part 3. Parts 1 and 2 still hold.

- [ ] **Step 6: The gates, then commit**

```bash
git add scripts/stages-fence.sh src/stage/fencecheck.ts src/stage/fencecheck.test.ts docs/deploy.md Dockerfile
git commit -m "feat(stages): the stages network fence, its check, and the deploy steps" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

### Task 13: the spec, CLAUDE.md and the gates

**Files:**
- Modify: `docs/superpowers/specs/2026-10-01-incubator-design.md` (amendment 3)
- Modify: `docs/superpowers/specs/2026-10-02-incubator-token-free-stages-design.md` (status: built)
- Modify: `CLAUDE.md` (the incubator bullet)

- [ ] **Step 1: Amendment 3.** Append `### Amendment 3: token-free stages, <date>` with these points:
  - **What it replaces.** It replaces amendment 2's "an agent that runs code shares canopy's uid and pid namespace" residual. Strike nothing, and add "(see amendment 3)" after that sentence.
  - **The new rules.** Summarize the spec's parts 1-3 in one paragraph each: the seed git guard, the user-only settings and codex untrust, and the stages container with its runner, built-ins, `.shared`, fail-closed policy and fence.
  - **The residuals.** Copy them from the stages spec word for word.
- [ ] **Step 2: CLAUDE.md.** In the incubator bullet, after the phase 3 sentence, add one sentence of the same density. It names:
  - `core/seedgit.ts` (`guardSeed` in `git()`, `seed.ts`, ship and the peer gate)
  - `--setting-sources user` and `codextrust.ts`
  - `builtincheck.ts` (`@pick-check`, `@questions`)
  - `stagewire.ts`, `src/stage/runner.ts` and `stageclient.ts` (one connection per process; the env is the runner's base plus three `CANOPY_*` names; the tree is killed on close)
  - `DriveCtx.spawn` and `RunnerOptions.stageExec`
  - `stageshare.ts` (`.shared/inputs`, `.shared/workspace`)
  - `CANOPY_STAGE_SOCKET`, `CANOPY_INCUBATOR_UNISOLATED` and `isolation()` parking
  - the `stages` service, and `stages-fence.sh` with `src/stage/fencecheck.ts`

  Update the "Architecture" list's file mentions where a file now does something new.
- [ ] **Step 3: The gates**

Run: `bun run typecheck && bun run lint && SHELL=/bin/bash bun test && bun run build`
Expected: all four pass.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/specs/2026-10-01-incubator-design.md docs/superpowers/specs/2026-10-02-incubator-token-free-stages-design.md CLAUDE.md
git commit -m "docs(incubator): amendment 3, token-free stages" -m "Claude-Session: https://claude.ai/code/session_01EVcyx1s8vU7bvwN19sFtqK"
```

---

## After the plan: what Eric runs on the mini

1. Merge phase 3 and this branch to `main`, in his order, once both are reviewed. Merging is his call.
2. Make the host folders, build and start the services, and check `vercel --version` and `claude --version` in `stages`.
3. Log `claude` and `codex` in, once, inside `stages`.
4. Apply the fence, then run the fence check.
5. Set `VERCEL_TOKEN` and `VERCEL_SCOPE` in the mini's `.env`, turn off deployment protection for production, and run the live shipper test once from the Mac (`CANOPY_INCUBATOR_IT=1`) with a minimal Vite build instead of the bare `index.html`.
6. Resume the parked laundromat sprout.
