# Workspace primary, color and workspace runs. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a workspace can mark one member primary and carry a color. An ask, chat or (once plan 2 ships) propose run can start from a workspace. That run works in the primary, with every other local member added through `--add-dir`.

**Architecture:**
- `Workspace` gains optional `primary` and `color`. They are checked in config normalization and set through a new `setWorkspaceLook`.
- The server gains `PATCH /api/workspaces` and `POST /api/workspaces/run`.
- `Runner.start` takes an optional `RunScope`, which sets `run.workspace` and becomes `DriveSpec.addDirs` and `--add-dir` flags.
- `buildPrompt` takes the scope and words the head and the safety rule for several folders.

**Tech stack:** Bun + TypeScript (strict), `bun:test`, React 19 + zustand, plain CSS in `ui/src/styles.css`.

**Spec:** `docs/superpowers/specs/2026-10-06-kilo-borrowings-design.md`, section "Workspace primary and color".

## Global constraints

- TypeScript `"strict": true`. No `any`, no `as` casts on untrusted data, no non-null `!`.
- `src/core/types.ts`, `src/core/actions.ts` and `ui/src/*` stay browser-safe: no Bun or node imports.
- Gates: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`.
- No new dependencies. No CSS framework.
- Colors are the palette's token names (`moss`, `lichen`, `rust`, `sky`, `bark`), never hex.
- Workspace runs are Claude only for v1. A Codex agent is refused with "workspace runs need Claude Code".
- Commit per task, never amend, no backticks in commit messages.
- Prose in code comments and UI copy follows unslop: no em dashes, sentence case.

## Review focus

1. **A primary that is not a member.** It is hand-edited into config.json, or left behind when the member is removed. Normalization drops it, `removeWorkspace` clears it, and the effective primary falls back to `repos[0]`. Tasks 1 and 2.
2. **A member that is not a local folder.** A remote `ssh://` path or a forge repo is never passed to `--add-dir`. The run's first note names it as skipped. Task 4.
3. **A busy member.** A run or flow on any local member refuses the workspace run with 409, not just a busy primary. Task 4.
4. **An empty workspace.** Zero members means no effective primary, so the run is refused with 400 "the workspace has no repos" rather than throwing. Task 4.
5. **A primary whose repo is gone from the scan.** The folder was deleted or moved. The run is refused with 404 naming the path, not a 500. Task 4.

---

## File structure

| File | What changes |
|---|---|
| `src/core/types.ts` | `WS_COLORS`, `WsColor`, `Workspace.primary?`, `Workspace.color?`, `effectivePrimary`, `Run.workspace?`, `RunScope` |
| `src/core/store.ts` | normalization of the new fields, `setWorkspaceLook`, primary cleared in `removeWorkspace` |
| `src/core/driver.ts` | `DriveSpec.addDirs?` |
| `src/core/claudedrive.ts` | `cliArgs` emits `--add-dir` |
| `src/core/actions.ts` | `buildPrompt(repo, spec, note, scope?)`, `safetyFor` |
| `src/core/runner.ts` | `start(..., scope?)` sets `run.workspace`, passes `addDirs` |
| `src/server/index.ts` | `PATCH /api/workspaces`, `POST /api/workspaces/run` |
| `ui/src/api.ts` | `wsLook`, `wsRun` |
| `ui/src/store.ts` | `startWsRun`, the sheet kind `plan` gains `workspace?` |
| `ui/src/components/TopBar.tsx` | color dot, workspace menu |
| `ui/src/components/RunSheet.tsx` | `Plan` starts a workspace run when the sheet names one; the run head says the workspace |
| `ui/src/components/RepoCard.tsx` (or the card component `RepoGrid` renders) | color rule, primary chip |
| `ui/src/styles.css` | `.ws-dot`, `.card[data-ws-color]`, `.chip.primary` |
| `docs/architecture.md` | the workspace notes |

---

## Task 1: the type, the colors and config normalization

**Files:**
- Modify: `src/core/types.ts:362-366`
- Modify: `src/core/store.ts:133-136`
- Test: `src/core/store.test.ts`

