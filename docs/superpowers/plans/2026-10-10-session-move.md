# Session move implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a "move to <backend>" button on a live agent shell that carries the Claude or Codex conversation and the repo's uncommitted work to the same repo on another canopy backend, resumes it there, and cleans the source.

**Architecture:** the page runs five calls, each to one backend: check (target), stop (source), transcript (source), load (target), clean (source). The servers never call each other. The transcript rides through the browser; the uncommitted work rides peer sync (`snapshotWip` on the source, `fetchPeer` and `takeWip` on the target). New core logic lives in `src/core/move.ts`; the routes go in `src/server/index.ts`; the UI has a step runner in `ui/src/move.ts` and a sheet in `ui/src/components/MoveSheet.tsx`.

**Tech Stack:** Bun + TypeScript (strict), `bun:test`, React 19 + Zustand, tmux, git.

**Spec:** `docs/superpowers/specs/2026-10-10-session-move-design.md`

## Global Constraints

- Gates before calling anything done: `bun run typecheck && bun run lint && bun test && bun run build`.
- `src/core/types.ts` stays browser-safe: no Bun or node imports there.
- Transcript cap: 64 MB (`MOVE_MAX = 64 * 1024 * 1024`).
- Agent stop wait: 20 s. Claude quits with `/exit`, Codex with `/quit`, text and Enter sent as two separate key sends.
- The source keeps the snapshot as `refs/canopy-moved/<session>` before it resets.
- `/api/repos/<action>` takes one lowercase word, so the target routes are `/api/repos/movecheck` and `/api/repos/movein`. Source routes: `/api/terms/move/plan`, `/move/out`, `/move/transcript`, `/move/finish`, `/move/undo`.
- No CSS framework: styles go in `ui/src/styles.css` with the existing tokens.
- Commit messages: no backticks. Each ends with the line `Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7`. Commit only; never push.

## Review Focus

1. **Detached HEAD on the source.** The plan route must refuse (409, "a move needs a branch") before anything stops. Test in Task 4.
2. **A clean source tree.** `out` returns `wip: null`; `movein` skips the take; `finish` only ends the shell. Test in Task 5.
3. **The target checked out on another branch.** `movecheck` answers `ok: false` naming both branches, never switches branches. Test in Task 5.
4. **A sibling folder with a shared prefix** (`/dev/app` vs `/dev/app2`). The `cwd` rewrite must not touch `/dev/app2`. Test in Task 1.
5. **The pane runs the other harness** (a stale registry card says claude, the pane runs codex). `endAgent` refuses with 409 and sends no keys. Test in Task 2.

Also pinned, from the plan review: a repo filed under different folders on the two machines (the card joins them by remote, but peer sync matches by folder) or a peer offline at check time. `movecheck` must refuse unless `refs/remotes/<from>/<branch>` equals the source's HEAD after its sync, so the move never stops an agent it cannot load. Test in Task 5. And a stop that quits the agent and then fails its snapshot still offers "resume here" (Tasks 4 and 6).

Write protection needs nothing new: every `/api/` request, multipart included, passes `libraryOriginAllowed` (cross-site refused) before any route, and the CORS wrapper adds headers to every response, the raw transcript file included.

---

### Task 0: Probe the assumptions on the real machines (no code kept)

Every later task depends on these. If one fails, stop and bring the result to Eric before writing code, since the design changes.

- [ ] **Step 1: A hand-moved Claude session resumes on the mini.** On the Mac, pick a short real session in a scratch repo checked out on both machines (say `~/dev/<scratch>`). Tell it a codeword first. Then:

```bash
S=<session id>; SRC=/Users/ericbaruch/dev/<scratch>; DST=/home/eric/dev/<scratch>
F=$(echo "$SRC" | sed 's/[^A-Za-z0-9]/-/g'); T=$(echo "$DST" | sed 's/[^A-Za-z0-9]/-/g')
sed "s#\"cwd\":\"$SRC#\"cwd\":\"$DST#g" ~/.claude/projects/$F/$S.jsonl > /tmp/$S.jsonl
scp /tmp/$S.jsonl macmini-ts:/home/eric/.claude/projects/$T/$S.jsonl
```

In a canopy shell on the mini (the `shells` container) at `$DST`, run `claude --resume $S` and ask for the codeword. Record: it resumes, it recalls the codeword, and `ls -ln` shows the file is readable by the container's user.

- [ ] **Step 2: The session's sibling folder.** Look at `~/.claude/projects/$F/$S/` on the Mac (`tool-results/`, subagent transcripts). Step 1 ran without it. If the resumed session worked, note it in the spec's "Out of scope". If it broke, add moving that folder to Task 1 and the spec before going on.

- [ ] **Step 3: The quit keys.** In a canopy tmux shell running Claude, send `Escape`, then `send-keys -l /exit`, then `Enter` as separate sends (tmux socket per the memory note "Driving sessions in canopy tmux"). Confirm the pane returns to the shell and slash autocomplete did not pick another command. Repeat with Codex and `/quit`. If either needs a different key sequence, change `QUIT` and `endAgent` in Task 2 to match.

- [ ] **Step 4: Backend names are peer names.** On each machine, compare `GET /api/backends` (`self` and each backend's `name`) with `canopy peers` (or the peer config). The page sends `backendOf(tab.id)` as `from`, and the target looks it up among its peers. If any name differs, stop: the page needs a mapping, which is a design change.

- [ ] **Step 5: Write the findings** into the spec under a new "What the probes showed" section and commit it.

```bash
git add docs/superpowers/specs/2026-10-10-session-move-design.md
git commit -m "docs(move): what the probes showed

Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7"
```

---

### Task 1: Transcript rewrite and placement

**Files:**
- Create: `src/core/move.ts`, `src/core/move.test.ts`
- Modify: `src/core/sessions.ts` (add `transcriptFile` after `newestTranscript`)

**Interfaces:**
- Produces:
  - `MOVE_MAX: number`
  - `class MoveError extends Error { status: number }`
  - `movePath(cwd: string, from: string, to: string): string`
  - `rewriteTranscript(text: string, from: string, to: string): string` (throws `MoveError(400)` on a line that is not JSON)
  - `placeTranscript(o: { harness: Harness; session: string; text: string; name: string; to: string; homes?: { claude?: string; codex?: string } }): Promise<{ file: string; replaced: boolean }>` (throws `MoveError(409)` on a split copy, `MoveError(400)` on a bad codex name)
  - in `sessions.ts`: `transcriptFile(harness: Harness, path: string, session: string, homes?: { claude?: string; codex?: string }, now?: Date): Promise<{ file: string; name: string } | null>`; `name` is the file's path under `$CODEX_HOME/sessions` for codex (`YYYY/MM/DD/rollout-….jsonl`) and `<session>.jsonl` for claude.

- [ ] **Step 1: Write the failing tests** in `src/core/move.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MOVE_MAX, MoveError, movePath, placeTranscript, rewriteTranscript } from "./move";
import { projectFolder, transcriptFile } from "./sessions";

const S = "0f5e2c1a-1111-4222-8333-444455556666";
const FROM = "/Users/e/dev/app";
const TO = "/home/e/dev/app";
let scratch = "";
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-move-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("movePath", () => {
  test("the repo and anything under it move; a sibling with the same prefix does not", () => {
    expect(movePath(FROM, FROM, TO)).toBe(TO);
    expect(movePath(`${FROM}/ui/src`, FROM, TO)).toBe(`${TO}/ui/src`);
    expect(movePath(`${FROM}2`, FROM, TO)).toBe(`${FROM}2`);
    expect(movePath("/tmp", FROM, TO)).toBe("/tmp");
  });
});

describe("rewriteTranscript", () => {
  test("claude: top-level cwd moves, message text keeps its paths", () => {
    const line = JSON.stringify({ type: "user", cwd: `${FROM}/ui`, message: { content: `look at ${FROM}/x.ts` } });
    const out = rewriteTranscript(`${line}\n`, FROM, TO);
    const rec = JSON.parse(out.trim());
    expect(rec.cwd).toBe(`${TO}/ui`);
    expect(rec.message.content).toBe(`look at ${FROM}/x.ts`);
    expect(out.endsWith("\n")).toBe(true);
  });
  test("codex: payload.cwd moves in session_meta and turn_context", () => {
    const meta = JSON.stringify({ type: "session_meta", payload: { id: S, cwd: FROM } });
    const turn = JSON.stringify({ type: "turn_context", payload: { cwd: `${FROM}/a` } });
    const [m, t] = rewriteTranscript(`${meta}\n${turn}\n`, FROM, TO).trim().split("\n").map((l) => JSON.parse(l));
    expect(m.payload.cwd).toBe(TO);
    expect(t.payload.cwd).toBe(`${TO}/a`);
  });
  test("a line that is not JSON is refused, a cut-off last line included", () => {
    const good = JSON.stringify({ cwd: FROM });
    expect(() => rewriteTranscript(`${good}\n{"cwd":"/Us`, FROM, TO)).toThrow(MoveError);
  });
  test("a cwd written in a shape the rewrite cannot find is refused, not left behind", () => {
    const spaced = `{"type":"user","cwd": "${FROM}"}`;
    expect(() => rewriteTranscript(`${spaced}\n`, FROM, TO)).toThrow(MoveError);
  });
  test("a line with nothing to move comes back byte for byte", () => {
    const line = '{"type":"summary","summary":"caf\\u00e9"}';
    expect(rewriteTranscript(`${line}\n`, FROM, TO)).toBe(`${line}\n`);
  });
});

describe("placeTranscript", () => {
  const homes = () => ({ claude: join(scratch, "claude"), codex: join(scratch, "codex") });
  test("claude: lands under the target's project folder", async () => {
    const got = await placeTranscript({ harness: "claude", session: S, text: "{}\n", name: `${S}.jsonl`, to: TO, homes: homes() });
    expect(got.file).toBe(join(scratch, "claude", "projects", projectFolder(TO), `${S}.jsonl`));
    expect(got.replaced).toBe(false);
    expect(await readFile(got.file, "utf8")).toBe("{}\n");
  });
  test("an earlier copy that is a line prefix is replaced; a split copy is refused", async () => {
    const got = await placeTranscript({ harness: "claude", session: S, text: "{}\n{}\n", name: `${S}.jsonl`, to: TO, homes: homes() });
    expect(got.replaced).toBe(true);
    const split = placeTranscript({ harness: "claude", session: S, text: '{"a":1}\n', name: `${S}.jsonl`, to: TO, homes: homes() });
    await expect(split).rejects.toMatchObject({ status: 409 });
  });
  test("codex: keeps its day folders and file name", async () => {
    const name = `2026/10/10/rollout-2026-10-10T09-00-00-${S}.jsonl`;
    const got = await placeTranscript({ harness: "codex", session: S, text: "{}\n", name, to: TO, homes: homes() });
    expect(got.file).toBe(join(scratch, "codex", "sessions", name));
  });
  test("codex: a name that climbs out or names another session is refused", async () => {
    for (const name of ["../../x.jsonl", `2026/10/10/rollout-x-${"1".repeat(8)}.jsonl`]) {
      await expect(placeTranscript({ harness: "codex", session: S, text: "{}\n", name, to: TO, homes: homes() })).rejects.toMatchObject({ status: 400 });
    }
  });
  test("over the cap is refused", async () => {
    const big = "x".repeat(MOVE_MAX + 1);
    await expect(placeTranscript({ harness: "claude", session: S, text: big, name: `${S}.jsonl`, to: TO, homes: homes() })).rejects.toMatchObject({ status: 413 });
  });
});

