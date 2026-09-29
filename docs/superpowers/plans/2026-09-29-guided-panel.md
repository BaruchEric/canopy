# Guided panel implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** An intermediate (vibe-coding) level for the repo panel, the default for a new browser, with a three-step tour, a Claude shell that opens on its own, and agent buttons on the shell tab row.

**Architecture:** A per-browser `level` setting picks between today's panel body and a new `GuidedPanel` inside `RepoPanel`; `PanelShells` stays the footer in both, so the pty never remounts. The server learns to type the `claude` line into a brand-new shell (`start=claude` on the term socket) and to say what a shell is running (`GET /api/terms/agent`). The browser auto-opens a panel shell through a store subscription modelled on `panelsStarted`, and the tab buttons type prompts into a Claude shell through xterm's own paste.

**Tech Stack:** Bun + TypeScript strict, React 19, Zustand, xterm.js 6, tmux. Tests with `bun test`.

**Spec:** `docs/superpowers/specs/2026-09-29-guided-panel-design.md`

## Spec amendments

Found while planning, each smaller than what the spec said:

1. `levelOf` lives in `ui/src/settings.ts` beside the other field repairs, not in `guided.ts`.
2. No `TermInfo.agent` on every list. Reading each pane's command costs a tmux call per shell per list, and lists happen on every event. Instead `GET /api/terms/agent?term=` answers on demand, only when a button needs it: `agentIn` over `paneInfo` on tmux, and on a plain pty whether canopy started it with `start=claude`.
3. The auto-open skips dockless windows (solo, shell and section windows), which hold the grove's panels rather than their own, the same rule `panelsStarted` follows.
4. At intermediate the shell fills the panel and has no height grip, since there is nothing below it to trade height with.

## Global constraints

- Gates before calling anything done: `bun run typecheck && bun run lint && bun test && bun run build`.
- `src/core/types.ts` stays browser-safe (no Bun or node imports).
- A zustand selector that builds a new array or object goes through `useShallow`.
- CSS lives in `ui/src/styles.css`, tokens only (bark/moss/lichen/rust/sky), no framework.
- UI copy is plain words, sentence case, no em dashes.
- Commit messages have no backticks and end with `Claude-Session: https://claude.ai/code/session_01Q1qJr2ikCo8JqUYGX1WxnW`.
- Work on a branch `feat/guided-panel`; never push `main`.

## Review focus