**Interfaces:**
- Produces: `WS_COLORS`, `type WsColor`, `isWsColor(v: unknown): v is WsColor`, `Workspace { name; repos; primary?: string; color?: WsColor }`, `effectivePrimary(ws: Workspace): string | null`, `normalizeWorkspace(v: unknown): Workspace | null` (exported from `store.ts` for the test).

- [x] **Step 1: Write the failing test** in `src/core/store.test.ts`

```ts
import { normalizeWorkspace } from "./store";
import { effectivePrimary } from "./types";

describe("workspace look", () => {
  test("keeps a primary that is a member and a known color", () => {
    expect(normalizeWorkspace({ name: "w", repos: ["/a", "/b"], primary: "/b", color: "sky" })).toEqual({
      name: "w",
      repos: ["/a", "/b"],
      primary: "/b",
      color: "sky",
    });
  });
  test("drops a primary that is not a member, and a color not in the palette", () => {
    expect(normalizeWorkspace({ name: "w", repos: ["/a"], primary: "/zzz", color: "#ff0000" })).toEqual({ name: "w", repos: ["/a"] });
  });
  test("refuses junk", () => {
    expect(normalizeWorkspace(null)).toBeNull();
    expect(normalizeWorkspace({ name: 3, repos: [] })).toBeNull();
    expect(normalizeWorkspace({ name: "w", repos: "x" })).toBeNull();
  });
  test("the effective primary is the marked one, else the first member, else none", () => {
    expect(effectivePrimary({ name: "w", repos: ["/a", "/b"], primary: "/b" })).toBe("/b");
    expect(effectivePrimary({ name: "w", repos: ["/a", "/b"] })).toBe("/a");
    expect(effectivePrimary({ name: "w", repos: [] })).toBeNull();
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/store.test.ts`
Expected: FAIL, `normalizeWorkspace` is not exported.

- [x] **Step 3: Implement.** Replace the `Workspace` interface in `src/core/types.ts`:

```ts
/** The palette's own token names; a workspace's identity color is one of
 *  them, so it follows the theme like every other color. */
export const WS_COLORS = ["moss", "lichen", "rust", "sky", "bark"] as const;
export type WsColor = (typeof WS_COLORS)[number];

export interface Workspace {
  name: string;
  /** absolute repo paths, stable across different scan roots */
  repos: string[];
  /** the member new code goes in: a workspace run's cwd. One of `repos`;
   *  absent means the first member */
  primary?: string;
  color?: WsColor;
}

export const isWsColor = (v: unknown): v is WsColor => typeof v === "string" && (WS_COLORS as readonly string[]).includes(v);

/** Where a workspace run works: the marked primary, else the first member. */
export const effectivePrimary = (ws: Workspace): string | null => ws.primary ?? ws.repos[0] ?? null;
```

In `src/core/store.ts` add, above `normalizeConfig`:

```ts
/** One stored workspace, or null for junk. A primary that is not a member
 *  and a color outside the palette are dropped, not kept to fail later. */
export function normalizeWorkspace(v: unknown): Workspace | null {
  if (!v || typeof v !== "object") return null;
  const w = v as { name?: unknown; repos?: unknown; primary?: unknown; color?: unknown };
  if (typeof w.name !== "string" || !Array.isArray(w.repos)) return null;
  const repos = w.repos.filter((r): r is string => typeof r === "string");
  const out: Workspace = { name: w.name, repos };
  if (typeof w.primary === "string" && repos.includes(w.primary)) out.primary = w.primary;
  if (isWsColor(w.color)) out.color = w.color;
  return out;
}
```

Replace the `workspaces:` line in `normalizeConfig` with:

```ts
    workspaces: (Array.isArray(cfg.workspaces) ? cfg.workspaces : [])
      .map(normalizeWorkspace)
      .filter((w): w is Workspace => w !== null),
```

Import `isWsColor` from `./types`.