describe("transcriptFile", () => {
  test("claude: the session's file under the folder's project dir, null when missing", async () => {
    const home = join(scratch, "tf-claude");
    const dir = join(home, "projects", projectFolder(FROM));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${S}.jsonl`), "{}\n");
    expect(await transcriptFile("claude", FROM, S, { claude: home })).toEqual({ file: join(dir, `${S}.jsonl`), name: `${S}.jsonl` });
    expect(await transcriptFile("claude", FROM, S.replace("0f", "1f"), { claude: home })).toBeNull();
  });
});
```

- [ ] **Step 2: Run them and see them fail**

Run: `bun test src/core/move.test.ts`
Expected: FAIL, `Cannot find module './move'`.

- [ ] **Step 3: Write `src/core/move.ts`**

```ts
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, join, normalize } from "node:path";
import { claudeHome, codexHome, isSessionId, projectFolder } from "./sessions";
import type { Harness } from "./types";

/*
 * Moving an agent session to another machine: the transcript's working
 * folders rewritten from the source repo's path to the target's, and the
 * file put where the target's harness looks for it. Claude files a
 * conversation under the folder of its `cwd`; Codex by day, with `cwd` in
 * its `session_meta` line. Only `cwd` fields move: message text and tool
 * input keep the paths they had, since that is what was said.
 */

/** the largest transcript a move carries */
export const MOVE_MAX = 64 * 1024 * 1024;

/** a refusal with the HTTP status the route answers with */
export class MoveError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "MoveError";
  }
}

/** `cwd` from the source repo to the target's: the repo itself and
 *  anything under it; any other folder as it was */
export function movePath(cwd: string, from: string, to: string): string {
  if (cwd === from) return to;
  if (cwd.startsWith(`${from}/`)) return to + cwd.slice(from.length);
  return cwd;
}

/** the `cwd` values a record carries: Claude's top-level one, Codex's in its payload */
function cwdsOf(rec: unknown): string[] {
  if (!rec || typeof rec !== "object") return [];
  const out: string[] = [];
  const top = (rec as { cwd?: unknown }).cwd;
  if (typeof top === "string") out.push(top);
  const payload = (rec as { payload?: unknown }).payload;
  const inner = payload && typeof payload === "object" ? (payload as { cwd?: unknown }).cwd : undefined;
  if (typeof inner === "string") out.push(inner);
  return out;
}

/** Every line checked as JSON and its `cwd` fields moved, the rest of the
 *  line left byte for byte as it was. */
export function rewriteTranscript(text: string, from: string, to: string): string {
  const lines = text.split("\n");
  const trailing = lines.at(-1) === "";
  if (trailing) lines.pop();
  const out = lines.map((line, i) => {
    let rec: unknown;
    try {
      rec = JSON.parse(line);
    } catch {
      throw new MoveError(400, `line ${i + 1} of the transcript is not JSON (cut off?)`);
    }
    let next = line;
    let changed = false;
    for (const cwd of new Set(cwdsOf(rec))) {
      const moved = movePath(cwd, from, to);
      if (moved === cwd) continue;
      next = next.split(`"cwd":${JSON.stringify(cwd)}`).join(`"cwd":${JSON.stringify(moved)}`);
      changed = true;
    }
    // the rewrite matched the compact form both harnesses write; a line in
    // any other shape would keep the old folder, so it fails loudly here
    if (changed && cwdsOf(JSON.parse(next)).some((c) => movePath(c, from, to) !== c)) {
      throw new MoveError(400, `line ${i + 1} of the transcript keeps a cwd the move could not rewrite`);
    }
    return next;
  });
  return out.join("\n") + (trailing ? "\n" : "");
}

/** a codex rollout's path under `sessions/`, its day folders and a file
 *  name ending in the session id */
const codexName = (name: string, session: string): boolean =>
  /^\d{4}\/\d{2}\/\d{2}\/rollout-[^/]+\.jsonl$/.test(name) && name.endsWith(`-${session}.jsonl`) && normalize(name) === name;

/** Writes the transcript where the target's harness finds it. An earlier
 *  copy is replaced only when it is a line-for-line prefix of this one (the
 *  same conversation, moved here before); otherwise the two have split. */
export async function placeTranscript(o: {
  harness: Harness;
  session: string;
  text: string;
  name: string;
  to: string;
  homes?: { claude?: string; codex?: string };
}): Promise<{ file: string; replaced: boolean }> {
  if (!isSessionId(o.session)) throw new MoveError(400, "session must be a session id");
  if (o.text.length > MOVE_MAX) throw new MoveError(413, "the transcript is over 64 MB");
  let file: string;
  if (o.harness === "codex") {
    if (!codexName(o.name, o.session)) throw new MoveError(400, "not a codex rollout name for that session");
    file = join(o.homes?.codex ?? codexHome(), "sessions", o.name);
  } else {
    file = join(o.homes?.claude ?? claudeHome(), "projects", projectFolder(o.to), `${o.session}.jsonl`);
  }
  const had = await readFile(file, "utf8").catch(() => null);
  if (had !== null && had !== o.text && !(o.text.startsWith(had) && (had === "" || had.endsWith("\n")))) {
    throw new MoveError(409, "this machine already has a different copy of that conversation");
  }
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.moving-${process.pid}`;
  await writeFile(tmp, o.text);
  await rename(tmp, file);
  return { file, replaced: had !== null };
}

/** the size of a file, null when it is not there */
export const sizeOf = async (file: string): Promise<number | null> => (await stat(file).catch(() => null))?.size ?? null;
```

- [ ] **Step 4: Add `transcriptFile` to `src/core/sessions.ts`**, after `newestTranscript`:

```ts
/** The file `session` of `harness` is kept in for `path` on this machine,
 *  with the name a move carries it under: `<id>.jsonl` for Claude, the
 *  path under `sessions/` for Codex. Null when there is none. */
export async function transcriptFile(
  harness: Harness,
  path: string,
  session: string,
  homes: { claude?: string; codex?: string } = {},
  now = new Date(),
): Promise<{ file: string; name: string } | null> {
  if (!isSessionId(session)) return null;
  if (harness === "codex") {
    const home = homes.codex ?? codexHome();
    const hit = (await codexRollouts(path, home, now)).find((x) => x.s.meta.id === session);
    return hit ? { file: hit.file, name: relative(join(home, "sessions"), hit.file) } : null;
  }
  const file = join(homes.claude ?? claudeHome(), "projects", projectFolder(path), `${session}.jsonl`);
  const s = await stat(file).catch(() => null);
  return s?.isFile() ? { file, name: `${session}.jsonl` } : null;
}
```

Add `relative` to the `node:path` import in `sessions.ts`.

- [ ] **Step 5: Run the tests**

Run: `bun test src/core/move.test.ts src/core/sessions.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/core/move.ts src/core/move.test.ts src/core/sessions.ts
git commit -m "feat(move): rewrite and place a moved transcript

Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7"
```

---

### Task 2: Ending the agent in a shell

**Files:**
- Modify: `src/core/move.ts`, `src/core/move.test.ts`, `src/core/tmux.ts` (add `keysArgs` and `sendKeys` beside `sendLineArgs`/`sendLine`)

**Interfaces:**
- Consumes: `MoveError` (Task 1).
- Produces:
  - in `move.ts`: `interface PaneDriver { keys(keys: string[], literal?: boolean): Promise<void>; agent(): Promise<Harness | null> }`, `QUIT: Record<Harness, string>`, `endAgent(pane: PaneDriver, harness: Harness, o?: { waitMs?: number; beatMs?: number }): Promise<boolean>` (true once the pane is back at a shell, false on timeout, throws `MoveError(409)` when another harness runs).
  - in `tmux.ts`: `keysArgs(base: string[], id: string, keys: string[], literal?: boolean): string[]`, `sendKeys(base: string[], id: string, keys: string[], literal?: boolean): Promise<void>`.

- [ ] **Step 1: Write the failing tests**, appended to `src/core/move.test.ts` (add `endAgent`, `QUIT`, `type PaneDriver` to the `./move` import):

```ts
/** a pane whose agent exits once it has been sent its quit command and Enter */
function fakePane(runs: "claude" | "codex" | null, exits = true): PaneDriver & { sent: string[][] } {
  let agent = runs;
  let typed = "";
  const sent: string[][] = [];
  return {
    sent,
    async keys(keys, literal) {
      sent.push(literal ? ["-l", ...keys] : keys);
      if (literal) typed = keys.join("");
      if (!literal && keys[0] === "Enter" && exits && agent && typed === QUIT[agent]) agent = null;
    },
    async agent() {
      return agent;
    },
  };
}

describe("endAgent", () => {
  const quick = { waitMs: 200, beatMs: 1 };
  test("claude: Escape, then /exit and Enter as two sends, then back at the shell", async () => {
    const pane = fakePane("claude");
    expect(await endAgent(pane, "claude", quick)).toBe(true);
    expect(pane.sent).toEqual([["Escape"], ["-l", "/exit"], ["Enter"]]);
  });
  test("codex quits with /quit", async () => {
    const pane = fakePane("codex");
    expect(await endAgent(pane, "codex", quick)).toBe(true);
    expect(pane.sent[1]).toEqual(["-l", "/quit"]);
  });
  test("nothing running: done, no keys", async () => {
    const pane = fakePane(null);
    expect(await endAgent(pane, "claude", quick)).toBe(true);
    expect(pane.sent).toEqual([]);
  });
  test("an agent that never exits times out", async () => {
    expect(await endAgent(fakePane("claude", false), "claude", quick)).toBe(false);
  });
  test("the other harness in the pane is refused before any key", async () => {
    const pane = fakePane("codex");
    await expect(endAgent(pane, "claude", quick)).rejects.toMatchObject({ status: 409 });
    expect(pane.sent).toEqual([]);
  });
});
```

And in `src/core/tmux.test.ts`:

```ts
test("keysArgs: named keys as they are, literal text after -l", () => {
  const base = ["tmux", "-S", "/s"];
  expect(keysArgs(base, "ab", ["Escape"])).toEqual([...base, "send-keys", "-t", sessionName("ab"), "Escape"]);
  expect(keysArgs(base, "ab", ["/exit"], true)).toEqual([...base, "send-keys", "-t", sessionName("ab"), "-l", "/exit"]);
});
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test src/core/move.test.ts src/core/tmux.test.ts`
Expected: FAIL, `endAgent` and `keysArgs` are not exported.

- [ ] **Step 3: Implement.** In `src/core/tmux.ts`, beside `sendLineArgs`:

```ts
/** keys to the pane: tmux key names (Escape, Enter), or with `literal` text typed as is */
export const keysArgs = (base: string[], id: string, keys: string[], literal = false): string[] => [
  ...base,
  "send-keys",
  "-t",
  sessionName(id),
  ...(literal ? ["-l"] : []),
  ...keys,
];
```

and beside `sendLine`:

```ts
export async function sendKeys(base: string[], id: string, keys: string[], literal = false): Promise<void> {
  await exec(keysArgs(base, id, keys, literal), { timeoutMs: 10_000 });
}
```

In `src/core/move.ts`:

```ts
/** what a stop needs of a pane: keys in, and which agent runs there now */
export interface PaneDriver {
  keys(keys: string[], literal?: boolean): Promise<void>;
  agent(): Promise<Harness | null>;
}

/** the command each harness quits on */
export const QUIT: Record<Harness, string> = { claude: "/exit", codex: "/quit" };

/** Quits the agent in a pane the way a person would: Escape (stops a turn
 *  in progress, nothing at an idle prompt), the quit command, then Enter on
 *  its own, since Codex swallows an Enter sent with the text. True once the
 *  pane is back at its shell; false if it is not within `waitMs`. */
export async function endAgent(pane: PaneDriver, harness: Harness, o: { waitMs?: number; beatMs?: number } = {}): Promise<boolean> {
  const waitMs = o.waitMs ?? 20_000;
  const beat = o.beatMs ?? 300;
  const now = await pane.agent();
  if (now === null) return true;
  if (now !== harness) throw new MoveError(409, `${now} runs in that shell, not ${harness}`);
  await pane.keys(["Escape"]);
  await Bun.sleep(beat);
  await pane.keys([QUIT[harness]], true);
  await Bun.sleep(beat);
  await pane.keys(["Enter"]);
  const until = Date.now() + waitMs;
  while (Date.now() < until) {
    if ((await pane.agent()) === null) return true;
    await Bun.sleep(beat);
  }
  return false;
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/move.test.ts src/core/tmux.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/core/move.ts src/core/move.test.ts src/core/tmux.ts src/core/tmux.test.ts
git commit -m "feat(move): quit the agent in a shell, Escape then its quit command

Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7"
```

---

### Task 3: Resetting the source tree after a move

**Files:**
- Modify: `src/core/peersync.ts` (add `treeIs` and `resetTree` after `takeWip`), `src/core/peersync.test.ts`

**Interfaces:**
- Produces:
  - `treeIs(repo: string, commit: string): Promise<boolean>`: whether the working copy (tracked and untracked, not ignored) is exactly `commit`'s tree. Uses the existing private `worktreeTree(repo, true)`.
  - `resetTree(repo: string, wip: string, session: string): Promise<"reset" | "clean">`: keeps `refs/canopy-moved/<session>` at `wip`, then `reset --hard` and `clean -fd`. Throws an `Error` naming the reason when HEAD is not `wip^`, a merge or rebase is in progress, or the tree is no longer `wip`'s. A tree already clean at `wip^` answers `"clean"` after writing the ref.

- [ ] **Step 1: Write the failing tests** in `src/core/peersync.test.ts` (add `resetTree, treeIs` to the import; reuse the file's `repo`, `sh`, `hasRef` helpers):

```ts
describe("resetTree", () => {
  const S = "0f5e2c1a-1111-4222-8333-444455556666";
  const dirtied = async (name: string) => {
    const r = await repo(name);
    await writeFile(join(r, "README.md"), "changed\n");
    await writeFile(join(r, "new.txt"), "new\n");
    await writeFile(join(r, ".gitignore"), "secret.env\n");
    await writeFile(join(r, "secret.env"), "x\n");
    const snap = await snapshotWip(r, "mac", false);
    const wip = await sh(r, "rev-parse", `refs/wip/${snap!.branch}`);
    return { r, wip };
  };
  test("keeps the snapshot, then cleans tracked and untracked files but not ignored ones", async () => {
    const { r, wip } = await dirtied("reset-ok");
    expect(await treeIs(r, wip)).toBe(true);
    expect(await resetTree(r, wip, S)).toBe("reset");
    expect(await sh(r, "rev-parse", `refs/canopy-moved/${S}`)).toBe(wip);
    expect(await sh(r, "status", "--porcelain")).toBe("");
    expect(existsSync(join(r, "new.txt"))).toBe(false);
    expect(existsSync(join(r, "secret.env"))).toBe(true);
  });
  test("a second run on the clean tree only answers clean", async () => {
    const { r, wip } = await dirtied("reset-twice");
    await resetTree(r, wip, S);
    expect(await resetTree(r, wip, S)).toBe("clean");
  });
  test("an edit after the snapshot is refused and left in place", async () => {
    const { r, wip } = await dirtied("reset-drift");
    await writeFile(join(r, "new.txt"), "edited after\n");
    await expect(resetTree(r, wip, S)).rejects.toThrow(/changed since/);
    expect(await readFile(join(r, "new.txt"), "utf8")).toBe("edited after\n");
  });
  test("HEAD moved since the snapshot is refused", async () => {
    const { r, wip } = await dirtied("reset-head");
    await sh(r, "add", "-A");
    await sh(r, "commit", "-qm", "moved on");
    await expect(resetTree(r, wip, S)).rejects.toThrow(/HEAD moved/);
  });
});
```

If the file's `repo(name)` helper does not create `README.md`, write and commit one first inside `dirtied` (check the helper at `peersync.test.ts:65`).

- [ ] **Step 2: Run and see them fail**

Run: `bun test src/core/peersync.test.ts -t resetTree`
Expected: FAIL, `resetTree` is not exported.

- [ ] **Step 3: Implement** in `src/core/peersync.ts`, after `takeWip` (import `isSessionId` from `./sessions`):

```ts
/** whether the working copy, untracked files included and ignored ones
 *  not, is exactly `commit`'s tree; built in scratch, writing nothing */
export async function treeIs(repo: string, commit: string): Promise<boolean> {
  const want = await git(repo, ["rev-parse", "-q", "--verify", `${commit}^{tree}`]);
  if (want.code !== 0) return false;
  return (await worktreeTree(repo, true)) === want.stdout.trim();
}

/** After a move: the source tree back to HEAD, its uncommitted work kept
 *  first under refs/canopy-moved/<session>, a namespace peer sync neither
 *  fetches nor prunes. Refuses when anything changed since the snapshot
 *  `wip`, so an edit made after the move began is never thrown away. */
export async function resetTree(repo: string, wip: string, session: string): Promise<"reset" | "clean"> {
  if (!isSessionId(session)) throw new Error("session must be a session id");
  const parent = await git(repo, ["rev-parse", "-q", "--verify", `${wip}^`]);
  const head = await git(repo, ["rev-parse", "-q", "--verify", "HEAD"]);
  if (parent.code !== 0 || head.code !== 0 || parent.stdout.trim() !== head.stdout.trim()) {
    throw new Error("HEAD moved since the move began; nothing was reset");
  }
  if (await isBusy(repo)) throw new Error("a merge, rebase or similar is in progress; nothing was reset");
  const keep = await git(repo, ["update-ref", `refs/canopy-moved/${session}`, wip]);
  if (keep.code !== 0) throw new Error(keep.stderr.trim());
  if (!(await isDirty(repo))) return "clean";
  if (!(await treeIs(repo, wip))) throw new Error("the tree changed since the move began; nothing was reset");
  const reset = await git(repo, ["reset", "--hard", "--quiet", "HEAD"]);
  if (reset.code !== 0) throw new Error(reset.stderr.trim());
  const clean = await git(repo, ["clean", "-f", "-d", "--quiet"]);
  if (clean.code !== 0) throw new Error(clean.stderr.trim());
  return "reset";
}
```

- [ ] **Step 4: Run the tests**

Run: `bun test src/core/peersync.test.ts`
Expected: PASS, the whole file.

- [ ] **Step 5: Commit**

```bash
git add src/core/peersync.ts src/core/peersync.test.ts
git commit -m "feat(move): reset the source tree, keeping the snapshot under refs/canopy-moved

Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7"
```

---

### Task 4: The source routes

**Files:**
- Modify: `src/core/types.ts` (add `MovePlan`, `MoveOut`), `src/server/index.ts`
- Create: `src/server/move.test.ts`

**Interfaces:**
- Consumes: `transcriptFile` (Task 1), `endAgent`, `MoveError` (Tasks 1-2), `sendKeys` (Task 2), `resetTree` (Task 3); existing `snapshotWip`, `currentBranch`, `isDirty`, `withPeering`, `peerSettings`, `peerable`, `paneInfo`, `paneAgent`, `newestTranscript`, `agentSessions`, `endTerm`, `refreshAndBroadcast`, `resumeLine`, `agentFor`, `loadConfig`, `shellEnv`, `sendLine`.
- Produces (in `types.ts`, browser-safe):

```ts
/** What a move would carry from a shell, for the confirm sheet and the target's check. */
export interface MovePlan {
  session: string;
  harness: Harness;
  /** the source repo's path, which the target rewrites `cwd` from */
  path: string;
  branch: string;
  head: string;
  /** the transcript's name as the target files it (codex: under sessions/) */
  name: string;
  transcriptBytes: number;
  prompt: string | null;
  /** ms, the transcript's last write */
  at: number;
  /** uncommitted paths, at most 200 */
  files: string[];
  changed: number;
  /** gitignored entries that stay behind */
  ignored: number;
}

/** The source after its agent stopped: what the target loads. */
export interface MoveOut {
  session: string;
  harness: Harness;
  path: string;
  branch: string;
  head: string;
  name: string;
  /** the snapshot commit, null for a clean tree */
  wip: string | null;
}
```

- Routes (all on the shell's own backend):
  - `GET /api/terms/move/plan?term=&session=&harness=` → `MovePlan`. `session`/`harness` are the registry card's, optional.
  - `POST /api/terms/move/out?term=` body `{session, harness}` → `MoveOut`.
  - `GET /api/terms/move/transcript?term=&session=` → the file, `application/x-ndjson`.
  - `POST /api/terms/move/finish?term=` → `{ok: true, reset: "reset" | "clean" | "none"}`.
  - `POST /api/terms/move/undo?term=` → `{ok: true}`: types the resume line back into the same shell and forgets the move.
- `ServerState` gains `moving: Map<string, MoveOut>` (initialised `new Map()` beside `peering: null`).

- [ ] **Step 1: Write the failing server tests** in `src/server/move.test.ts`. Follow `src/server/resume.test.ts` for the scratch homes and `$SHELL`, and `src/server/peers.test.ts` for `CANOPY_PEERS_JSON`. The stub `claude` is a perl script, so tmux reports `perl` and `paneAgent` finds `claude` as its script in the process tree:

```ts
/**
 * Moving a shell's agent session, the source half: the plan, stopping a
 * stub agent in a real tmux shell, the snapshot, the transcript, the
 * clean-up and the undo. A perl `claude` stub reads lines until /exit, so
 * tmux sees an agent the way it sees the real one (by its script name).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFolder } from "../core/sessions";
import { killServer, tmuxBase } from "../core/tmux";
import type { MoveOut, MovePlan } from "../core/types";
import { startServer } from "./index";

const S = "0f5e2c1a-1111-4222-8333-444455556666";
const TERM = "abcdef0123456789abcdef0123456789";
const tmux = Bun.which("tmux") !== null;
let scratch = "";
let root = "";
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const git = (cwd: string, ...args: string[]) => Bun.$`git -C ${cwd} ${args}`.quiet().text();
const post = (p: string, body: unknown = {}) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });

/** a shell at the repo with the stub agent typed into it, once tmux shows it */
async function shellWithAgent(term: string): Promise<void> {
  const ws = new WebSocket(url(`/api/term?id=app&term=${term}&place=panel`).replace("http", "ws"));
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(new TextEncoder().encode("claude\n"));
  for (let i = 0; i < 100; i++) {
    const r = (await (await fetch(url(`/api/terms/agent?term=${term}`))).json()) as { agent: string | null };
    if (r.agent === "claude") return ws.close();
    await Bun.sleep(100);
  }
  throw new Error("the stub agent never showed");
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-move-srv-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "SHELL", "PATH"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CLAUDE_CONFIG_DIR"] = join(scratch, "claude");
  process.env["CODEX_HOME"] = join(scratch, "codex");
  const bin = join(scratch, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), "#!/usr/bin/env perl\nwhile (my $l = <STDIN>) { exit 0 if $l =~ m{/exit\\s*$}; }\n");
  await chmod(join(bin, "claude"), 0o755);
  process.env["PATH"] = `${bin}:${process.env["PATH"]}`;
  process.env["SHELL"] = "/bin/sh";
  root = join(scratch, "root");
  await mkdir(join(root, "app"), { recursive: true });
  await git(join(root, "app"), "init", "-q", "-b", "main");
  await writeFile(join(root, "app", "README.md"), "one\n");
  await git(join(root, "app"), "add", "-A");
  await git(join(root, "app"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one");
  const dir = join(scratch, "claude", "projects", projectFolder(join(root, "app")));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${S}.jsonl`), `${JSON.stringify({ type: "user", cwd: join(root, "app"), message: { content: "fix the login" } })}\n`);
  process.env["CANOPY_PEERS_JSON"] = JSON.stringify({ self: "mac", peerSync: "on", seed: [], peers: [{ name: "mini", alias: null, root: join(scratch, "other"), role: "git" }] });
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  delete process.env["CANOPY_PEERS_JSON"];
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await rm(scratch, { recursive: true, force: true });
});

describe("the source half of a move", () => {
  test.if(tmux)("plan, out, transcript, finish", async () => {
    await shellWithAgent(TERM);
    await writeFile(join(root, "app", "README.md"), "two\n");
    await writeFile(join(root, "app", "new.txt"), "new\n");
    const plan = (await (await fetch(url(`/api/terms/move/plan?term=${TERM}&session=${S}&harness=claude`))).json()) as MovePlan;
    expect(plan).toMatchObject({ session: S, harness: "claude", branch: "main", changed: 2, prompt: "fix the login" });
    expect(plan.files.sort()).toEqual(["README.md", "new.txt"]);

    const early = await fetch(url(`/api/terms/move/transcript?term=${TERM}&session=${S}`));
    expect(early.status).toBe(409);

    const out = (await (await post(`/api/terms/move/out?term=${TERM}`, { session: S, harness: "claude" })).json()) as MoveOut;
    expect(out.wip).toMatch(/^[0-9a-f]{40}$/);
    const again = await post(`/api/terms/move/out?term=${TERM}`, { session: S, harness: "claude" });
    expect(again.status).toBe(409);

    const t = await fetch(url(`/api/terms/move/transcript?term=${TERM}&session=${S}`));
    expect(t.status).toBe(200);
    expect(await t.text()).toContain("fix the login");

    const fin = (await (await post(`/api/terms/move/finish?term=${TERM}`)).json()) as { reset: string };
    expect(fin.reset).toBe("reset");
    expect(await git(join(root, "app"), "status", "--porcelain")).toBe("");
    expect((await git(join(root, "app"), "rev-parse", `refs/canopy-moved/${S}`)).trim()).toBe(out.wip!);
    const terms = (await (await fetch(url("/api/terms"))).json()) as { id: string }[];
    expect(terms.some((x) => x.id === TERM)).toBe(false);
  });

  test.if(tmux)("undo types the resume line back into the same shell and keeps the tree", async () => {
    const term = TERM.replace("ab", "cd");
    await shellWithAgent(term);
    await writeFile(join(root, "app", "README.md"), "three\n");
    await post(`/api/terms/move/out?term=${term}`, { session: S, harness: "claude" });
    expect((await post(`/api/terms/move/undo?term=${term}`)).status).toBe(200);
    expect(await readFile(join(root, "app", "README.md"), "utf8")).toBe("three\n");
    // the move is forgotten: a new out is accepted again
    expect((await post(`/api/terms/move/out?term=${term}`, { session: S, harness: "claude" })).status).toBe(200);
  });

  test.if(tmux)("a detached HEAD is refused at plan, before anything stops", async () => {
    const term = TERM.replace("ab", "ef");
    await shellWithAgent(term);
    const head = (await git(join(root, "app"), "rev-parse", "HEAD")).trim();
    await git(join(root, "app"), "checkout", "-q", "--detach", head);
    try {
      const r = await fetch(url(`/api/terms/move/plan?term=${term}&session=${S}&harness=claude`));
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toMatch(/branch/);
      const agent = (await (await fetch(url(`/api/terms/agent?term=${term}`))).json()) as { agent: string };
      expect(agent.agent).toBe("claude");
    } finally {
      await git(join(root, "app"), "checkout", "-q", "main");
    }
  });

  test("an unknown shell is a 404", async () => {
    expect((await fetch(url("/api/terms/move/plan?term=00000000000000000000000000000000"))).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test src/server/move.test.ts`
Expected: FAIL, the routes answer 404.

- [ ] **Step 3: Add the types** (`MovePlan`, `MoveOut`) to `src/core/types.ts` as shown under Interfaces, near `TermInfo`.

- [ ] **Step 4: Add the state field.** In `interface ServerState` (`src/server/index.ts:204`) add:

```ts
  /** shells whose agent a move has stopped, by term id: what the target
   *  loads, until the move finishes or is undone */
  moving: Map<string, MoveOut>;
```

and `moving: new Map(),` beside `peering: null,` where the state is built (`index.ts:3439`).

- [ ] **Step 5: Add the helpers** above the routes (near `resumeTerm`), with imports from `../core/move`, `../core/peersync` (`currentBranch`, `isDirty`, `resetTree`, `snapshotWip`), `../core/sessions` (`transcriptFile`), `../core/tmux` (`sendKeys`):

```ts
/** A move's shell: held, a plain shell (not a task or the ranger), on this
 *  machine, in a repo peer sync covers, with tmux to drive it. */
function moveShell(state: ServerState, term: string): { live: LiveTerm; repo: Repo; tmux: string[] } {
  const live = state.terms.get(term);
  if (live?.info.task || state.tasks.knows(term) || state.ranger.knows(term)) throw new HttpError(400, "only a plain shell moves");
  if (!live || live.ending) throw new HttpError(404, "no such shell");
  const repo = repoById(state, live.info.repoId);
  if (!peerable(state, repo)) throw new HttpError(400, "a move covers local repos under the launch root");
  if (!state.tmux) throw new HttpError(400, "a move needs tmux shells");
  return { live, repo, tmux: state.tmux };
}

/** peer sync's settings when a move can use them: on, with a self */
async function movePeers(): Promise<PeerSettings & { self: string }> {
  const s = await peerSettings();
  if (!s.self) throw new HttpError(400, "peers are not set up: no self in the config");
  if (s.peerSync === "off") throw new HttpError(409, "peer sync is off");
  return s as PeerSettings & { self: string };
}

/** The session a move carries: the card's when the page names one this
 *  machine has, else the newest of the running harness at the repo. */
async function moveSession(path: string, harness: Harness, asked: string | null): Promise<{ session: string; file: string; name: string }> {
  if (asked && isSessionId(asked)) {
    const got = await transcriptFile(harness, path, asked);
    if (got) return { session: asked, ...got };
  }
  const newest = await newestTranscript(harness, path);
  const id = newest?.match(/([0-9a-f-]{36})\.jsonl$/)?.[1];
  const got = id ? await transcriptFile(harness, path, id) : null;
  if (!id || !got) throw new HttpError(404, `no ${harness} transcript in ${path}`);
  return { session: id, ...got };
}

/** uncommitted paths and gitignored entries, off one porcelain listing */
async function moveFiles(path: string): Promise<{ files: string[]; changed: number; ignored: number }> {
  const r = await git(path, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--ignored=traditional"]);
  const files: string[] = [];
  let changed = 0;
  let ignored = 0;
  const parts = r.stdout.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i]!;
    if (e.length < 4) continue;
    const code = e.slice(0, 2);
    if (code === "!!") {
      ignored++;
      continue;
    }
    changed++;
    if (files.length < 200) files.push(e.slice(3));
    if (code[0] === "R" || code[0] === "C") i++; // the original path follows a rename
  }
  return { files, changed, ignored };
}

/** the pane as a move's stop drives it */
const paneDriver = (tmux: string[], term: string): PaneDriver => ({
  keys: (keys, literal) => sendKeys(tmux, term, keys, literal),
  agent: async () => {
    const pane = await paneInfo(tmux, term);
    const a = pane ? await paneAgent(pane) : null;
    return a === "claude" || a === "codex" ? a : null;
  },
});
```

Check `paneAgent`'s return type (`AgentKind`): if it is already `Harness | null`, drop the narrowing.

- [ ] **Step 6: Add the routes** next to `/api/terms/transcript`:

```ts
  if (path === "/api/terms/move/plan" && method === "GET") {
    const term = url.searchParams.get("term") ?? "";
    const { live, tmux } = moveShell(state, term);
    await movePeers();
    const running = await paneDriver(tmux, term).agent();
    if (!running) throw new HttpError(409, "no agent runs in that shell");
    const at = live.info.path;
    const branch = await currentBranch(at);
    if (!branch) throw new HttpError(409, "a detached HEAD: a move needs a branch");
    const head = (await git(at, ["rev-parse", "HEAD"])).stdout.trim();
    const { session, file, name } = await moveSession(at, running, url.searchParams.get("session"));
    const st = await stat(file);
    if (st.size > MOVE_MAX) throw new HttpError(413, "the transcript is over 64 MB");
    const seen = (await agentSessions(at, 200)).find((x) => x.id === session);
    const plan: MovePlan = { session, harness: running, path: at, branch, head, name, transcriptBytes: st.size, prompt: seen?.prompt ?? null, at: st.mtimeMs, ...(await moveFiles(at)) };
    return json(plan);
  }
  if (path === "/api/terms/move/out" && method === "POST") {
    const term = url.searchParams.get("term") ?? "";
    const { live, repo, tmux } = moveShell(state, term);
    if (state.moving.has(term)) throw new HttpError(409, "that shell is already moving");
    const b = (await req.json().catch(() => null)) as { session?: unknown; harness?: unknown } | null;
    if (!isSessionId(b?.session) || !isHarness(b?.harness)) throw new HttpError(400, "session and harness are required");
    const s = await movePeers();
    const activeRun = state.runner.activeFor(repo.id);
    if (activeRun) throw new HttpError(409, busyWith(repo.name, activeRun.verb));
    if (state.flows.activeFor(repo.id)) throw new HttpError(409, "a workflow is running here");
    const at = live.info.path;
    const branch = await currentBranch(at);
    if (!branch) throw new HttpError(409, "a detached HEAD: a move needs a branch");
    const found = await transcriptFile(b.harness, at, b.session);
    if (!found) throw new HttpError(404, `no ${b.harness} conversation under that id at this repo`);
    let stopped: boolean;
    try {
      stopped = await endAgent(paneDriver(tmux, term), b.harness);
    } catch (err) {
      if (err instanceof MoveError) throw new HttpError(err.status, err.message);
      throw err;
    }
    if (!stopped) throw new HttpError(409, "the agent did not quit within 20 s; nothing else was touched");
    // on record as soon as the agent is gone, so a snapshot that fails
    // below still leaves "resume here" (move/undo) something to resume
    const stoppedOut: MoveOut = { session: b.session, harness: b.harness, path: at, branch, head: "", name: found.name, wip: null };
    state.moving.set(term, stoppedOut);
    const out = await withPeering(state, async (): Promise<MoveOut> => {
      const head = (await git(at, ["rev-parse", "HEAD"])).stdout.trim();
      let wip: string | null = null;
      if (await isDirty(at)) {
        await snapshotWip(at, s.self, false);
        const r = await git(at, ["rev-parse", "-q", "--verify", `refs/wip/${branch}`]);
        if (r.code !== 0) throw new HttpError(500, "the snapshot was not written; resume here to carry on");
        wip = r.stdout.trim();
      }
      return { ...stoppedOut, head, wip };
    });
    state.moving.set(term, out);
    return json(out);
  }
  if (path === "/api/terms/move/transcript" && method === "GET") {
    const term = url.searchParams.get("term") ?? "";
    const out = state.moving.get(term);
    if (!out || out.session !== url.searchParams.get("session")) throw new HttpError(409, "stop the agent first (move/out)");
    const found = await transcriptFile(out.harness, out.path, out.session);
    if (!found) throw new HttpError(404, "the transcript is gone");
    return new Response(Bun.file(found.file), { headers: { "Content-Type": "application/x-ndjson" } });
  }
  if (path === "/api/terms/move/finish" && method === "POST") {
    const term = url.searchParams.get("term") ?? "";
    const out = state.moving.get(term);
    if (!out) throw new HttpError(409, "that shell is not moving");
    const live = state.terms.get(term);
    const repoId = live?.info.repoId;
    let reset: "reset" | "clean" | "none" = "none";
    if (out.wip) {
      try {
        reset = await withPeering(state, () => resetTree(out.path, out.wip!, out.session));
      } catch (err) {
        throw new HttpError(409, err instanceof Error ? err.message : String(err));
      }
    }
    await endTerm(state, term);
    state.moving.delete(term);
    if (repoId) await refreshAndBroadcast(state, repoId);
    return json({ ok: true, reset });
  }
  if (path === "/api/terms/move/undo" && method === "POST") {
    const term = url.searchParams.get("term") ?? "";
    const out = state.moving.get(term);
    // a stop that failed before the agent quit left nothing to undo
    if (!out) return json({ ok: true, resumed: false });
    const { repo, tmux } = moveShell(state, term);
    const line = resumeLine(out.session, agentFor(await loadConfig(), repo.path, "shell", { harness: out.harness }), shellEnv(state, repo.id, repo.path, term));
    await sendLine(tmux, term, line);
    state.moving.delete(term);
    return json({ ok: true, resumed: true });
  }
```

Import `stat` from `node:fs/promises` if `index.ts` does not already, and `MOVE_MAX`, `MoveError`, `endAgent`, `type PaneDriver` from `../core/move`. `HttpError` thrown inside a route is turned into its status by the handler's existing catch; confirm by grepping `instanceof HttpError` near the top-level `fetch` handler.

- [ ] **Step 7: Run the tests**

Run: `bun test src/server/move.test.ts`
Expected: PASS. If the stub agent never shows, check `tmux` is on the PATH and that `paneAgent` reads the perl script's argv; `bun test src/server/resume.test.ts` must still pass too.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/server/index.ts src/server/move.test.ts
git commit -m "feat(move): the source routes, plan, out, transcript, finish and undo

Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7"
```

---

### Task 5: The target routes

**Files:**
- Modify: `src/core/types.ts` (add `MoveCheck`), `src/server/index.ts`, `src/server/move.test.ts`

**Interfaces:**
- Consumes: `MovePlan`, `MoveOut` (Task 4), `rewriteTranscript`, `placeTranscript`, `MOVE_MAX`, `MoveError` (Task 1), `treeIs` (Task 3); existing `initRepo`, `syncRepo`, `PassSeen`, `applyPeerState`, `fetchPeer`, `gitSshCommand`, `configDir`, `takeWip`, `isBusy`, `resumeTerm`, `termPlace`, `termSize`, `isTermId`.
- Produces:

```ts
/** The target's answer before anything stops. */
export interface MoveCheck {
  ok: boolean;
  reason?: string;
  /** the target repo's path */
  path: string;
  /** a copy of the session is already here (an earlier move the other way) */
  existing: boolean;
}
```

  - `POST /api/repos/movecheck?id=<target repo>` body `{from, branch, head, transcriptBytes, session, harness}` → `MoveCheck`.
  - `POST /api/repos/movein?id=<target repo>` multipart: field `meta` (JSON of `MoveOut & { from: string; term: string; place: ShellPlace; cols: number; rows: number }`) and file `transcript` → `TermInfo` (201).
- `maxRequestBodySize` covers `MOVE_MAX` plus 1 MB.

- [ ] **Step 1: Write the failing tests**, appended to `src/server/move.test.ts`. They use the server as the target. The source is a clone at `other/app` driven with core calls, and the config gets a second peer named `src` whose root is `other` (set `CANOPY_PEERS_JSON` in a `beforeAll` of this `describe` and restore it after):

```ts
describe("the target half of a move", () => {
  const SRC = "src";
  let other = "";
  let saved = "";
  beforeAll(async () => {
    other = join(scratch, "other");
    await mkdir(other, { recursive: true });
    await Bun.$`git clone -q ${join(root, "app")} ${join(other, "app")}`.quiet();
    await git(join(other, "app"), "config", "user.email", "t@t");
    await git(join(other, "app"), "config", "user.name", "t");
    saved = process.env["CANOPY_PEERS_JSON"]!;
    process.env["CANOPY_PEERS_JSON"] = JSON.stringify({ self: "mini", peerSync: "on", seed: [], peers: [{ name: SRC, alias: null, root: other, role: "git" }] });
  });
  afterAll(() => {
    process.env["CANOPY_PEERS_JSON"] = saved;
  });

  /** the source's half done by hand: a change, its snapshot, and its transcript */
  async function sourceOut(dirty: boolean): Promise<{ out: MoveOut; text: string }> {
    const src = join(other, "app");
    if (dirty) await writeFile(join(src, "moved.txt"), "carried\n");
    const { snapshotWip } = await import("../core/peersync");
    await snapshotWip(src, SRC, false);
    const wip = dirty ? (await git(src, "rev-parse", "refs/wip/main")).trim() : null;
    const head = (await git(src, "rev-parse", "HEAD")).trim();
    const text = `${JSON.stringify({ type: "user", cwd: src, message: { content: "carry on" } })}\n`;
    return { out: { session: S, harness: "claude", path: src, branch: "main", head, name: `${S}.jsonl`, wip }, text };
  }
  const check = (body: Record<string, unknown>) => post("/api/repos/movecheck?id=app", body);
  const load = (out: MoveOut, text: string, term: string) => {
    const form = new FormData();
    form.set("meta", JSON.stringify({ ...out, from: SRC, term, place: "panel", cols: 80, rows: 24 }));
    form.set("transcript", new Blob([text]), "t.jsonl");
    return fetch(url("/api/repos/movein?id=app"), { method: "POST", body: form });
  };

  test("check passes on a clean target at the same commit", async () => {
    await git(join(root, "app"), "checkout", "-q", "--", ".");
    await git(join(root, "app"), "clean", "-fdq");
    const { out } = await sourceOut(true);
    const r = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: S, harness: "claude" })).json()) as MoveCheck;
    expect(r).toMatchObject({ ok: true, path: join(root, "app") });
  });

  test("check refuses a dirty target and another branch, by reason, changing nothing", async () => {
    const { out } = await sourceOut(true);
    await writeFile(join(root, "app", "local.txt"), "mine\n");
    const dirty = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: S, harness: "claude" })).json()) as MoveCheck;
    expect(dirty.ok).toBe(false);
    expect(dirty.reason).toMatch(/uncommitted/);
    await rm(join(root, "app", "local.txt"));
    await git(join(root, "app"), "checkout", "-qb", "side");
    try {
      const side = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: S, harness: "claude" })).json()) as MoveCheck;
      expect(side.ok).toBe(false);
      expect(side.reason).toMatch(/side.*main|main.*side/);
      expect((await git(join(root, "app"), "branch", "--show-current")).trim()).toBe("side");
    } finally {
      await git(join(root, "app"), "checkout", "-q", "main");
    }
  });

  test("check refuses when the peer's copy cannot be fetched (filed elsewhere, or offline)", async () => {
    const { out } = await sourceOut(true);
    const before = process.env["CANOPY_PEERS_JSON"]!;
    process.env["CANOPY_PEERS_JSON"] = JSON.stringify({ self: "mini", peerSync: "on", seed: [], peers: [{ name: SRC, alias: null, root: join(scratch, "nowhere"), role: "git" }] });
    try {
      const r = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: S, harness: "claude" })).json()) as MoveCheck;
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/could not be reached/);
    } finally {
      process.env["CANOPY_PEERS_JSON"] = before;
    }
  });

  test("check refuses a transcript over the cap", async () => {
    const r = await check({ from: SRC, branch: "main", head: "x", transcriptBytes: 64 * 1024 * 1024 + 1, session: S, harness: "claude" });
    expect(r.status).toBe(413);
  });

  test.if(tmux)("load lands the work, writes the transcript under this repo's folder, and resumes", async () => {
    const { out, text } = await sourceOut(true);
    const term = "1234567890abcdef1234567890abcdef";
    const r = await load(out, text, term);
    expect(r.status).toBe(201);
    expect(await readFile(join(root, "app", "moved.txt"), "utf8")).toBe("carried\n");
    const file = join(scratch, "claude", "projects", projectFolder(join(root, "app")), `${S}.jsonl`);
    expect(JSON.parse((await readFile(file, "utf8")).trim()).cwd).toBe(join(root, "app"));
    // a retry after a lost answer starts only the shell
    const again = await load(out, text, term.replace("12", "34"));
    expect(again.status).toBe(201);
    await git(join(root, "app"), "checkout", "-q", "--", ".");
    await git(join(root, "app"), "clean", "-fdq");
  });

  test.if(tmux)("a clean source moves only the conversation", async () => {
    await rm(join(other, "app", "moved.txt"), { force: true });
    const { out, text } = await sourceOut(false);
    expect(out.wip).toBeNull();
    const r = await load(out, text, "5678567856785678567856785678abcd");
    expect(r.status).toBe(201);
    expect(await git(join(root, "app"), "status", "--porcelain")).toBe("");
  });

  test("load refuses a snapshot that is not the one the source named", async () => {
    const { out, text } = await sourceOut(true);
    const r = await load({ ...out, wip: "0".repeat(40) }, text, "9999999999999999999999999999abcd");
    expect(r.status).toBe(409);
    expect(existsSync(join(root, "app", "moved.txt"))).toBe(false);
  });
});
```

Add `MoveCheck` to the type import at the top of the file.

- [ ] **Step 2: Run and see them fail**

Run: `bun test src/server/move.test.ts -t "target half"`
Expected: FAIL, `/api/repos/movecheck` answers 404.

- [ ] **Step 3: Add `MoveCheck`** to `src/core/types.ts` as shown under Interfaces.

- [ ] **Step 4: Raise the body cap.** At `maxRequestBodySize` (`index.ts:3725`):

```ts
      maxRequestBodySize: Math.max(INTAKE_BODY_MAX, PUT_MAX, PASTE_MAX, MOVE_MAX) + 1024 * 1024,