1. A reload with a panel open must adopt the Claude shell the server holds, never start a second one (auto-open runs only once the repo, and with it the backend's shell list, is in the store). Test: `needsPanelShell` with a held shell and no tab.
2. A panel whose only shell the user hid (`hiddenTerms`) must not get a new one on every open. Test: `needsPanelShell` counts a held panel shell that has no tab.
3. A browser that already had settings must stay on advanced after upgrade. Test: `levelOf` on a saved object with no `level`.
4. A join (`attach=1`, or a second socket on a held shell) with `start=claude` must not type the line again. Test in `server/start.test.ts`.
5. The bug and save buttons on a shell that is not running Claude must not type a prompt into bash. Test: `/api/terms/agent` answers `null` for a plain shell; the button path picks another shell or opens one.

---

### Task 1: The level and onboarded settings

**Files:**
- Modify: `ui/src/settings.ts` (the `Settings` interface near line 100, `DEFAULT_SETTINGS` near line 128, `loadSettings` near line 225)
- Test: `ui/src/settings.test.ts`

**Interfaces:**
- Produces: `type Level = "intermediate" | "advanced"`, `LEVELS: readonly Level[]`, `Settings.level: Level`, `Settings.onboarded: boolean`, `levelOf(saved: Partial<Record<string, unknown>>): { level: Level; onboarded: boolean }`.

- [ ] **Step 1: Write the failing tests** (append to `ui/src/settings.test.ts`, and add `levelOf` to its import)

```ts
describe("levelOf", () => {
  test("a browser with saved settings from before levels stays on advanced, tour done", () => {
    expect(levelOf({ sort: "recent" })).toEqual({ level: "advanced", onboarded: true });
  });
  test("a saved level and tour flag are kept", () => {
    expect(levelOf({ level: "intermediate", onboarded: false })).toEqual({ level: "intermediate", onboarded: false });
  });
  test("a bad level falls back to advanced, a bad flag to done", () => {
    expect(levelOf({ level: "expert", onboarded: "yes" })).toEqual({ level: "advanced", onboarded: true });
  });
});

describe("a fresh browser", () => {
  test("starts on intermediate with the tour to come", () => {
    (globalThis as { localStorage?: unknown }).localStorage = {
      getItem: () => null,
      setItem: () => {},
    };
    const s = loadSettings();
    expect(s.level).toBe("intermediate");
    expect(s.onboarded).toBe(false);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test ui/src/settings.test.ts`
Expected: FAIL, `levelOf` is not exported.

- [ ] **Step 3: Implement**

In `ui/src/settings.ts`, beside the other exported constants:

```ts
export const LEVELS = ["intermediate", "advanced"] as const;
export type Level = (typeof LEVELS)[number];

/** A browser's level and tour flag off what it saved. Saved settings with
 *  no level are from before levels existed: that browser keeps the panel it
 *  had, advanced, and is not shown the tour. */
export function levelOf(saved: Partial<Record<string, unknown>>): { level: Level; onboarded: boolean } {
  const known = typeof saved["level"] === "string";
  return {
    level: pick(LEVELS, saved["level"], "advanced"),
    onboarded: known && typeof saved["onboarded"] === "boolean" ? saved["onboarded"] : true,
  };
}
```

Add to the `Settings` interface:

```ts
  /** how much the repo panel shows: intermediate is the guided, Claude-first
   *  panel, advanced is every section */
  level: Level;
  /** the guided panel's tour has been seen or skipped */
  onboarded: boolean;
```

Add to `DEFAULT_SETTINGS`: `level: "intermediate", onboarded: false,`.

In `loadSettings`, after `hiddenBackends: ...` in the returned object: `...levelOf(saved),`. The `if (!raw) return DEFAULT_SETTINGS;` line already gives a fresh browser intermediate.

- [ ] **Step 4: Run the tests**

Run: `bun test ui/src/settings.test.ts`
Expected: PASS.

- [ ] **Step 5: Typecheck and commit**

Run: `bun run typecheck`
Expected: no errors (any object literal typed `Settings` elsewhere now needs the two fields; fix each by adding them).

```bash
git checkout -b feat/guided-panel
git add ui/src/settings.ts ui/src/settings.test.ts
git commit -m "feat(ui): level and onboarded settings, existing browsers stay advanced"
```

---

### Task 2: The guided panel's words and logic

**Files:**
- Create: `ui/src/guided.ts`
- Test: `ui/src/guided.test.ts`

**Interfaces:**
- Consumes: `Repo`, `TaskInfo` from `../../src/core/types`; `TermTab` from `./term`.
- Produces:
  - `type DevState = "none" | "stopped" | "running" | "failed"`
  - `devState(dev: TaskInfo | undefined): DevState`
  - `plainStatus(repo: Repo, dev: DevState): string`
  - `canSave(repo: Repo): boolean`
  - `SAVE_PROMPT: string`, `SETUP_PROMPT: string`, `debugPrompt(lines: readonly string[]): string`
  - `claudeCandidates(showing: TermTab | null, tabs: readonly TermTab[], repoId: string): string[]`
  - `type TourStep = 0 | 1 | 2 | "done"`, `tourStep(step: TourStep, action: "next" | "skip"): TourStep`, `TOUR_TEXT: readonly string[]`

- [ ] **Step 1: Write the failing tests** in `ui/src/guided.test.ts`

```ts
import { describe, expect, test } from "bun:test";
import type { Repo, RepoStatus, TaskInfo } from "../../src/core/types";
import type { TermTab } from "./term";
import { canSave, claudeCandidates, debugPrompt, devState, plainStatus, tourStep } from "./guided";

const status = (over: Partial<RepoStatus> = {}): RepoStatus => ({
  branch: "main",
  upstream: "origin/main",
  ahead: 0,
  behind: 0,
  files: [],
  lastCommit: null,
  user: null,
  ...over,
});
const repo = (over: Partial<Repo> = {}): Repo => ({ id: "app", name: "app", path: "/r/app", status: status(), ...over }) as Repo;
const file = { path: "a.ts", x: ".", y: "M" } as unknown as RepoStatus["files"][number];
const task = (s: TaskInfo["status"]): TaskInfo => ({ name: "dev", status: s, dev: true }) as TaskInfo;
const tab = (id: string, repoId: string, place: "panel" | "strip", task?: string): TermTab => ({
  id,
  repoId,
  name: repoId,
  path: `/r/${repoId}`,
  place,
  ...(task ? { task } : {}),
});

describe("devState", () => {
  test("no task, running, restarting, failed, stopped", () => {
    expect(devState(undefined)).toBe("none");
    expect(devState(task("running"))).toBe("running");
    expect(devState(task("backoff"))).toBe("running");
    expect(devState(task("failed"))).toBe("failed");
    expect(devState(task("gave-up"))).toBe("failed");
    expect(devState(task("idle"))).toBe("stopped");
    expect(devState(task("stopped"))).toBe("stopped");
    expect(devState(task("exited"))).toBe("stopped");
  });
});

describe("plainStatus", () => {
  test("changed files, counted", () => {
    expect(plainStatus(repo({ status: status({ files: [file, file, file] }) }), "none")).toBe("3 files changed, not saved yet");
    expect(plainStatus(repo({ status: status({ files: [file] }) }), "none")).toBe("1 file changed, not saved yet");
  });
  test("saved but not pushed, saved and pushed, no upstream", () => {
    expect(plainStatus(repo({ status: status({ ahead: 2 }) }), "none")).toBe("saved, not backed up yet");
    expect(plainStatus(repo(), "none")).toBe("all saved and backed up");
    expect(plainStatus(repo({ status: status({ upstream: null }) }), "none")).toBe("saved on this computer only");
  });
  test("a scan error, and the app's state after", () => {
    expect(plainStatus(repo({ status: null, error: "boom" }), "none")).toBe("can't read this project");
    expect(plainStatus(repo(), "running")).toBe("all saved and backed up · app running");
    expect(plainStatus(repo(), "failed")).toBe("all saved and backed up · app stopped with an error");
  });
});

describe("canSave", () => {
  test("dirty, ahead, or never pushed can save; clean and level cannot", () => {
    expect(canSave(repo({ status: status({ files: [file] }) }))).toBe(true);
    expect(canSave(repo({ status: status({ ahead: 1 }) }))).toBe(true);
    expect(canSave(repo())).toBe(false);
    expect(canSave(repo({ status: null }))).toBe(false);
  });
});

describe("debugPrompt", () => {
  test("keeps the last 40 lines under the ask", () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i}`);
    const p = debugPrompt(lines);
    expect(p.startsWith("My app shows this error. Find the cause and fix it.")).toBe(true);
    expect(p).toContain("line 49");
    expect(p).toContain("line 10");
    expect(p).not.toContain("line 9\n");
  });
  test("no lines, no block", () => {
    expect(debugPrompt([])).toBe("My app shows this error. Find the cause and fix it.");
  });
});

describe("claudeCandidates", () => {
  test("the showing shell first, then the repo's panel shells newest first, then its strip shells", () => {
    const tabs = [tab("p1", "app", "panel"), tab("s1", "app", "strip"), tab("p2", "app", "panel"), tab("x", "other", "panel")];
    expect(claudeCandidates(tabs[1] ?? null, tabs, "app")).toEqual(["s1", "p2", "p1"]);
    expect(claudeCandidates(null, tabs, "app")).toEqual(["p2", "p1", "s1"]);
  });
  test("a task's tab and another repo's showing tab are never candidates", () => {
    const tabs = [tab("t", "app", "panel", "dev"), tab("x", "other", "strip")];
    expect(claudeCandidates(tabs[1] ?? null, tabs, "app")).toEqual([]);
  });
});

describe("tourStep", () => {
  test("next walks the three steps, skip ends at once", () => {
    expect(tourStep(0, "next")).toBe(1);
    expect(tourStep(1, "next")).toBe(2);
    expect(tourStep(2, "next")).toBe("done");
    expect(tourStep(1, "skip")).toBe("done");
    expect(tourStep("done", "next")).toBe("done");
  });
});
```

- [ ] **Step 2: Run them to see them fail**

Run: `bun test ui/src/guided.test.ts`
Expected: FAIL, cannot find module `./guided`.

- [ ] **Step 3: Implement** `ui/src/guided.ts`

```ts
/* The guided (intermediate) panel's words and decisions, pure so they are
   tested: what the repo's state is in plain words, what the dev task is
   doing, the prompts the buttons type into Claude, which shell they type
   into, and the tour's steps. */
import type { Repo, TaskInfo } from "../../src/core/types";
import type { TermTab } from "./term";

export type DevState = "none" | "stopped" | "running" | "failed";

/** A dev task's state as the buttons read it: a restart after a crash is
 *  still running, a crash or a give-up is failed. */
export function devState(dev: TaskInfo | undefined): DevState {
  if (!dev) return "none";
  if (dev.status === "running" || dev.status === "backoff") return "running";
  if (dev.status === "failed" || dev.status === "gave-up") return "failed";
  return "stopped";
}

const plural = (n: number, one: string) => `${n} ${one}${n === 1 ? "" : "s"}`;