- [x] **Step 4: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/store.test.ts`
Expected: PASS, the old workspace tests included.

- [x] **Step 5: Commit**

```bash
git add src/core/types.ts src/core/store.ts src/core/store.test.ts
git commit -m "feat(workspaces): a primary member and an identity color"
```

---

## Task 2: setting the look, and removing the primary

**Files:**
- Modify: `src/core/store.ts:249-277`
- Test: `src/core/store.test.ts`

**Interfaces:**
- Consumes: `Workspace`, `WsColor` (Task 1).
- Produces: `setWorkspaceLook(name: string, look: { primary?: string | null; color?: WsColor | null }): Promise<Workspace[]>`. It throws `Error("unknown workspace")` or `Error("not a member of <name>")`.

- [x] **Step 1: Write the failing test**

```ts
import { setWorkspaceLook } from "./store";

describe("workspace look updates", () => {
  test("sets and clears primary and color without touching members", async () => {
    await upsertWorkspace("look", ["/a", "/b"]);
    let ws = await setWorkspaceLook("look", { primary: "/b", color: "rust" });
    expect(ws.find((w) => w.name === "look")).toEqual({ name: "look", repos: ["/a", "/b"], primary: "/b", color: "rust" });
    ws = await setWorkspaceLook("look", { color: null });
    expect(ws.find((w) => w.name === "look")).toEqual({ name: "look", repos: ["/a", "/b"], primary: "/b" });
  });
  test("refuses a primary that is not a member, and an unknown workspace", async () => {
    await expect(setWorkspaceLook("look", { primary: "/zzz" })).rejects.toThrow("not a member of look");
    await expect(setWorkspaceLook("nope", { color: "sky" })).rejects.toThrow("unknown workspace");
  });
  test("removing the primary member clears primary", async () => {
    const ws = await removeWorkspace("look", "/b");
    expect(ws.find((w) => w.name === "look")).toEqual({ name: "look", repos: ["/a"] });
    await removeWorkspace("look");
  });
});
```

- [x] **Step 2: Run it and watch it fail**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/store.test.ts`
Expected: FAIL, `setWorkspaceLook` is not exported.

- [x] **Step 3: Implement** in `src/core/store.ts`, after `removeWorkspace`:

```ts
/** Sets or clears a workspace's primary and color; membership stays as it
 *  is. `null` clears a field and `undefined` leaves it alone. */
export async function setWorkspaceLook(
  name: string,
  look: { primary?: string | null; color?: WsColor | null },
): Promise<Workspace[]> {
  return withConfig((cfg) => {
    const ws = cfg.workspaces.find((w) => w.name === name);
    if (!ws) throw new Error("unknown workspace");
    if (look.primary === null) delete ws.primary;
    else if (look.primary !== undefined) {
      if (!ws.repos.includes(look.primary)) throw new Error(`not a member of ${name}`);
      ws.primary = look.primary;
    }
    if (look.color === null) delete ws.color;
    else if (look.color !== undefined) ws.color = look.color;
    return cfg.workspaces;
  });
}
```

In `removeWorkspace`, inside `if (ws)`, after filtering the repos:

```ts
      if (ws && ws.primary === repo) delete ws.primary;
```

Check that `withConfig` lets a throw inside the callback abort the write. Read its body: if it writes before rethrowing, move the checks out of the callback into a `loadConfig()` pre-check.