```

- [ ] **Step 5: Add a shared readiness check** near the source helpers:

```ts
/** Why the target cannot take a move as it stands, or null when it can:
 *  the peer's branch as fetched is `head` (which proves the fetch reached
 *  the source under this repo's id and this peer's name, so the load's
 *  fetch will too), and here is on `branch`, at `head`, clean, with no
 *  merge or rebase in progress. */
async function moveBlocker(path: string, name: string, from: string, branch: string, head: string): Promise<string | null> {
  const theirs = await git(path, ["rev-parse", "-q", "--verify", `refs/remotes/${from}/${branch}`]);
  if (theirs.code !== 0 || theirs.stdout.trim() !== head) {
    return `${from} could not be reached for ${name}, or its ${branch} is not where the move says (is the repo filed under the same folder on both machines?)`;
  }
  if (await isBusy(path)) return `${name} has a merge, rebase or similar in progress`;
  const on = await currentBranch(path);
  if (on !== branch) return `${name} is on ${on ?? "a detached HEAD"} here, not ${branch}`;
  const here = (await git(path, ["rev-parse", "HEAD"])).stdout.trim();
  if (here !== head) return `${name} is at ${here.slice(0, 7)} here and ${head.slice(0, 7)} there, and a sync could not bring it level`;
  if (await isDirty(path)) return `${name} has uncommitted changes here`;
  return null;
}