/** the repo's state in words a non-programmer reads */
export function plainStatus(repo: Repo, dev: DevState): string {
  const st = repo.status;
  if (repo.error || !st) return "can't read this project";
  const base =
    st.files.length > 0
      ? `${plural(st.files.length, "file")} changed, not saved yet`
      : !st.upstream
        ? "saved on this computer only"
        : st.ahead > 0
          ? "saved, not backed up yet"
          : "all saved and backed up";
  if (dev === "running") return `${base} · app running`;
  if (dev === "failed") return `${base} · app stopped with an error`;
  return base;
}

/** something to commit or push: a dirty tree, commits ahead, or a branch
 *  that was never pushed */
export function canSave(repo: Repo): boolean {
  const st = repo.status;
  if (!st) return false;
  return st.files.length > 0 || st.ahead > 0 || (!st.upstream && st.lastCommit !== null);
}

export const SAVE_PROMPT = "Save my work: commit everything with a clear message, then push.";
export const SETUP_PROMPT = "Set up a way to run this app locally and tell me how to open it.";
const DEBUG_ASK = "My app shows this error. Find the cause and fix it.";
const DEBUG_LINES = 40;

export function debugPrompt(lines: readonly string[]): string {
  const tail = lines.slice(-DEBUG_LINES);
  return tail.length ? `${DEBUG_ASK}\n\n${tail.join("\n")}` : DEBUG_ASK;
}

/** The shells a prompt may go to, best first: the showing one when it is a
 *  shell of this repo, then the repo's panel shells newest first, then its
 *  strip shells. A task's tab is never one. */
export function claudeCandidates(showing: TermTab | null, tabs: readonly TermTab[], repoId: string): string[] {
  const mine = tabs.filter((t) => t.repoId === repoId && t.task === undefined && t.exit === undefined);
  const out: string[] = [];
  if (showing && mine.some((t) => t.id === showing.id)) out.push(showing.id);
  for (const t of [...mine].reverse()) if (t.place === "panel" && !out.includes(t.id)) out.push(t.id);
  for (const t of [...mine].reverse()) if (t.place === "strip" && !out.includes(t.id)) out.push(t.id);
  return out;
}

export type TourStep = 0 | 1 | 2 | "done";

export const TOUR_TEXT = [
  "Tell Claude what you want to build, in your own words.",
  "See your app running here.",
  "Keep your changes. Claude saves and backs them up.",
] as const;

export function tourStep(step: TourStep, action: "next" | "skip"): TourStep {
  if (step === "done" || action === "skip") return "done";
  return step === 2 ? "done" : ((step + 1) as 1 | 2);
}
```

Check the strip-order test against this: `claudeCandidates(null, tabs, "app")` with `p1, s1, p2` gives panel newest first `p2, p1`, then strip `s1`. The first test with `s1` showing gives `s1, p2, p1`. Both match.

- [ ] **Step 4: Run the tests**

Run: `bun test ui/src/guided.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/guided.ts ui/src/guided.test.ts
git commit -m "feat(ui): guided panel words, prompts, shell choice and tour steps"
```

---

### Task 3: The server types the claude line into a new shell, and says what a shell runs

**Files:**
- Modify: `src/server/index.ts`: `LiveTerm` (line ~236), `TermSocket` (~245), `openPtyTerm` (~633), `joinTmuxTerm` (~672), the `/api/term` upgrade (~2580), the terms routes (~1790), `startServer` options (~2356) and `ServerState` (~138).
- Create: `src/server/start.test.ts`

**Interfaces:**
- Consumes: `claudeLine` from `../core/openers`, `agentFor` (already imported), `paneInfo`, `sendLine` (already imported from `../core/tmux`), `agentIn` from `../core/keep`, `AgentKind` from `../core/types`.
- Produces: the socket query `start=claude`; `GET /api/terms/agent?term=<32 hex>` answering `{ agent: "claude" | "codex" | null }`, 404 for a shell not held, 400 for a task; `startServer({ agentLine?: (repo: Repo) => Promise<string> })`.

- [ ] **Step 1: Write the failing test** `src/server/start.test.ts`

```ts
/**
 * A new shell asked for with start=claude gets the agent's line typed in
 * once; a join does not type it again; the agent route says what a shell
 * is running. The line is a stand-in so no real claude starts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { copyFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { killServer, tmuxBase } from "../core/tmux";
import { startServer } from "./index";

let scratch: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
let fake: string;
/** how many times the server asked for the agent's line */
let typed = 0;
const dec = new TextDecoder();

function connect(query: Record<string, string>) {
  const q = new URLSearchParams({ id: "app", cols: "80", rows: "24", ...query });
  const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?${q}`);
  ws.binaryType = "arraybuffer";
  const out: string[] = [];
  ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
    if (typeof e.data !== "string") out.push(dec.decode(new Uint8Array(e.data)));
  };
  const opened = new Promise<void>((resolve, reject) => {
    ws.onopen = () => resolve();
    ws.onerror = () => reject(new Error("the socket failed"));
  });
  const closed = new Promise<void>((resolve) => {
    ws.onclose = () => resolve();
  });
  return { ws, text: () => out.join(""), opened, closed };
}

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(100);
  }
}

const agentOf = async (term: string) => {
  const res = await fetch(`http://127.0.0.1:${server.port}/api/terms/agent?term=${term}`);
  return { status: res.status, body: (await res.json()) as { agent?: string | null } };
};

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-start-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  // a copy of sleep whose process name starts with claude, which is what
  // agentIn reads off the pane
  fake = join(scratch, "claude-fake");
  await copyFile(Bun.which("sleep") ?? "/bin/sleep", fake);
  await Bun.$`chmod +x ${fake}`.quiet();
  server = await startServer({
    root,
    port: 0,
    agentLine: async () => {
      typed++;
      return `printf 'agent-%s\\n' up; ${fake} 60`;
    },
  });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

const A = "a0000000000000000000000000000001";
const B = "b0000000000000000000000000000002";