- [x] **Step 4: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/store.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/core/store.ts src/core/store.test.ts
git commit -m "feat(workspaces): set the look without touching members"
```

---

## Task 3: `--add-dir`, the run's scope and the prompt for several folders

**Files:**
- Modify: `src/core/types.ts` (Run, RunScope)
- Modify: `src/core/driver.ts:51-58` (DriveSpec)
- Modify: `src/core/claudedrive.ts:118-145` (cliArgs)
- Modify: `src/core/actions.ts:39-63, 158-180` (SAFETY, buildPrompt)
- Modify: `src/core/runner.ts:192-262` (start)
- Test: `src/core/claudedrive.test.ts`, `src/core/actions.test.ts`, `src/core/runner-drivers.test.ts`

**Interfaces:**
- Produces:
  - `interface RunScope { workspace: string; primary: string; others: string[]; skipped: string[] }`. Paths are absolute. `others` are local folders. `skipped` are members left out, each named in words.
  - `Run.workspace?: string`.
  - `DriveSpec.addDirs?: readonly string[]`.
  - `buildPrompt(repo, spec, note, scope?: RunScope)`.
  - `Runner.start(repo, action, spec, note, agent?, by?, scope?: RunScope)`.

- [x] **Step 1: Write the failing tests**

`src/core/claudedrive.test.ts`:

```ts
test("cliArgs adds one --add-dir per extra folder", () => {
  const args = cliArgs({ allowedTools: [], maxTurns: 5, addDirs: ["/x", "/y z"] });
  const at = args.indexOf("--add-dir");
  expect(args.slice(at, at + 4)).toEqual(["--add-dir", "/x", "--add-dir", "/y z"]);
  expect(cliArgs({ allowedTools: [], maxTurns: 5 })).not.toContain("--add-dir");
});
```

`src/core/actions.test.ts`:

```ts
import { ACTIONS, buildPrompt } from "./actions";

test("a workspace prompt names the primary and the other folders, and widens the safety rule", () => {
  const repo = { id: "a", name: "trips-api", path: "/w/trips-api" } as Parameters<typeof buildPrompt>[0];
  const p = buildPrompt(repo, ACTIONS.ask, "add an endpoint", {
    workspace: "bike-trips",
    primary: "/w/trips-api",
    others: ["/w/trips-analysis"],
    skipped: [],
  });
  expect(p).toContain("workspace bike-trips");
  expect(p).toContain("Primary folder, where new code goes: /w/trips-api");
  expect(p).toContain("/w/trips-analysis");
  expect(p).toContain("Work only inside these folders");
  expect(p).not.toContain("Work only inside this repository");
});
```

If `actions.test.ts` already builds a `Repo` fixture, reuse it instead of the cast.

`src/core/runner-drivers.test.ts`: follow the file's existing fake-driver pattern. Start a run with a scope and assert three things: `run.workspace === "bike-trips"`, the driver's `ctx.spec.addDirs` equals `["/w/trips-analysis"]`, and the first step is the note "left out of this run: ssh://mini/x (on another machine)" when `skipped` holds that line.

- [x] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/claudedrive.test.ts src/core/actions.test.ts src/core/runner-drivers.test.ts`
Expected: FAIL. The type errors are about `addDirs` and the fourth argument.

- [x] **Step 3: Implement**

`types.ts`, beside `Run`:

```ts
/** A run that spans a workspace: it works in the primary and may read and
 *  change the other local members. */
export interface RunScope {
  workspace: string;
  /** absolute path, the run's cwd */
  primary: string;
  /** the other local members, absolute paths, passed with --add-dir */
  others: string[];
  /** members left out, in words: "ssh://mini/x (on another machine)" */
  skipped: string[];
}
```

Add `workspace?: string;` to `Run`, with the comment `/** the workspace this run spans, when it was started from one */`.

`driver.ts` `DriveSpec`:

```ts
  /** folders beside the cwd the agent may use (`--add-dir`): a workspace run's other members */
  addDirs?: readonly string[];
```

`claudedrive.ts` `cliArgs`, after the `--allowedTools` spread:

```ts
    ...(spec.addDirs ?? []).flatMap((d) => ["--add-dir", d]),
```

`actions.ts`: turn `SAFETY` into a function and keep the rest as is.

```ts
const safetyFor = (where: string) => `- ${where}
- Never rewrite published history, ...`; // the existing three lines, unchanged

const SAFETY = safetyFor("Work only inside this repository (submodules under it included).");
const WS_SAFETY = safetyFor("Work only inside these folders (submodules under them included).");
```

`RULES`, `ASK_RULES` and `CHAT_RULES` keep using `SAFETY`. Build their workspace twins by swapping `SAFETY` for `WS_SAFETY`, and pick between the two sets in `buildPrompt` with `scope ? ... : ...`. The head becomes:

```ts
  const head = scope
    ? [
        `You are working across the workspace ${scope.workspace}, launched from canopy (a multi-repo git dashboard).`,
        `Primary folder, where new code goes: ${scope.primary} (the git repository ${repo.name}).`,
        scope.others.length ? `Other folders you may read and change: ${scope.others.join(", ")}.` : "",
        facts.length ? `Primary's current state: ${facts.join(", ")}.` : "",
      ]
    : [/* the existing two lines */];
```

`runner.ts` `start`: add the `scope?: RunScope` parameter. Set `if (scope) run.workspace = scope.workspace;`. Pass `spec: scope ? { ...spec, addDirs: scope.others } : spec` into the `RunCtx`. Pass `scope` to both `buildPrompt` calls. Right after the run is built and before the first `onChange`, add:

```ts
    if (scope?.skipped.length) live.ctx.step({ kind: "note", text: `left out of this run: ${scope.skipped.join("; ")}` });
```

- [x] **Step 4: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/core
git commit -m "feat(runs): a run can span a workspace with add-dir"
```

---

## Task 4: the API

**Files:**
- Modify: `src/server/index.ts` (beside `/api/workspaces`, around :2376-2440)
- Test: `src/server/workspaces.test.ts` (new, set up like `src/server/agents.test.ts:30-42`)

**Interfaces:**
- Consumes: `setWorkspaceLook`, `effectivePrimary`, `RunScope`, `Runner.start(..., scope)`.
- Produces:
  - `PATCH /api/workspaces`, body `{ name, primary?: repoId | null, color?: WsColor | null }`. It returns `Workspace[]` and broadcasts `{type:"workspaces"}`.
  - `POST /api/workspaces/run`, body `{ name, action: "ask" | "chat", note?, client? }`. It returns 201 with `Run`. Plan 2 widens `action` to `"propose"`.

- [x] **Step 1: Write the failing test.** Make a scratch scan root with three git repos, `api`, `analysis` and `other`, using the helper the server tests already use. Start the server with a fake `claude` driver as `agents.test.ts` does, and add a workspace `bike` with `api` and `analysis`. Then:

```ts
test("PATCH sets the primary by repo id and refuses a non-member", async () => {
  let r = await call("PATCH", "/api/workspaces", { name: "bike", primary: "analysis", color: "moss" });
  expect(r.status).toBe(200);
  expect((await r.json())[0]).toMatchObject({ primary: join(root, "analysis"), color: "moss" });
  r = await call("PATCH", "/api/workspaces", { name: "bike", primary: "other" });
  expect(r.status).toBe(400);
  r = await call("PATCH", "/api/workspaces", { name: "bike", color: "#fff" });
  expect(r.status).toBe(400);
});

test("a workspace run starts on the primary with the others added", async () => {
  const r = await call("POST", "/api/workspaces/run", { name: "bike", action: "ask", note: "look around" });
  expect(r.status).toBe(201);
  const run = await r.json();
  expect(run.repoId).toBe("analysis");
  expect(run.workspace).toBe("bike");
  // the fake driver records its spec; addDirs is the other member
  expect(lastSpec().addDirs).toEqual([join(root, "api")]);
});

test("a busy member refuses the workspace run", async () => {
  // a run is still going on analysis from the last test, or start one on api
  const r = await call("POST", "/api/workspaces/run", { name: "bike", action: "ask", note: "again" });
  expect(r.status).toBe(409);
});

test("an empty workspace and an unknown one are refused plainly", async () => {
  await call("POST", "/api/workspaces", { name: "empty", repos: [] });
  expect((await call("POST", "/api/workspaces/run", { name: "empty", action: "ask", note: "x" })).status).toBe(400);
  expect((await call("POST", "/api/workspaces/run", { name: "nope", action: "ask", note: "x" })).status).toBe(404);
});
```

`call` and `lastSpec` are small helpers at the top of the file: `fetch` against the started port, and the fake driver's last `ctx.spec`.