/** the git peer a move comes from, by the name the page gives */
function movePeer(s: PeerSettings, from: unknown): Peer {
  const peer = s.peers.find((p) => p.name === from && p.role === "git");
  if (!peer) throw new HttpError(404, `no git peer named ${String(from)}`);
  return peer;
}
```

- [ ] **Step 6: Add the two repo actions** inside the `/api/repos/<action>` block, after the `peer` action:

```ts
    if (method === "POST" && action === "movecheck") {
      if (!peerable(state, repo)) throw new HttpError(400, "a move covers local repos under the launch root");
      const b = (await req.json().catch(() => null)) as { from?: unknown; branch?: unknown; head?: unknown; transcriptBytes?: unknown; session?: unknown; harness?: unknown } | null;
      if (typeof b?.branch !== "string" || typeof b.head !== "string" || typeof b.transcriptBytes !== "number" || !isSessionId(b.session) || !isHarness(b.harness)) {
        throw new HttpError(400, "from, branch, head, transcriptBytes, session and harness are required");
      }
      if (b.transcriptBytes > MOVE_MAX) throw new HttpError(413, "the transcript is over 64 MB");
      const s = await movePeers();
      const peer = movePeer(s, b.from);
      const activeRun = state.runner.activeFor(repo.id);
      if (activeRun) throw new HttpError(409, busyWith(repo.name, activeRun.verb));
      if (state.flows.activeFor(repo.id)) throw new HttpError(409, "a workflow is running here");
      await withPeering(state, async () => {
        await initRepo(repo.path, repo.id, s.peers, false);
        applyPeerState(state, repo.id, await syncRepo(repo.id, { self: s.self, peers: s.peers, seed: s.seed, dry: false, root: state.root }, new PassSeen()));
      });
      const reason = await moveBlocker(repo.path, repo.name, peer.name, b.branch, b.head);
      const check: MoveCheck = { ok: reason === null, ...(reason ? { reason } : {}), path: repo.path, existing: await hasAgentSession(b.harness, repo.path, b.session) };
      return json(check);
    }
    if (method === "POST" && action === "movein") {
      if (!peerable(state, repo)) throw new HttpError(400, "a move covers local repos under the launch root");
      if (Number(req.headers.get("content-length") ?? 0) > MOVE_MAX + 1024 * 1024) throw new HttpError(413, "the transcript is over 64 MB");
      const form = await req.formData().catch(() => null);
      const raw = form?.get("meta");
      const file = form?.get("transcript");
      if (typeof raw !== "string" || !(file instanceof Blob)) throw new HttpError(400, "meta and transcript are required");
      const m = JSON.parse(raw) as Partial<MoveOut> & { from?: unknown; term?: unknown; place?: unknown; cols?: unknown; rows?: unknown };
      if (!isSessionId(m.session) || !isHarness(m.harness) || typeof m.path !== "string" || typeof m.branch !== "string" || typeof m.head !== "string" || typeof m.name !== "string" || !isTermId(m.term)) {
        throw new HttpError(400, "malformed meta");
      }
      if (m.wip !== null && !(typeof m.wip === "string" && /^[0-9a-f]{40}$/.test(m.wip))) throw new HttpError(400, "wip must be a commit or null");
      const s = await movePeers();
      const peer = movePeer(s, m.from);
      const meta = m as MoveOut & { term: string };
      const text = await file.text();
      try {
        await withPeering(state, async () => {
          // a retry after a lost answer: the work is already here, exactly
          const landed = meta.wip !== null && (await isDirty(repo.path)) && (await treeIs(repo.path, meta.wip));
          if (!landed) {
            const fetched = await fetchPeer(repo.path, repo.id, peer, { GIT_SSH_COMMAND: gitSshCommand(configDir()) });
            if (fetched !== "ok") throw new HttpError(409, `could not fetch from ${peer.name}: ${fetched}`);
            const reason = await moveBlocker(repo.path, repo.name, peer.name, meta.branch, meta.head);
            if (reason) throw new HttpError(409, reason);
          }
          if (meta.wip && !landed) {
            const got = await git(repo.path, ["rev-parse", "-q", "--verify", `refs/peer-wip/${peer.name}/${meta.branch}`]);
            if (got.stdout.trim() !== meta.wip) throw new HttpError(409, `${peer.name}'s snapshot is not the one this move named`);
            const took = await takeWip(repo.path, peer.name, meta.branch);
            if (took.how === "branch") throw new HttpError(409, `the work landed on branch ${took.branch ?? "?"} instead of the tree; take it from there`);
          }
          const moved = rewriteTranscript(text, meta.path, repo.path);
          await placeTranscript({ harness: meta.harness, session: meta.session, text: moved, name: meta.name, to: repo.path });
        });
      } catch (err) {
        if (err instanceof MoveError) throw new HttpError(err.status, err.message);
        throw err;
      }
      const info = await resumeTerm(state, repo, meta.term, termPlace(m.place), meta.session, meta.harness, termSize(m.cols, m.rows));
      await refreshAndBroadcast(state, repo.id);
      return json(info, 201);
    }