describe("start=claude", () => {
  test("types the agent line into a new shell once, and a join does not type it again", async () => {
    const first = connect({ term: A, place: "panel", start: "claude" });
    await first.opened;
    await until(() => first.text().includes("agent-up"), "the typed line's output");
    first.ws.close();
    await first.closed;
    const second = connect({ term: A, place: "panel", start: "claude" });
    await second.opened;
    await Bun.sleep(1200);
    expect(typed).toBe(1);
    second.ws.close();
    await second.closed;
  });

  test("the agent route sees claude running, and a plain shell as nothing", async () => {
    await until(async () => (await agentOf(A)).body.agent === "claude", "the agent to show as claude");
    const plain = connect({ term: B, place: "panel" });
    await plain.opened;
    await Bun.sleep(800);
    expect((await agentOf(B)).body.agent).toBeNull();
    plain.ws.close();
    await plain.closed;
  });

  test("the agent route refuses a shell it does not hold", async () => {
    expect((await agentOf("c0000000000000000000000000000003")).status).toBe(404);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test src/server/start.test.ts`
Expected: FAIL. `agentLine` is not a known option (typecheck) or `agent-up` never shows, and the route answers 404 for A.

- [ ] **Step 3: Implement**

a. Types. In `LiveTerm` add:

```ts
  /** canopy typed the agent's line into it at the start (start=claude);
   *  what a plain pty, with no tmux to ask, says it is running */
  agent?: "claude";
```

In `TermSocket` add:

```ts
  /** type the agent's line in once, if this socket starts the shell */
  start: "claude" | null;
```

In `ServerState` add `agentLine: (repo: Repo) => Promise<string>;`, and in `startServer`'s options:

```ts
  /** the line start=claude types into a new shell; tests swap in a stand-in */
  agentLine?: (repo: Repo) => Promise<string>;
```

In the `state` literal: `agentLine: opts.agentLine ?? (async (repo) => claudeLine(agentFor(await loadConfig(), repo.path))),` and add `claudeLine` to the `../core/openers` import.

b. The upgrade. In the `/api/term` branch, after `const attach = ...`:

```ts
      const start = url.searchParams.get("start") === "claude" && !attach ? "claude" : null;
```

and put `start` into `data`: `{ kind: "term", repo, id, place, attach, start, device, ...size }`. The `resumeTerm` call to `openPtyTerm` builds a `TermSocket` by hand: add `start: null` there.

c. Typing. Add beside `resumeTerm`:

```ts
/** the agent's line into a shell this socket just started, after the same
 *  beat resume waits for the shell to read input */
async function typeAgent(state: ServerState, live: LiveTerm, repo: Repo): Promise<void> {
  const line = await state.agentLine(repo);
  await Bun.sleep(400);
  live.agent = "claude";
  if (state.tmux) await sendLine(state.tmux, live.info.id, line);
  else live.pty?.session.write(`${line}\r`);
}
```

In `joinTmuxTerm`, inside `if (!live) { ... }` after `tellTerms(state);`:

```ts
    if (ws.data.start === "claude") void typeAgent(state, live, repo).catch(() => {});
```

In the `open` handler's pty branch, after `const live = openPtyTerm(state, term.data, { cols, rows });`:

```ts
            if (term.data.start === "claude") void typeAgent(state, live, term.data.repo).catch(() => {});
```

Neither the held-pty branch nor a held tmux session reaches these lines, which is what keeps a join from typing again.

d. The route, just above the `DELETE /api/terms` route:

```ts
  if (path === "/api/terms/agent" && method === "GET") {
    const term = url.searchParams.get("term") ?? "";
    const live = state.terms.get(term);
    if (live?.info.task || state.tasks.knows(term)) return json({ error: "that is a task, not a shell" }, 400);
    if (!live || live.ending) return json({ error: "no such shell" }, 404);
    if (!state.tmux) return json({ agent: live.agent ?? null });
    const pane = await paneInfo(state.tmux, term);
    return json({ agent: pane ? agentIn(pane.command, pane.title) : null });
  }
```

Add `paneInfo` is already imported; add `agentIn` to the `../core/keep` import (check the existing import line and extend it).

- [ ] **Step 4: Run the tests**

Run: `bun test src/server/start.test.ts src/server/term.test.ts src/server/resume.test.ts`
Expected: PASS, the existing shell tests unchanged.

- [ ] **Step 5: Commit**

```bash
git add src/server/index.ts src/server/start.test.ts
git commit -m "feat(server): start=claude types the agent line into a new shell, and a route says what a shell runs"
```

---

### Task 4: The browser opens a panel shell on its own

**Files:**
- Modify: `ui/src/term.ts` (the `TermTab` interface, near line 9)
- Modify: `ui/src/components/TermDock.tsx` (`socketUrl`, near line 128)
- Modify: `ui/src/store.ts` (`openTerm` type at ~720 and body at ~1865; a new subscription after the `panelsStarted` one at ~2383)
- Modify: `ui/src/api.ts` (beside `endShells`/the terms calls near line 350)
- Test: `ui/src/term.test.ts`

**Interfaces:**
- Consumes: `Settings.level` (Task 1); `start=claude` (Task 3).
- Produces: `TermTab.start?: "claude"`; `openTerm(repoId: string, place?: ShellPlace, start?: "claude"): void`; `needsPanelShell(tabs: readonly TermTab[], held: readonly TermInfo[], repoId: string): boolean`; `api.termAgent(id: string): Promise<{ agent: AgentKind | null }>`.

- [ ] **Step 1: Write the failing test** (append to `ui/src/term.test.ts`, add `needsPanelShell` to its import, and `TermInfo` from `../../src/core/types` if not imported)

```ts
describe("needsPanelShell", () => {
  const tab = (id: string, repoId: string, place: "panel" | "strip", task?: string) =>
    ({ id, repoId, name: repoId, path: `/r/${repoId}`, place, ...(task ? { task } : {}) }) as TermTab;
  const held = (id: string, repoId: string, place: "panel" | "strip") =>
    ({ id, repoId, path: `/r/${repoId}`, place, attached: false, viewers: [], startedAt: 0 }) as TermInfo;

  test("a panel with no shell of its own needs one", () => {
    expect(needsPanelShell([], [], "app")).toBe(true);
    expect(needsPanelShell([tab("s", "app", "strip")], [held("s", "app", "strip")], "app")).toBe(true);
  });
  test("a panel tab, or a held panel shell with no tab here (hidden, or not adopted yet), is enough", () => {
    expect(needsPanelShell([tab("p", "app", "panel")], [], "app")).toBe(false);
    expect(needsPanelShell([], [held("p", "app", "panel")], "app")).toBe(false);
  });
  test("a task's tab does not count, and another repo's shell does not either", () => {
    expect(needsPanelShell([tab("t", "app", "panel", "dev")], [], "app")).toBe(true);
    expect(needsPanelShell([tab("p", "other", "panel")], [held("q", "other", "panel")], "app")).toBe(true);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

Run: `bun test ui/src/term.test.ts`
Expected: FAIL, `needsPanelShell` is not exported.

- [ ] **Step 3: Implement**

In `ui/src/term.ts`, add to `TermTab`:

```ts
  /** what the socket that starts this shell asks the backend to type in;
   *  never saved, since a shell that already exists ignores it */
  start?: "claude";
```

and export:

```ts
/** Whether a repo's panel has no shell of its own yet: no panel tab here and
 *  no panel shell held on the backend. A held one with no tab (hidden here,
 *  or waiting to be adopted) counts, so opening the panel never adds a
 *  second shell beside one the user put away. */
export function needsPanelShell(tabs: readonly TermTab[], held: readonly TermInfo[], repoId: string): boolean {
  if (tabs.some((t) => t.repoId === repoId && t.place === "panel" && t.task === undefined)) return false;
  return !held.some((t) => t.repoId === repoId && t.place === "panel" && t.task === undefined);
}
```

(`TermInfo` is imported in `term.ts` already for `reconcileTerms`; if not, import it as a type from `../../src/core/types`.)

In `TermDock.tsx`'s `socketUrl`, after the `attach` line:

```ts
  else if (tab.start) q.set("start", tab.start);
```

(so the `if (joinsOnly(...)) q.set("attach", "1");` line becomes the `if` of this `else`).

In `ui/src/api.ts`, next to the `endShells`/terms calls:

```ts
  termAgent: (id: string) =>
    repoReq<{ agent: AgentKind | null }>(id, (p) => `/api/terms/agent?term=${encodeURIComponent(p)}`),
```

and import `AgentKind` as a type from `../../src/core/types`.

In `ui/src/store.ts`, change the `openTerm` type to `openTerm: (repoId: string, place?: ShellPlace, start?: "claude") => void;` and in the body build the tab as:

```ts
    const tab: TermTab = {
      id: qual(backendOf(repoId), termId()),
      repoId,
      name: repo.name,
      path: repo.path,
      place: where,
      ...(start ? { start } : {}),
    };
```

After the `panelsStarted` subscription, add:

```ts
/** The panels that have had their shell opened on their own since they
 *  last opened: closing a panel forgets it, so the next open looks again,
 *  and closing the shell's tab leaves the open panel without one. */
const panelsShelled = new Set<string>();

useStore.subscribe((s, prev) => {
  if (s.panels === prev.panels && s.repos === prev.repos && s.shells === prev.shells) return;
  if (dockless()) return;
  for (const id of panelsShelled) if (!s.panels.includes(id)) panelsShelled.delete(id);
  for (const id of s.panels) {
    if (panelsShelled.has(id)) continue;
    // the repo lands in the same set as its backend's shell list, so a
    // known repo means held shells are already adopted or listed
    const repo = s.repos.find((r) => r.id === id);
    if (!repo || repo.forge || repo.host || repo.error) continue;
    if (!isOnline(s, backendOf(id))) continue;
    panelsShelled.add(id);
    if (!needsPanelShell(s.terms, s.shells, id)) continue;
    // Not through openTerm: that focuses the panel, and a reload that brings
    // back three panels would end on whichever was shelled last.
    const tab: TermTab = {
      id: qual(backendOf(id), termId()),
      repoId: id,
      name: repo.name,
      path: repo.path,
      place: "panel",
      ...(s.settings.level === "intermediate" ? { start: "claude" as const } : {}),
    };
    useStore.setState((t) => ({ terms: [...t.terms, tab], closedSections: unfoldIn(t.closedSections, id, "shell") }));
  }
});
```

Import `needsPanelShell` from `./term` (beside the other `./term` imports). `isOnline`, `backendOf`, `qual`, `termId` and `unfoldIn` are already in scope in `store.ts`, since `openTerm` uses them (check each; add any import that is missing).

- [ ] **Step 4: Run the tests and typecheck**

Run: `bun test ui/src/term.test.ts ui/src/store.test.ts && bun run typecheck`
Expected: PASS, no type errors.

- [ ] **Step 5: Commit**

```bash
git add ui/src/term.ts ui/src/term.test.ts ui/src/components/TermDock.tsx ui/src/store.ts ui/src/api.ts
git commit -m "feat(ui): a panel opens its own shell, running claude at the intermediate level"
```

---

### Task 5: Agent buttons on the shell tab row

**Files:**
- Create: `ui/src/liveTerms.ts`
- Create: `ui/src/components/AgentButtons.tsx`
- Modify: `ui/src/components/TermDock.tsx` (move `LIVE` out at line 54; `TermTabs` at ~872)
- Modify: `ui/src/styles.css` (after `.term-new` at ~3536)

**Interfaces:**
- Consumes: `devState`, `canSave`, `claudeCandidates`, `SAVE_PROMPT`, `SETUP_PROMPT`, `debugPrompt` (Task 2); `api.termAgent`, `openTerm(..., "claude")` (Task 4); the store's `taskAct(repoId, action, name)`, `loadTasks(repoId)`, `tasks`, `terms`; `devTask` from `ui/src/tasks.ts`; `api.taskLog(id, name)`.
- Produces: `LIVE: Map<string, Terminal>` and `typeInto(termId: string, text: string): boolean` in `ui/src/liveTerms.ts`; `askClaude(repoId: string, text: string, showing: TermTab | null): Promise<void>` and `<AgentButtons tab={TermTab} />` in `AgentButtons.tsx`.

- [ ] **Step 1: Move the live terminal map**

Create `ui/src/liveTerms.ts`:

```ts
/* The xterm behind every mounted shell view, by tab id: what copy, share
   and the agent buttons reach a live terminal through. */
import type { Terminal } from "@xterm/xterm";

export const LIVE = new Map<string, Terminal>();

/** Types text into a shell as one paste, then Enter, the way a person
 *  pasting a message into Claude Code would. False when no view of that
 *  shell is mounted here. */
export function typeInto(termId: string, text: string): boolean {
  const term = LIVE.get(termId);
  if (!term) return false;
  term.paste(text);
  term.input("\r");
  return true;
}
```

In `TermDock.tsx`, delete `const LIVE = new Map<string, Terminal>();` and add `import { LIVE } from "../liveTerms";`. Every other use of `LIVE` in the file stays as it is.

Run: `bun run typecheck`
Expected: no errors.

- [ ] **Step 2: Write `ui/src/components/AgentButtons.tsx`**

```tsx
import { useEffect } from "react";
import { useStore } from "../store";
import { api } from "../api";
import { devTask } from "../tasks";
import { canSave, claudeCandidates, debugPrompt, devState, SAVE_PROMPT, SETUP_PROMPT } from "../guided";
import { LIVE, typeInto } from "../liveTerms";
import type { TermTab } from "../term";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Types a prompt into a shell of this repo that is running Claude: the
 *  showing one, else the repo's others, else a new panel shell started with
 *  claude, typed into once the backend says claude is up. */
export async function askClaude(repoId: string, text: string, showing: TermTab | null): Promise<void> {
  const { terms, openTerm } = useStore.getState();
  for (const id of claudeCandidates(showing, terms, repoId)) {
    const { agent } = await api.termAgent(id).catch(() => ({ agent: null }));
    if (agent === "claude" && typeInto(id, text)) return;
  }
  const before = new Set(useStore.getState().terms.map((t) => t.id));
  openTerm(repoId, "panel", "claude");
  const fresh = useStore.getState().terms.find((t) => !before.has(t.id));
  if (!fresh) return;
  for (let waited = 0; waited < 20_000; waited += 500) {
    await sleep(500);
    if (!LIVE.has(fresh.id)) continue;
    const { agent } = await api.termAgent(fresh.id).catch(() => ({ agent: null }));
    if (agent !== "claude") continue;
    // claude names its pane before its prompt reads input
    await sleep(1500);
    typeInto(fresh.id, text);
    return;
  }
}

/** ▶ ■ bug ✓ on a shell's tab row, for the repo of the tab showing. */
export function AgentButtons({ tab }: { tab: TermTab }) {
  const repo = useStore((s) => s.repos.find((r) => r.id === tab.repoId));
  const tasks = useStore((s) => s.tasks[tab.repoId]);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  useEffect(() => {
    if (tasks === undefined && repo && !repo.forge && !repo.host) loadTasks(tab.repoId).catch(() => {});
  }, [tasks, repo, tab.repoId, loadTasks]);
  if (!repo || repo.forge || repo.host) return null;
  const dev = devTask(tasks ?? []);
  const state = devState(dev);
  const debug = async () => {
    if (!dev) return;
    const page = await api.taskLog(tab.repoId, dev.name).catch(() => null);
    await askClaude(tab.repoId, debugPrompt(page?.lines.map((l) => l.text) ?? []), tab);
  };
  return (
    <span className="agent-buttons">
      {state === "none" ? (
        <button type="button" className="term-new" title="Ask Claude to set up a way to run this app" onClick={() => void askClaude(tab.repoId, SETUP_PROMPT, tab)}>
          set up run
        </button>
      ) : state === "running" ? (
        <button type="button" className="term-new" title={`Stop ${dev?.name ?? "the app"}`} aria-label="Stop the app" onClick={() => void taskAct(tab.repoId, "stop", dev?.name)}>
          ■
        </button>
      ) : (
        <button type="button" className="term-new" title={`Run ${dev?.name ?? "the app"}`} aria-label="Run the app" onClick={() => void taskAct(tab.repoId, "start", dev?.name)}>
          ▶
        </button>
      )}
      {(state === "running" || state === "failed") && (
        <button type="button" className="term-new" title="Ask Claude to fix the app's error, with its latest output" aria-label="Debug with Claude" onClick={() => void debug()}>
          🐞
        </button>
      )}
      {canSave(repo) && (
        <button type="button" className="term-new" title="Ask Claude to commit and push your work" aria-label="Save my work" onClick={() => void askClaude(tab.repoId, SAVE_PROMPT, tab)}>
          ✓
        </button>
      )}
    </span>
  );
}
```

Check `api.taskLog`'s answer type: it is `repoReq<TaskLogPage>`, so `page.lines` is `TaskLogLine[]` with `text`. The first page is the newest lines (`before` pages back); if the implementer finds it returns the oldest first, pass the page's last `n` back through `before` instead.

- [ ] **Step 3: Put them on the tab row**

In `TermTabs` (TermDock.tsx), before `{extra}`:

```tsx
      {(() => {
        const showing = terms.find((t) => t.id === active);
        return showing && showing.task === undefined && showing.exit === undefined ? <AgentButtons tab={showing} /> : null;
      })()}
```

and `import { AgentButtons } from "./AgentButtons";`.

In `ui/src/styles.css`, after the `.term-new` rules:

```css
/* the agent's buttons on a shell's tab row, set off from the tabs */
.agent-buttons {
  display: inline-flex;
  gap: 2px;
  margin-left: 6px;
  padding-left: 6px;
  border-left: 1px solid var(--hair);
}
```

- [ ] **Step 4: Gates and a look in the browser**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

Then drive the built app (the `run` skill, or playwright-cli against `http://127.0.0.1:7850` after reloading the launchd server by killing its PID): open canopy's own panel, check the row shows ▶ (canopy has a dev task), press it and see it turn to ■, press ✓ with a dirty tree and see the prompt typed into the Claude shell. Screenshot to the scratchpad.

- [ ] **Step 5: Commit**

```bash
git add ui/src/liveTerms.ts ui/src/components/AgentButtons.tsx ui/src/components/TermDock.tsx ui/src/styles.css
git commit -m "feat(ui): run, stop, debug and save buttons on a shell's tab row"
```

---

### Task 6: The guided panel

**Files:**
- Create: `ui/src/components/Guided.tsx`
- Modify: `ui/src/components/Dock.tsx` (`RepoPanel`, ~1153-1400; `PanelGear`, ~945)
- Modify: `ui/src/styles.css` (after the `.panel-shells-body` rules at ~3535)

**Interfaces:**
- Consumes: `plainStatus`, `devState`, `canSave`, `SAVE_PROMPT`, `SETUP_PROMPT` (Task 2); `askClaude` (Task 5); `Settings.level` (Task 1); `PreviewSection` from `./Preview`; `devTask`; store `tasks`, `loadTasks`, `taskAct`.
- Produces: `<GuidedPanel repo={Repo} onMore={() => void} targets={GuidedTargets} />` where `interface GuidedTargets { run: React.RefObject<HTMLButtonElement | null>; save: React.RefObject<HTMLButtonElement | null> }`.

- [ ] **Step 1: Write `ui/src/components/Guided.tsx`**

```tsx
import { useEffect, useState, type RefObject } from "react";
import type { Repo } from "../../../src/core/types";
import { closedIn, useStore } from "../store";
import { devTask } from "../tasks";
import { canSave, devState, plainStatus, SAVE_PROMPT, SETUP_PROMPT } from "../guided";
import { askClaude } from "./AgentButtons";
import { PreviewSection } from "./Preview";
import { isHome } from "../registry";

export interface GuidedTargets {
  run: RefObject<HTMLButtonElement | null>;
  save: RefObject<HTMLButtonElement | null>;
}

/** The intermediate panel's body: one status line in words, the app's run
 *  and stop, save, and the way to every section. The Claude shell under it
 *  is the panel's own footer, the same element the advanced body has. */
export function GuidedPanel({ repo, onMore, targets }: { repo: Repo; onMore: () => void; targets: GuidedTargets }) {
  const tasks = useStore((s) => s.tasks[repo.id]);
  const loadTasks = useStore((s) => s.loadTasks);
  const taskAct = useStore((s) => s.taskAct);
  useEffect(() => {
    if (!repo.forge && !repo.host) loadTasks(repo.id).catch(() => {});
  }, [repo.id, repo.forge, repo.host, loadTasks]);
  const dev = devTask(tasks ?? []);
  const state = devState(dev);
  // the preview opens the first time the app is seen running here; folding
  // it again afterwards is the user's call
  const previewClosed = useStore((s) => closedIn(s, repo.id, "preview"));
  const toggleSection = useStore((s) => s.toggleSection);
  const [previewShown, setPreviewShown] = useState(false);
  useEffect(() => {
    if (state !== "running" || previewShown) return;
    setPreviewShown(true);
    if (previewClosed) toggleSection(repo.id, "preview");
  }, [state, previewShown, previewClosed, repo.id, toggleSection]);
  if (repo.forge || repo.host) {
    return (
      <div className="guided">
        <p className="guided-status">{plainStatus(repo, "none")}</p>
        <p className="panel-hint">Open this project on its own machine to work on it.</p>
      </div>
    );
  }
  return (
    <div className="guided">
      <p className="guided-status">{plainStatus(repo, state)}</p>
      <div className="guided-actions">
        {state === "none" ? (
          <button ref={targets.run} type="button" className="guided-btn" onClick={() => void askClaude(repo.id, SETUP_PROMPT, null)}>
            Set up run
          </button>
        ) : state === "running" ? (
          <button ref={targets.run} type="button" className="guided-btn" onClick={() => void taskAct(repo.id, "stop", dev?.name)}>
            Stop
          </button>
        ) : (
          <button ref={targets.run} type="button" className="guided-btn primary" onClick={() => void taskAct(repo.id, "start", dev?.name)}>
            Run my app
          </button>
        )}
        <button
          ref={targets.save}
          type="button"
          className="guided-btn"
          disabled={!canSave(repo)}
          title={canSave(repo) ? "Claude commits and pushes your work" : "nothing to save"}
          onClick={() => void askClaude(repo.id, SAVE_PROMPT, null)}
        >
          Save my work
        </button>
        <span className="spacer" />
        <button type="button" className="mini" onClick={onMore}>
          show more
        </button>
      </div>
      {state === "running" && isHome(repo.id) && <PreviewSection repo={repo} />}
    </div>
  );
}
```

`isHome` is what `Dock.tsx` uses for the preview (line ~927); import it from wherever `Dock.tsx` does.

- [ ] **Step 2: Branch in `RepoPanel`**

In `RepoPanel`, near the other hooks (before the `if (!repo)` return, since hooks may not follow it):

```tsx
  const level = useStore((s) => s.settings.level);
  const [more, setMore] = useState(false);
  const runRef = useRef<HTMLButtonElement>(null);
  const saveRef = useRef<HTMLButtonElement>(null);
  useEffect(() => setMore(false), [id]);
```

After `const st = repo.status;`: `const guided = level === "intermediate" && !more;`.

Add `guided` to the section's class: `` className={`panel s-${stateOf(repo)}${guided ? " guided-panel" : ""}${modeClass}`} ``.

In the head, render `RepoLink`, `PanelMachines` and `RepoMenu` only when `!guided`. Then wrap everything from `{many && <PanelAway id={id} />}` through the sections' `PanelZoom.Provider` block:

```tsx
      {guided ? (
        <>
          {many && <PanelAway id={id} />}
          <GuidedPanel repo={repo} onMore={() => setMore(true)} targets={{ run: runRef, save: saveRef }} />
        </>
      ) : (
        <>
          {level === "intermediate" && (
            <div className="guided-less">
              <button type="button" className="mini" onClick={() => setMore(false)}>
                show less
              </button>
            </div>
          )}
          {/* the existing body, unchanged: PanelAway, Library link, description,
              panel-sub, run chip, TaskChip, panel-actions, note, access hint,
              workspaces, sections */}
        </>
      )}
```

The comment marks where the existing JSX goes; move it in unchanged. `{!repo.error && <PanelShells repo={repo} />}` stays outside, below `.panel-body`, in both branches.

Import `GuidedPanel` from `./Guided`.

- [ ] **Step 3: The level on the panel gear**

In `PanelGear`, read `const level = useStore((s) => s.settings.level);` and add to the `layout` entries (for solo too, so put it outside the `solo ? [] :` ternary by building `layout` as `[...(solo ? [] : [...current entries]), levelEntries]`):

```ts
        { type: "item", label: "intermediate panel", on: level === "intermediate", run: () => setSetting("level", "intermediate") },
        { type: "item", label: "advanced panel", on: level === "advanced", run: () => setSetting("level", "advanced") },
```

- [ ] **Step 4: Styles** (in `ui/src/styles.css`, after `.panel-shells-body[hidden]`)

```css
/* ---------- the guided (intermediate) panel ---------- */
/* the body takes what it needs, up to half the panel (a preview can be
   tall), and the Claude shell takes the rest */
.panel.guided-panel > .panel-body {
  flex: 0 1 auto;
  max-height: 50%;
  padding-bottom: 8px;
}
.panel.guided-panel > .panel-shells {
  flex: 1 1 auto;
}
.panel.guided-panel > .panel-shells > .panel-shells-body {
  flex: 1 1 auto;
  max-height: none;
}
.panel.guided-panel > .panel-shells > .panel-shells-body > .term-body {
  flex: 1 1 auto;
  height: auto;
}
.panel.guided-panel > .panel-shells > .term-grip {
  display: none;
}
.guided {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 14px 0;
}
.guided-status {
  margin: 0;
  color: var(--lichen);
}
.guided-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px;
}
.guided-btn {
  font: inherit;
  padding: 6px 12px;
  border: 1px solid var(--hair);
  border-radius: 6px;
  background: var(--bark2);
  color: inherit;
  cursor: pointer;
}
.guided-btn.primary {
  border-color: var(--moss);
  color: var(--moss);
}
.guided-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.guided-less {
  display: flex;
  justify-content: flex-end;
  padding: 0 14px;
}
```

Check each token name (`--bark2`, `--lichen`, `--moss`, `--hair`) against `:root` in `styles.css` and use the nearest existing one if a name differs.

- [ ] **Step 5: Gates and a look**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

In the browser with a fresh profile (playwright-cli, a new context, so no `canopy.settings`): open a repo, see the status line, the two buttons and the Claude shell filling the panel; "show more" shows today's panel with "show less"; the gear's "advanced panel" switches every panel; the shell tab did not restart across the switch (its output is still there). Screenshots to the scratchpad.

- [ ] **Step 6: Commit**

```bash
git add ui/src/components/Guided.tsx ui/src/components/Dock.tsx ui/src/styles.css
git commit -m "feat(ui): the guided panel, Claude first, with show more and the level on the gear"
```

---

### Task 7: The tour, and the level in Settings

**Files:**
- Create: `ui/src/components/Tour.tsx`
- Modify: `ui/src/components/Dock.tsx` (`RepoPanel`, render the tour)
- Modify: `ui/src/components/Settings.tsx` (a row near "open a repo", ~131)
- Modify: `ui/src/styles.css`

**Interfaces:**
- Consumes: `tourStep`, `TOUR_TEXT`, `TourStep` (Task 2); `Settings.onboarded`, `LEVELS` (Task 1); the refs from Task 6; `dockless` from `../routes`.
- Produces: `<Tour targets={Array<() => Element | null>} onDone={() => void} />`.

- [ ] **Step 1: Write `ui/src/components/Tour.tsx`**

```tsx
import { useEffect, useLayoutEffect, useState } from "react";
import { createPortal } from "react-dom";
import { TOUR_TEXT, tourStep, type TourStep } from "../guided";

interface Spot {
  top: number;
  left: number;
}

/** Three coach marks, each under the thing it names, with next and skip.
 *  A step whose target is not on screen is passed over. */
export function Tour({ targets, onDone }: { targets: Array<() => Element | null>; onDone: () => void }) {
  const [step, setStep] = useState<TourStep>(0);
  const [spot, setSpot] = useState<Spot | null>(null);
  useEffect(() => {
    if (step === "done") onDone();
  }, [step, onDone]);
  useLayoutEffect(() => {
    if (step === "done") return;
    const place = () => {
      const el = targets[step]?.();
      if (!el) {
        setStep((s) => (s === "done" ? s : tourStep(s, "next")));
        return;
      }
      const r = el.getBoundingClientRect();
      const top = Math.min(r.bottom + 8, window.innerHeight - 120);
      const left = Math.max(8, Math.min(r.left, window.innerWidth - 288));
      setSpot({ top, left });
    };
    place();
    window.addEventListener("resize", place);
    window.addEventListener("scroll", place, true);
    return () => {
      window.removeEventListener("resize", place);
      window.removeEventListener("scroll", place, true);
    };
  }, [step, targets]);
  if (step === "done" || !spot) return null;
  return createPortal(
    <div className="tour" role="dialog" aria-label="Getting started" style={{ top: spot.top, left: spot.left }}>
      <p>{TOUR_TEXT[step]}</p>
      <div className="tour-actions">
        <span className="tour-count">{step + 1} of 3</span>
        <span className="spacer" />
        <button type="button" className="mini" onClick={() => setStep("done")}>
          skip tour
        </button>
        <button type="button" className="mini" onClick={() => setStep((s) => tourStep(s, "next"))}>
          {step === 2 ? "done" : "next"}
        </button>
      </div>
    </div>,
    document.body,
  );
}
```

- [ ] **Step 2: Show it from `RepoPanel`**

Next to the other hooks in `RepoPanel`:

```tsx
  const onboarded = useStore((s) => s.settings.onboarded);
  const setSetting = useStore((s) => s.setSetting);
  const finishTour = useCallback(() => setSetting("onboarded", true), [setSetting]);
  const tourTargets = useMemo(
    () => [
      () => box.current?.querySelector(".panel-shells") ?? null,
      () => runRef.current,
      () => saveRef.current,
    ],
    [],
  );
```

(`useCallback`/`useMemo` join the `react` import.) Just before `{mode === "focus" && <FocusGrips box={box} />}`:

```tsx
      {guided && !onboarded && !hidden && !dockless() && <Tour targets={tourTargets} onDone={finishTour} />}
```

Import `Tour` from `./Tour` and `dockless` from `../routes` if `Dock.tsx` does not have it yet. Two panels open at once would each show a tour; show it only in the active panel by also requiring `useStore((s) => s.activePanel) === id || panels.length === 1`. Read `activePanel` in a hook: `const isActive = useStore((s) => s.activePanel === id || s.panels.length === 1);` and add `isActive &&` to the condition.

- [ ] **Step 3: The Settings row**

In `Settings.tsx`, beside `OPEN_IN`:

```ts
const LEVEL = [
  { value: "intermediate", label: "intermediate", title: "Claude first: run your app, save your work, and the rest one click away" },
  { value: "advanced", label: "advanced", title: "Every section: changes, tasks, history, peers, launch and more" },
] as const;
```

and a row before "open a repo":

```tsx
          <section className="settings-row">
            <h3 className="panel-label">repo panel</h3>
            <Seg label="How much a repo's panel shows" value={settings.level} options={LEVEL} onChange={(v) => setSetting("level", v)} />
            <button type="button" className="mini" onClick={() => setSetting("onboarded", false)}>
              show the tour again
            </button>
          </section>
```

- [ ] **Step 4: Styles**

```css
/* the guided panel's coach marks */
.tour {
  position: fixed;
  z-index: 60;
  width: 280px;
  padding: 10px 12px;
  border: 1px solid var(--moss);
  border-radius: 8px;
  background: var(--bark1);
  box-shadow: 0 6px 24px rgb(0 0 0 / 0.35);
}
.tour p {
  margin: 0 0 8px;
}
.tour-actions {
  display: flex;
  align-items: center;
  gap: 6px;
}
.tour-count {
  color: var(--lichen);
  font-size: 0.85em;
}
```

Check `z-index` against `.menu` and `.settings-pop` in `styles.css` and sit the tour just under the menus.

- [ ] **Step 5: Gates, a look, commit**

Run: `bun run typecheck && bun run lint && bun test && bun run build`
Expected: all pass.

Browser, fresh profile: the tour's three steps land under the shell, Run and Save; "skip tour" ends it and a reload does not bring it back; Settings' "show the tour again" does. An existing profile (set `canopy.settings` to `{"sort":"recent"}` before load) shows the advanced panel and no tour.

```bash
git add ui/src/components/Tour.tsx ui/src/components/Dock.tsx ui/src/components/Settings.tsx ui/src/styles.css
git commit -m "feat(ui): the guided panel's tour, and the level in Settings"
```

---

### Task 8: Docs and the full check

**Files:**
- Modify: `CLAUDE.md` (the `ui/` bullet: one sentence each for `level`, `GuidedPanel`, the auto-open subscription, `AgentButtons`/`askClaude`, `liveTerms.ts`, `Tour`; the server bullet: `start=claude`, `/api/terms/agent`)
- Modify: `docs/superpowers/specs/2026-09-29-guided-panel-design.md` (append the four amendments from the top of this plan under "Amendments")

- [ ] **Step 1: Write the doc lines** in the style of the surrounding `CLAUDE.md` bullets (plain sentences, names in backticks, what calls what).

- [ ] **Step 2: The stale-build gate and the full gates**

Run: `bun run typecheck && bun run lint && bun test && bun run build && ~/.claude/skills/verify-build/clean-rebuild.sh verify "guided-panel"`
Expected: all pass; `verify` finds the class name in the served bundle.

- [ ] **Step 3: The review-focus checks by hand in the browser**

With canopy's panel open at intermediate: reload, and the shell tab count stays 1. Hide the panel shell from the shells picker, close and reopen the panel, and no second shell appears. In a plain shell (advanced, the auto-opened one), press ✓, and a new Claude shell opens and gets the prompt, the plain shell gets nothing.

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md docs/superpowers/specs/2026-09-29-guided-panel-design.md
git commit -m "docs: the guided panel in the architecture notes, spec amendments"
```