- [x] **Step 2: Run it and watch it fail**

Run: `env -u TMUX SHELL=/bin/bash bun test src/server/workspaces.test.ts`
Expected: FAIL, 404 on both routes.

- [x] **Step 3: Implement** after the `DELETE /api/workspaces` route:

```ts
  if (path === "/api/workspaces" && method === "PATCH") {
    const b = (await req.json()) as { name?: unknown; primary?: unknown; color?: unknown };
    if (typeof b.name !== "string") return json({ error: "missing workspace name" }, 400);
    if (b.color !== undefined && b.color !== null && !isWsColor(b.color)) return json({ error: "unknown color" }, 400);
    const look: { primary?: string | null; color?: WsColor | null } = {};
    if (b.primary === null) look.primary = null;
    else if (typeof b.primary === "string") look.primary = idToPath(b.primary);
    if (b.color === null) look.color = null;
    else if (isWsColor(b.color)) look.color = b.color;
    try {
      const workspaces = await setWorkspaceLook(b.name, look);
      broadcast(state, { type: "workspaces", workspaces });
      return json(workspaces);
    } catch (err) {
      const msg = errText(err);
      return json({ error: msg }, msg === "unknown workspace" ? 404 : 400);
    }
  }
  if (path === "/api/workspaces/run" && method === "POST") {
    const b = (await req.json()) as { name?: unknown; action?: unknown; note?: unknown; client?: unknown };
    if (typeof b.name !== "string") return json({ error: "missing workspace name" }, 400);
    if (!isRunAction(b.action)) return json({ error: "unknown action" }, 400);
    const cfg = await loadConfig();
    const ws = cfg.workspaces.find((w) => w.name === b.name);
    if (!ws) return json({ error: "unknown workspace" }, 404);
    const primaryPath = effectivePrimary(ws);
    if (!primaryPath) return json({ error: "the workspace has no repos" }, 400);
    const primary = state.result.repos.find((r) => r.path === primaryPath);
    if (!primary) return json({ error: `the primary ${primaryPath} is not among the scanned repos` }, 404);
    const others: string[] = [];
    const skipped: string[] = [];
    for (const p of ws.repos) {
      if (p === primaryPath) continue;
      const r = state.result.repos.find((x) => x.path === p);
      if (!r) skipped.push(`${p} (not found by the last scan)`);
      else if (r.host) skipped.push(`${p} (on ${r.host})`);
      else if (r.forge) skipped.push(`${p} (on the forge)`);
      else {
        const busy = state.runner.activeFor(r.id);
        if (busy) throw new HttpError(409, `${r.name} already has a ${busy.verb} run going`);
        if (state.flows.activeFor(r.id)) throw new HttpError(409, `a workflow is running in ${r.name}`);
        others.push(p);
      }
    }
    if (primary.host) return json({ error: `agent runs only work on this machine; ${primary.name} is on ${primary.host}` }, 400);
    if (state.flows.activeFor(primary.id)) throw new HttpError(409, "a workflow is running here");
    const primaryBusy = state.runner.activeFor(primary.id);
    if (primaryBusy) throw new HttpError(409, `${primary.name} already has a ${primaryBusy.verb} run going`);
    const agent = agentFor(cfg, primary.path, b.action === "chat" ? "chat" : "job");
    if (agent.harness !== "claude") return json({ error: "workspace runs need Claude Code" }, 400);
    await needHarness(state, agent.harness, primary.path);
    const note = typeof b.note === "string" ? b.note : "";
    const by = deviceNameOf(state, typeof b.client === "string" ? b.client : null) ?? undefined;
    const scope: RunScope = { workspace: ws.name, primary: primary.path, others, skipped };
    return json(state.runner.start(primary, b.action, ACTIONS[b.action], note, agent, by, scope), 201);
  }
```

`state.result.repos` is the scan result `repoById` (`index.ts:1195`) reads; a workspace holds home's checkouts only, so it is the right list. Import `isWsColor`, `type WsColor`, `effectivePrimary`, `type RunScope` and `setWorkspaceLook`.