```

Imports to add: `treeIs`, `fetchPeer`, `gitSshCommand`, `isBusy`, `currentBranch`, `isDirty` from `../core/peersync`; `configDir` from `../core/store` if not imported; `rewriteTranscript`, `placeTranscript` from `../core/move`; `MoveCheck`, `MoveOut`, `MovePlan`, `Peer`, `PeerSettings` types as needed.

Note on the order inside `movein`: the transcript is written only after the work landed, so a refused take leaves no transcript behind; a transcript refused for a split copy (409) leaves the landed work, which a retry then finds (`landed`) and skips.

- [ ] **Step 7: Run the tests**

Run: `bun test src/server/move.test.ts src/server/peers.test.ts`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add src/core/types.ts src/server/index.ts src/server/move.test.ts
git commit -m "feat(move): the target routes, movecheck and movein

Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7"
```

---

### Task 6: The step runner and the API calls

**Files:**
- Create: `ui/src/move.ts`, `ui/src/move.test.ts`
- Modify: `ui/src/api.ts`, `ui/src/store.ts`

**Interfaces:**
- Consumes: `MovePlan`, `MoveOut`, `MoveCheck`, `TermInfo` from `../../src/core/types`.
- Produces:
  - in `ui/src/move.ts`:

```ts
export const MOVE_STEPS = ["check", "stop", "transcript", "load", "clean"] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];
export interface MoveDeps {
  check(): Promise<MoveCheck>;
  stop(): Promise<MoveOut>;
  transcript(out: MoveOut): Promise<Blob>;
  load(out: MoveOut, transcript: Blob): Promise<TermInfo>;
  clean(): Promise<void>;
}
export type MoveOutcome =
  | { ok: true; term: TermInfo }
  | { ok: false; step: MoveStep; error: string; stopped: boolean; loaded: TermInfo | null };
export function runMove(deps: MoveDeps, onStep: (s: MoveStep) => void): Promise<MoveOutcome>;
```

  - in `api.ts`: `movePlan(term, session?, harness?) → MovePlan`, `moveCheck(repoId, body) → MoveCheck`, `moveOut(term, session, harness) → MoveOut`, `moveTranscript(term, session) → Blob`, `moveIn(repoId, out, from, term, place, cols, rows) → TermInfo` (qualified), `moveFinish(term) → { ok: true; reset: string }`, `moveUndo(term) → { ok: true }`.
  - in `store.ts`: `landMove(oldTab: string, fromRepoId: string, toRepoId: string, info: TermInfo) => void`.

- [ ] **Step 1: Write the failing runner tests** in `ui/src/move.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import type { MoveCheck, MoveOut, TermInfo } from "../../src/core/types";
import { runMove, type MoveDeps, type MoveStep } from "./move";

const OUT = { session: "s", harness: "claude", path: "/a", branch: "main", head: "h", name: "s.jsonl", wip: null } as MoveOut;
const TERM = { id: "t" } as TermInfo;
const deps = (fail?: MoveStep, check: MoveCheck = { ok: true, path: "/b", existing: false }): MoveDeps & { calls: string[] } => {
  const calls: string[] = [];
  const at = <T>(s: MoveStep, v: T) => async () => {
    calls.push(s);
    if (s === fail) throw new Error(`${s} broke`);
    return v;
  };
  return { calls, check: at("check", check), stop: at("stop", OUT), transcript: at("transcript", new Blob(["x"])), load: at("load", TERM), clean: at("clean", undefined) };
};

describe("runMove", () => {
  test("every step in order", async () => {
    const d = deps();
    const seen: MoveStep[] = [];
    expect(await runMove(d, (s) => seen.push(s))).toEqual({ ok: true, term: TERM });
    expect(seen).toEqual(["check", "stop", "transcript", "load", "clean"]);
  });
  test("a refused check stops before anything stops", async () => {
    const d = deps(undefined, { ok: false, reason: "dirty", path: "/b", existing: false });
    expect(await runMove(d, () => {})).toEqual({ ok: false, step: "check", error: "dirty", stopped: false, loaded: null });
    expect(d.calls).toEqual(["check"]);
  });
  test("a failed stop counts as stopped, so the sheet offers resume here", async () => {
    expect(await runMove(deps("stop"), () => {})).toMatchObject({ ok: false, step: "stop", stopped: true, loaded: null });
  });
  test("a failed load says the agent was stopped and nothing loaded", async () => {
    expect(await runMove(deps("load"), () => {})).toMatchObject({ ok: false, step: "load", stopped: true, loaded: null });
  });
  test("a failed clean says the session already runs on the target", async () => {
    expect(await runMove(deps("clean"), () => {})).toMatchObject({ ok: false, step: "clean", stopped: true, loaded: TERM });
  });
});
```