- [x] **Step 4: Run it and watch it pass**

Run: `env -u TMUX SHELL=/bin/bash bun test src/server/workspaces.test.ts`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/server
git commit -m "feat(workspaces): set the look and start a run from a workspace"
```

---

## Task 5: the UI

**Files:**
- Modify: `ui/src/api.ts:769-785`
- Modify: `ui/src/store.ts` (the `Sheet` union at :975, `openPlan` around :2528, a new `startWsRun`)
- Modify: `ui/src/components/TopBar.tsx:190-250` (`WsTabs`)
- Modify: `ui/src/components/RunSheet.tsx:166-255` (`Plan`), and the run head that shows `verb` and repo
- Modify: the repo card component (find the element with the `card` class in `RepoGrid`)
- Modify: `ui/src/styles.css`
- Create: `ui/src/workspaces.ts` and `ui/src/workspaces.test.ts`

**Interfaces:**
- Consumes: `PATCH /api/workspaces`, `POST /api/workspaces/run`, `Workspace.primary`, `Workspace.color`, `Run.workspace`.
- Produces:
  - `api.wsLook(name, look)` and `api.wsRun(name, action, note)`.
  - Store: `startWsRun(name, action, note)` and `openWsPlan(name, action)`.
  - The sheet kind `{ kind: "plan"; repoId; action; workspace?: string }`.
  - Pure helpers in `ui/src/workspaces.ts`: `wsOf(workspaces, repoPath): Workspace[]` and `isPrimary(ws, repoPath): boolean`.

- [x] **Step 1: Write the failing test** for the pure helpers, `ui/src/workspaces.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { isPrimary, wsOf } from "./workspaces";

const ws = [
  { name: "a", repos: ["/x", "/y"], primary: "/y", color: "sky" as const },
  { name: "b", repos: ["/y"] },
];
describe("workspace helpers", () => {
  test("which workspaces hold a repo", () => {
    expect(wsOf(ws, "/y").map((w) => w.name)).toEqual(["a", "b"]);
    expect(wsOf(ws, "/z")).toEqual([]);
  });
  test("primary is the marked one, else the first member", () => {
    expect(isPrimary(ws[0]!, "/y")).toBe(true);
    expect(isPrimary(ws[0]!, "/x")).toBe(false);
    expect(isPrimary(ws[1]!, "/y")).toBe(true);
  });
});
```

The `!` in the test is on a literal array; if lint refuses it, use `ws.at(0)` with a guard.

- [x] **Step 2: Run it and watch it fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/workspaces.test.ts`
Expected: FAIL, the module is missing.

- [x] **Step 3: Implement**

`ui/src/workspaces.ts`:

```ts
/** Which workspaces a repo is in, and whether it is one's primary. Pure,
 *  for the cards and the workspace menu. */
import { effectivePrimary, type Workspace } from "../../src/core/types";

export const wsOf = (workspaces: readonly Workspace[], repoPath: string): Workspace[] =>
  workspaces.filter((w) => w.repos.includes(repoPath));

export const isPrimary = (ws: Workspace, repoPath: string): boolean => effectivePrimary(ws) === repoPath;
```

Match the import path style the other `ui/src/*.ts` files use for `src/core/types`.

`api.ts`:

```ts
  wsLook: (name: string, look: { primary?: string | null; color?: WsColor | null }) =>
    req<Workspace[]>(homeName(), "/api/workspaces", { method: "PATCH", body: JSON.stringify({ name, ...look }) }),
  wsRun: (name: string, action: RunAction, note: string) =>
    req<Run>(homeName(), "/api/workspaces/run", { method: "POST", body: JSON.stringify({ name, action, note, client: clientId() }) }),
```

Use whatever the existing `run` call passes as `client`.

`store.ts`:
- Widen the sheet kind with `workspace?: string`.
- `openWsPlan(name, action)` finds the workspace's effective primary repo id among home's repos and sets `sheet: { kind: "plan", repoId, action, workspace: name }`.
- `startWsRun(name, action, note)` calls `api.wsRun` and then opens `{ kind: "run", runId }`, mirroring `startRun`.