- [ ] **Step 2: Run and see them fail**

Run: `bun test ui/src/move.test.ts`
Expected: FAIL, `Cannot find module './move'`.

- [ ] **Step 3: Write `ui/src/move.ts`**

```ts
import type { MoveCheck, MoveOut, TermInfo } from "../../src/core/types";

/*
 * A shell's agent session moved to another backend, step by step: the
 * target's check, the source's stop, the transcript off the source, the
 * target's load, the source's clean-up. Each step is one call to one
 * backend; the outcome says how far it got, so the sheet can offer the
 * right way back.
 */

export const MOVE_STEPS = ["check", "stop", "transcript", "load", "clean"] as const;
export type MoveStep = (typeof MOVE_STEPS)[number];

export interface MoveDeps {
  check(): Promise<MoveCheck>;
  stop(): Promise<MoveOut>;
  transcript(out: MoveOut): Promise<Blob>;
  load(out: MoveOut, transcript: Blob): Promise<TermInfo>;
  clean(): Promise<void>;
}

export type MoveOutcome =
  | { ok: true; term: TermInfo }
  | { ok: false; step: MoveStep; error: string; stopped: boolean; loaded: TermInfo | null };

const text = (err: unknown): string => (err instanceof Error ? err.message : String(err));

export async function runMove(deps: MoveDeps, onStep: (s: MoveStep) => void): Promise<MoveOutcome> {
  let step: MoveStep = "check";
  let stopped = false;
  let loaded: TermInfo | null = null;
  try {
    onStep(step);
    const c = await deps.check();
    if (!c.ok) return { ok: false, step, error: c.reason ?? "the target cannot take it", stopped, loaded };
    onStep((step = "stop"));
    // the stop may quit the agent and then fail on the snapshot, so from
    // here on the source counts as stopped (its undo is a no-op otherwise)
    stopped = true;
    const out = await deps.stop();
    onStep((step = "transcript"));
    const blob = await deps.transcript(out);
    onStep((step = "load"));
    loaded = await deps.load(out, blob);
    onStep((step = "clean"));
    await deps.clean();
    return { ok: true, term: loaded };
  } catch (err) {
    return { ok: false, step, error: text(err), stopped, loaded };
  }
}
```

- [ ] **Step 4: Run the runner tests**

Run: `bun test ui/src/move.test.ts`
Expected: PASS.

- [ ] **Step 5: Add the API calls** to `ui/src/api.ts`. First a raw-body request beside `req`, since the transcript is not JSON:

```ts
/** A GET whose body is a file, not JSON: the gate's cookie rides along,
 *  and a refusal's JSON error still comes back as the error. */
async function blobReq(b: string, path: string): Promise<Blob> {
  if (!reachable(b)) throw new Error(`${b} has not answered yet`);
  const base = baseOf(b);
  const r = await fetch(base + path, base ? { credentials: "include" } : {});
  if (!r.ok) {
    const body = (await r.json().catch(() => null)) as { error?: string } | null;
    throw new Error(body?.error ?? `${r.status} ${r.statusText}`);
  }
  return r.blob();
}
```

Then, in the `api` object near `resumeAgent`:

```ts
  /** what moving a shell's session would carry, from the shell's backend */
  movePlan: (term: string, session?: string | null, harness?: Harness | null) =>
    repoReq<MovePlan>(term, (p) => `/api/terms/move/plan?term=${encodeURIComponent(p)}${session ? `&session=${session}` : ""}${harness ? `&harness=${harness}` : ""}`),
  /** whether the target repo can take a move as it stands */
  moveCheck: (repoId: string, body: { from: string; branch: string; head: string; transcriptBytes: number; session: string; harness: Harness }) =>
    repoReq<MoveCheck>(repoId, (p) => `/api/repos/movecheck?${rq(p)}`, { method: "POST", body: JSON.stringify(body) }),
  /** stops the shell's agent and snapshots its work */
  moveOut: (term: string, session: string, harness: Harness) =>
    repoReq<MoveOut>(term, (p) => `/api/terms/move/out?term=${encodeURIComponent(p)}`, { method: "POST", body: JSON.stringify({ session, harness }) }),
  moveTranscript: (term: string, session: string) => {
    const [b, plain] = on(term);
    return blobReq(b, `/api/terms/move/transcript?term=${encodeURIComponent(plain)}&session=${session}`);
  },
  /** loads the moved work and conversation into a new shell `term` at the target repo */
  moveIn: async (repoId: string, out: MoveOut, transcript: Blob, source: string, term: string, place: ShellPlace, cols = 80, rows = 24) => {
    const [b, plain] = on(repoId);
    const form = new FormData();
    form.set("meta", JSON.stringify({ ...out, from: source, term: plainOf(term), place, cols, rows }));
    form.set("transcript", transcript, "transcript.jsonl");
    return from(b, await req<TermInfo>(b, `/api/repos/movein?${rq(plain)}`, { method: "POST", body: form }), qTerm);
  },
  moveFinish: (term: string) =>
    repoReq<{ ok: true; reset: string }>(term, (p) => `/api/terms/move/finish?term=${encodeURIComponent(p)}`, { method: "POST" }),
  moveUndo: (term: string) =>
    repoReq<{ ok: true }>(term, (p) => `/api/terms/move/undo?term=${encodeURIComponent(p)}`, { method: "POST" }),
```

The parameter is `source`, not `from`, so it does not shadow the module's `from` qualifier. `req` sets a JSON content type only for a string body, so a `FormData` body keeps the browser's multipart header. Add the type imports.

- [ ] **Step 6: Add `landMove` to the store** (`ui/src/store.ts`), in the interface beside `resumeAgent` and in the implementation after it:

```ts
  /** after a move: the old tab gone, the panel showing the target's
   *  checkout, and the moved shell's tab in the old one's place */
  landMove: (oldTab: string, fromRepoId: string, toRepoId: string, info: TermInfo) => void;
```

```ts
  landMove: (oldTab, fromRepoId, toRepoId, info) => {
    get().switchCheckout(fromRepoId, toRepoId);
    const s = get();
    const repo = s.repos.find((r) => r.id === toRepoId);
    if (!repo) return;
    const tab: TermTab = { id: info.id, repoId: repo.id, name: repo.name, path: repo.path, place: info.place };
    set((now) => ({
      terms: [...now.terms.filter((t) => t.id !== oldTab && t.id !== info.id), tab],
      ...(info.place === "panel" ? { ...dockPanel(now, toRepoId), closedSections: unfoldIn(now.closedSections, toRepoId, "shell") } : { activeTerm: info.id }),
    }));
  },
```

- [ ] **Step 7: Run the UI tests and the typecheck**

Run: `bun test ui/src && bun run typecheck`
Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add ui/src/move.ts ui/src/move.test.ts ui/src/api.ts ui/src/store.ts
git commit -m "feat(move): the step runner, the API calls and landing the moved tab

Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7"
```

---

### Task 7: The button and the sheet

**Files:**
- Create: `ui/src/components/MoveSheet.tsx`
- Modify: `ui/src/components/AgentButtons.tsx`, `ui/src/styles.css`

**Interfaces:**
- Consumes: `runMove`, `MOVE_STEPS`, `MoveStep`, `MoveOutcome` (Task 6), the `api.move*` calls, `landMove`, `cardOf`, `backendOf`, `plainOf`, `cardOfShell`, `useShellAgent`'s card (extend it to return `session`).
- Produces: `MoveButton({ tab, harness, session })`, rendered by `AgentButtons` beside `HandoffButton`.

Read `DESIGN.md` if the repo has one, and the "Layout and motion" and "ui/" sections of `docs/architecture.md`, before writing the markup.

- [ ] **Step 1: Return the card's session from `useShellAgent`** in `AgentButtons.tsx`:

```ts
function useShellAgent(tab: TermTab): { harness: Harness | null; transcript: string | null; session: string | null } {
  // ...as it is...
  return { harness: fromCard ?? pane, transcript: card?.transcript ?? null, session: card?.session ?? null };
}
```

and render the button beside `HandoffButton`:

```tsx
      {!seed && agent.harness && tab.task === undefined && <MoveButton tab={tab} harness={agent.harness} session={agent.session} />}
```

- [ ] **Step 2: Write `ui/src/components/MoveSheet.tsx`**

```tsx
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { Harness, MoveCheck, MovePlan, TermInfo } from "../../../src/core/types";
import { api } from "../api";
import { backendOf, qual } from "../registry";
import { MOVE_STEPS, runMove, type MoveOutcome, type MoveStep } from "../move";
import { cardOf, useStore } from "../store";
import { termId, type TermTab } from "../term";

const STEP_TEXT: Record<MoveStep, string> = {
  check: "the target can take it",
  stop: "the agent quit here, its work saved",
  transcript: "the conversation read",
  load: "work and conversation loaded there",
  clean: "this tree cleaned, this shell closed",
};

const ago = (ms: number): string => {
  const m = Math.round((Date.now() - ms) / 60_000);
  return m < 1 ? "just now" : m < 60 ? `${m} min ago` : `${Math.round(m / 60)} h ago`;
};

/** "move to <backend>": shown when the repo is checked out on another backend the page shows */
export function MoveButton({ tab, harness, session }: { tab: TermTab; harness: Harness; session: string | null }) {
  const card = useStore((s) => cardOf(s, tab.repoId));
  const here = backendOf(tab.id);
  const targets = (card?.checkouts ?? []).filter((c) => backendOf(c.id) !== here);
  const [to, setTo] = useState<string | null>(null);
  const [picking, setPicking] = useState(false);
  if (targets.length === 0) return null;
  const open = (repoId: string) => {
    setPicking(false);
    setTo(repoId);
  };
  return (
    <>
      <button
        type="button"
        className="term-new term-word"
        title="Carry this conversation and the uncommitted work to the same repo on another machine"
        onClick={() => (targets.length === 1 ? open(targets[0]!.id) : setPicking((p) => !p))}
      >
        {targets.length === 1 ? `move to ${backendOf(targets[0]!.id)}` : "move to…"}
      </button>
      {picking && (
        <span className="move-pick" role="menu">
          {targets.map((t) => (
            <button key={t.id} type="button" role="menuitem" className="mini" onClick={() => open(t.id)}>
              {backendOf(t.id)}
            </button>
          ))}
        </span>
      )}
      {to && createPortal(<MoveSheet tab={tab} harness={harness} session={session} toRepoId={to} close={() => setTo(null)} />, document.body)}
    </>
  );
}

function MoveSheet({ tab, harness, session, toRepoId, close }: { tab: TermTab; harness: Harness; session: string | null; toRepoId: string; close: () => void }) {
  const landMove = useStore((s) => s.landMove);
  const from = backendOf(tab.id);
  const to = backendOf(toRepoId);
  const [plan, setPlan] = useState<MovePlan | null>(null);
  const [check, setCheck] = useState<MoveCheck | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [showFiles, setShowFiles] = useState(false);
  const [step, setStep] = useState<MoveStep | null>(null);
  const [outcome, setOutcome] = useState<MoveOutcome | null>(null);

  useEffect(() => {
    let live = true;
    (async () => {
      const p = await api.movePlan(tab.id, session, harness);
      if (!live) return;
      setPlan(p);
      const c = await api.moveCheck(toRepoId, { from, branch: p.branch, head: p.head, transcriptBytes: p.transcriptBytes, session: p.session, harness: p.harness });
      if (live) setCheck(c);
    })().catch((err: unknown) => live && setError(err instanceof Error ? err.message : String(err)));
    return () => {
      live = false;
    };
  }, [tab.id, toRepoId, from, session, harness]);

  const go = async () => {
    if (!plan) return;
    const result = await runMove(
      {
        check: () => api.moveCheck(toRepoId, { from, branch: plan.branch, head: plan.head, transcriptBytes: plan.transcriptBytes, session: plan.session, harness: plan.harness }),
        stop: () => api.moveOut(tab.id, plan.session, plan.harness),
        transcript: (out) => api.moveTranscript(tab.id, out.session),
        load: (out, blob) => api.moveIn(toRepoId, out, blob, from, qual(to, termId()), tab.place === "strip" ? "strip" : "panel"),
        clean: async () => {
          await api.moveFinish(tab.id);
        },
      },
      setStep,
    );
    setOutcome(result);
    const landed: TermInfo | null = result.ok ? result.term : result.loaded;
    if (landed) landMove(tab.id, tab.repoId, toRepoId, landed);
    if (result.ok) close();
  };

  const undo = async () => {
    await api.moveUndo(tab.id).catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
    close();
  };
  const retryClean = async () => {
    await api.moveFinish(tab.id).then(close, (err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  };

  const running = step !== null && outcome === null;
  const failed = outcome && !outcome.ok ? outcome : null;
  return (
    <div className="sheet-back" onPointerDown={(e) => !running && e.target === e.currentTarget && close()}>
      <div className="sheet move-sheet" role="dialog" aria-modal="true" aria-label={`Move to ${to}`}>
        <header className="sheet-head">
          <div>
            <div className="eyebrow">{from} → {to}</div>
            <h2 className="sheet-title">move this session</h2>
          </div>
          <button type="button" className="mini close" onClick={close} disabled={running} aria-label="Close">✕</button>
        </header>
        <div className="sheet-body">
          {error && <p className="move-error">{error}</p>}
          {!plan && !error && <p className="sheet-empty">reading the session…</p>}
          {plan && (
            <>
              <p className="move-prompt">“{plan.prompt ?? "no prompt yet"}” <span className="move-meta">· {plan.harness} · last active {ago(plan.at)}</span></p>
              <p className="move-meta">to {check?.path ?? "…"} on {to}, branch {plan.branch}</p>
              <p className="move-meta">
                {plan.changed === 0 ? "no uncommitted changes" : `${plan.changed} uncommitted ${plan.changed === 1 ? "file" : "files"}`}
                {plan.changed > 0 && (
                  <button type="button" className="mini" onClick={() => setShowFiles((v) => !v)}>{showFiles ? "hide" : "show"}</button>
                )}
              </p>
              {showFiles && <ul className="move-files">{plan.files.map((f) => <li key={f}>{f}</li>)}</ul>}
              {plan.ignored > 0 && <p className="move-meta">{plan.ignored} gitignored {plan.ignored === 1 ? "entry stays" : "entries stay"} here (.env and the like)</p>}
              {check && !check.ok && <p className="move-error">{check.reason}</p>}
              {check?.existing && <p className="move-meta">{to} has an earlier copy of this conversation; it is replaced only if this one continues it</p>}
            </>
          )}
          {step && (
            <ol className="move-steps">
              {MOVE_STEPS.map((s) => {
                const at = MOVE_STEPS.indexOf(step);
                const i = MOVE_STEPS.indexOf(s);
                const state = failed?.step === s ? "failed" : i < at || outcome?.ok ? "done" : i === at ? "now" : "todo";
                return <li key={s} className={`move-step ${state}`}>{STEP_TEXT[s]}</li>;
              })}
            </ol>
          )}
          {failed && <p className="move-error">{failed.error}</p>}
        </div>
        <footer className="sheet-foot">
          <span className="spacer" />
          {failed && failed.stopped && !failed.loaded && <button type="button" className="mini" onClick={() => void undo()}>resume here</button>}
          {failed?.step === "clean" && <button type="button" className="mini" onClick={() => void retryClean()}>clean source</button>}
          {!step && <button type="button" className="mini primary" disabled={!check?.ok} onClick={() => void go()}>move</button>}
        </footer>
      </div>
    </div>
  );
}
```

The new tab's id is `qual(to, termId())`: `qual` leaves a home-backend id bare, as every other tab id is. Check the class names an existing primary button uses (grep `className="mini primary"` or the RunSheet's go button).

- [ ] **Step 3: Add the styles** to `ui/src/styles.css`, after the `.sheet-foot` rules, using the existing tokens (look up the names used by `.sheet-empty` and the error text in `RunSheet` and use those):

```css
.move-sheet .move-prompt { margin: 0 0 6px; }
.move-sheet .move-meta { color: var(--muted); font-size: 0.85em; margin: 2px 0; }
.move-sheet .move-files { max-height: 160px; overflow: auto; margin: 4px 0; padding-left: 18px; font-family: var(--mono); font-size: 0.8em; }
.move-sheet .move-error { color: var(--rust); margin: 6px 0; }
.move-steps { list-style: none; padding: 0; margin: 10px 0 0; }
.move-step { padding: 2px 0 2px 20px; position: relative; color: var(--muted); }
.move-step::before { content: "○"; position: absolute; left: 0; }
.move-step.now { color: inherit; }
.move-step.now::before { content: "◌"; }
.move-step.done::before { content: "✓"; color: var(--moss); }
.move-step.failed { color: var(--rust); }
.move-step.failed::before { content: "✕"; }
.move-pick { display: inline-flex; gap: 4px; }
```

Replace `--muted`, `--mono`, `--rust`, `--moss` with the real token names from the top of `styles.css` if they differ.

- [ ] **Step 4: Gates**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all four pass.

- [ ] **Step 5: Look at it in a real browser.** Start a scratch canopy server (memory note "Scratch canopy server for UI checks": `env -u TMUX`, a short `CANOPY_CONFIG_DIR`, previews off), open a shell with an agent on a repo that has a checkout on a second backend, and check: the button shows, the sheet reads the session and the check, a failed check disables "move", and at phone width (390 px) the sheet fits with no sideways scroll. Use playwright-cli for screenshots, not Chrome MCP coordinates.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/MoveSheet.tsx ui/src/components/AgentButtons.tsx ui/src/styles.css
git commit -m "feat(move): the move button and its sheet on a shell's tab row

Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7"
```

---

### Task 8: Docs, the live check, and the spec's outcome

**Files:**
- Modify: `docs/architecture.md` (new section "Moving a session", and a line under "Feature areas" in `CLAUDE.md` only if that list names every area; it lists sections, so add "moving a session" there), `docs/superpowers/specs/2026-10-10-session-move-design.md` (an "As built" section)

- [ ] **Step 1: Write the architecture section.** One paragraph per piece, the way the other sections read: the five calls and which backend answers each; `rewriteTranscript` moving only `cwd` fields, byte for byte otherwise; `placeTranscript`'s prefix rule; `endAgent`'s Escape then quit then Enter; `resetTree` keeping `refs/canopy-moved/<session>` and refusing drift; `state.moving` and `move/undo`; the body cap; the order inside `movein` (work first, transcript second, so a retry finds `treeIs` true and skips the take).

- [ ] **Step 2: Gates again**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

- [ ] **Step 3: Deploy to the mini and run the live check.** Redeploy with `bun run redeploy` only after Eric says to (pushing `main` and redeploying are his call). Then, in a real browser on canopy.beric.ca:
  1. In a scratch repo checked out on both machines, start Claude in a Mac shell, tell it a codeword, and leave one modified and one new file.
  2. Move to mini. Check that the mini's tab opens, that asking for the codeword gets it back, that both files are on the mini uncommitted, that the Mac's tree is clean, and that `git rev-parse refs/canopy-moved/<session>` works on the Mac.
  3. Move it back to mac and repeat the checks the other way. The second move replaces the Mac's earlier copy of the transcript under the prefix rule.
  4. Confirm the bind-mount question from the spec: `ls -ln` on the moved file on the mini host shows the owner `claude` in the shells container can read.

- [ ] **Step 4: Write "As built"** in the spec: what changed from the design (the `/api/repos/movecheck`/`movein` names, `move/undo` typing the resume line into the same shell instead of a new one, Codex quitting with `/quit`), and what the live check showed.

- [ ] **Step 5: Commit**

```bash
git add docs/architecture.md CLAUDE.md docs/superpowers/specs/2026-10-10-session-move-design.md
git commit -m "docs(move): moving a session, as built and verified live

Claude-Session: https://claude.ai/code/session_017bAKbn15p5hTdRozjwC7P7"
```