`RunSheet.tsx` `Plan`:
- Take an optional `workspace` prop from the sheet.
- When it is set, `go` calls `startWsRun(workspace, action, note)`. The eyebrow reads `with ${name} · workspace ${workspace}`.
- The live run's head shows `· workspace ${run.workspace}` when the run has one.

`TopBar.tsx` `WsTabs`:
- Each tab gets `<span className="ws-dot" data-color={w.color ?? ""} aria-hidden="true" />` before the name.
- The active tab's `ws-actions` gains a gear (`Gear` and `GearEntry`, as the panel gear uses) with these entries:
  - "ask in workspace…", which runs `openWsPlan(w.name, "ask")`
  - "chat in workspace…", which runs `openWsPlan(w.name, "chat")`
  - a "primary" row for each member, the current one `on`, which runs `api.wsLook(w.name, { primary: repoIdOf(path) })`
  - a "color" row for each `WS_COLORS` entry plus "none", which runs `api.wsLook(w.name, { color })`
- The gear opens on a phone too. Asking and chatting work everywhere; only the openers need a laptop.

The repo card:
- Read `wsOf(workspaces, repo.path)`.
- When the active workspace tab holds the repo, set `data-ws-color={ws.color}` on the card.
- When the repo is that workspace's primary, show `<span className="chip primary">primary</span>` in the card head.

`styles.css`, near the `.ws-tabs` rules:

```css
.ws-dot { inline-size: 7px; block-size: 7px; border-radius: 50%; background: var(--ink-faint); display: inline-block; margin-inline-end: 6px; }
.ws-dot[data-color="moss"], .card[data-ws-color="moss"] { --ws: var(--moss); }
.ws-dot[data-color="lichen"], .card[data-ws-color="lichen"] { --ws: var(--lichen); }
.ws-dot[data-color="rust"], .card[data-ws-color="rust"] { --ws: var(--rust); }
.ws-dot[data-color="sky"], .card[data-ws-color="sky"] { --ws: var(--sky); }
.ws-dot[data-color="bark"], .card[data-ws-color="bark"] { --ws: var(--bark); }
.ws-dot[data-color]:not([data-color=""]) { background: var(--ws); }
.card[data-ws-color] { box-shadow: inset 3px 0 0 var(--ws); }
.chip.primary { color: var(--moss-deep); }
```

Check the real names of `--ink-faint` and `--bark` in the token block at `styles.css:330-380`, and use the ones that exist. Run `settings.test.ts` after this edit, since it reads `styles.css` for palette rules.

- [x] **Step 4: Gates and a browser check**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

Then start a scratch canopy server, following the memory note "Scratch canopy server for UI checks": `env -u TMUX`, a short `CANOPY_CONFIG_DIR`, previews off. Drive it with playwright-cli:
1. Make a workspace of two repos.
2. Open its gear, set the second repo primary and the color sky.
3. Check that the dot and the card rule turn sky and the chip moves.
4. Run "ask in workspace…" with the note "list the folders you can see". Check that the run sheet says the workspace and the first step lists the add-dir folder.
5. Resize the window to 390px wide and check that the gear opens as a bottom sheet.

- [x] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(workspaces): primary, color and workspace runs in the UI"
```

---

## Task 6: the architecture note

**Files:**
- Modify: `docs/architecture.md`, sections "src/core" (the workspace sentence) and "ui/".

- [x] **Step 1: Write the notes.** Cover:
  - `Workspace.primary` and `color` and their normalization.
  - `setWorkspaceLook`, and that `removeWorkspace` clears a removed primary.
  - The two routes.
  - That a workspace run is Claude only, works in the effective primary with `--add-dir` for local members, refuses when any local member is busy, and locks and fingerprints the primary alone.
  - The UI entries.

- [x] **Step 2: Gates**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

- [x] **Step 3: Commit**

```bash
git add docs/architecture.md
git commit -m "docs: workspace primary and workspace runs"
```
