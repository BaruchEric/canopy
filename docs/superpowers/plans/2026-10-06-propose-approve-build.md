# Plan, then build: the propose action. Implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** a run starts Claude in plan mode. When Claude presents its plan, the run shows it with "approve, ask before commands", "approve, run on its own" and "revise". On approval the same session builds it, with a live todo checklist and each subagent's steps folded under its call. On the way, runs stop breaking when Claude starts a background subagent.

**Architecture:**
- `ClaudeDriver` learns three things:
  1. Holding a `result` while background tasks run (the P6 fix).
  2. Sending its own control requests (`set_permission_mode`).
  3. Turning `ExitPlanMode` into a `proposal` prompt.
- The driver parses todos and subagent parentage into two new `Run` fields and a new `RunStep` field.
- A new action `propose` carries `permissionMode: "plan"` down to `cliArgs`.
- The UI adds a proposal form, a todo checklist and nested subagent steps.

**Tech stack:** Bun + TypeScript (strict), `bun:test`, the stand-in CLI `src/core/testdata/fake-claude.ts`, React 19 + zustand.

**Spec:** `docs/superpowers/specs/2026-10-06-kilo-borrowings-design.md`, sections "What a probe of the real CLI showed" (P1 to P6), "Plan then build" and "Background subagents".

## Global constraints

- TypeScript `"strict": true`. No `any`, no `as` casts on untrusted data, no non-null `!`.
- `src/core/types.ts`, `src/core/actions.ts`, `src/core/todos.ts` and `ui/src/*` stay browser-safe: no Bun or node imports.
- Gates: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`.
- Names: the action is `propose`, the prompt kind is `proposal`, the checklist is `todos`. Never "plan" (the pre-run note sheet) or "tasks" (a repo's processes) in new identifiers.
- Claude only. `propose` is refused for a Codex agent with "plan, then build needs Claude Code", and is never used by flows, fleets or incubator stages.
- The fake CLI replays the probe (spec P1 to P5), with real wire shapes: `ExitPlanMode` input `{ plan }`, `TaskCreate` result text "Task #N created successfully: ...", `system` subtypes `task_started` and `task_notification`, and `parent_tool_use_id` on subagent messages.
- No new dependencies. The plan text renders as preformatted text; no markdown library.
- Commit per task, never amend, no backticks in commit messages.
- Prose in comments and UI copy follows unslop: no em dashes, sentence case.

## Review focus

1. **The early result.** A `result` while a background subagent runs must not close stdin, end a job, idle a chat or deny the subagent's waiting prompts. A background shell (`local_bash`, a dev server) never holds one. When the subagents finish and no new turn comes, the held result ends the run after the grace. A process that exits with a result still held ends with that result, not "failed". Task 1.
2. **Approve on a repo without yolo.** "run on its own" is not offered, and an `approve` with `auto: true` sent by hand is downgraded to `acceptEdits`, never `bypassPermissions`. On a yolo repo, a refused bypass switch falls back to `acceptEdits`. The switch goes after the allow, never before, because the allow resets the mode (spec P8). Task 3.
3. **The mode switch the CLI refuses or never answers.** If `set_permission_mode` comes back as an error, or gets no reply within 10 s, the approval still allows `ExitPlanMode`. The run notes "could not switch to <mode>; every edit will ask", rather than hanging the run. Task 3.
4. **Revise with an empty note, and a stop while the proposal waits.** An empty revise is "Revise the plan." A stop denies the proposal like any prompt, and the run ends stopped. Task 3.
5. **A subagent's own TaskCreate, and a malformed todo result.** A child's todos never enter `run.todos`. A result text without "Task #N" adds nothing and throws nothing. Task 4.

---

## File structure

| File | What changes |
|---|---|
| `src/core/testdata/fake-claude.ts` | modes `async` and `propose` |
| `src/core/claudedrive.ts` | background count and held result; `request()` and incoming `control_response`; ExitPlanMode → proposal; todos and parent wiring; `cliArgs` reads `spec.permissionMode` |
| `src/core/driver.ts` | `PromptInput` gains `proposal`; `settleNote`; `DriveSpec.permissionMode?`; `DriveCtx.todos()` |
| `src/core/types.ts` | `RunPrompt` proposal arm, `RunAnswer` approve arm, `RunTodo`, `Run.proposal?`, `Run.todos?`, `RunStep.parent?`, `RUN_ACTIONS` gains `propose` |
| `src/core/todos.ts` (new, pure) | `todoCreated`, `todoUpdated`, `todoWritten`, `TODO_TOOLS` |
| `src/core/actions.ts` | `ActionSpec.permissionMode?`, `ACTIONS.propose`, titles for TaskCreate/TaskUpdate |
| `src/server/answers.ts` (new) | `parseAnswer`, moved out of `index.ts`, keeps a deny's message and reads approve |
| `src/server/index.ts` | the run route refuses propose on Codex; the workspace run route takes propose if plan 1 has shipped |
| `ui/src/components/Prompts.tsx` | `ProposalForm`; `RunPromptForm` switch |
| `ui/src/runs.ts` | `nestSteps`, `hideTodoSteps` |
| `ui/src/components/RunSheet.tsx` | the todo checklist, the proposal card, nested steps |
| `ui/src/components/RepoMenu.tsx:31` | `JOBS` gains propose, disabled off Claude |
| `ui/src/inbox.ts`, `ui/src/feed.ts` | words for a proposal |
| `ui/src/styles.css` | `.todos`, `.proposal`, `.step-kids` |
| `docs/architecture.md` | runs section |

---

## Task 1: background subagents no longer end or break a run (P6)

**Files:**
- Modify: `src/core/testdata/fake-claude.ts`
- Modify: `src/core/claudedrive.ts:203-262` (`drive`) and `:173-175` (fields)
- Test: `src/core/claudedrive.test.ts`

**Interfaces:**
- Produces: nothing new outside the driver. The behavior changes for every Claude run.

- [x] **Step 1: Add three modes to the fake**, with the real message shapes from spec P7.

Document them in the header comment:
- **async** starts a background Agent and sends a result while it runs. Then it sends a subagent permission request. After that is answered, it sends the task notification and the real result.
- **bgshell** starts a background shell and ends its turn. A shell never holds a result.
- **quiet** is like async, but after the notification it sends nothing more.

At the top of the fake:

```ts
const sys = (subtype: string, extra: Record<string, unknown>) => out({ type: "system", subtype, session_id: "sess-1", ...extra });
const tasks = (list: { task_id: string; task_type: string }[]) => sys("background_tasks_changed", { tasks: list });
```

In `onUser`:

```ts
  if (mode === "async" || mode === "quiet") {
    out({ type: "assistant", session_id: "sess-1", message: { role: "assistant", content: [{ type: "tool_use", id: "ag1", name: "Agent", input: { description: "read math.ts", subagent_type: "Explore", prompt: "read it" } }] } });
    tasks([{ task_id: "t-ag", task_type: "local_agent" }]);
    sys("task_started", { task_id: "t-ag", tool_use_id: "ag1", task_type: "local_agent", is_backgrounded: true });
    out({ type: "user", session_id: "sess-1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "ag1", content: [{ type: "text", text: "Async agent launched successfully." }], is_error: false }] } });
    // the early result (spec P5): the main thread's turn ended, the subagent's did not
    out({ type: "result", subtype: "success", is_error: false, result: "early", num_turns: 1, total_cost_usd: 0.01, duration_ms: 1, session_id: "sess-1" });
    out({ type: "assistant", session_id: "sess-1", parent_tool_use_id: "ag1", message: { role: "assistant", content: [{ type: "tool_use", id: "sub1", name: "Bash", input: { command: "git log" } }] } });
    out({ type: "control_request", request_id: "req-a", request: { subtype: "can_use_tool", tool_name: "Bash", input: { command: "git log" }, tool_use_id: "sub1" } });
    return;
  }
  if (mode === "bgshell") {
    out({ type: "assistant", session_id: "sess-1", message: { role: "assistant", content: [{ type: "tool_use", id: "sh1", name: "Bash", input: { command: "bun run dev", run_in_background: true } }] } });
    tasks([{ task_id: "t-sh", task_type: "local_bash" }]);
    sys("task_started", { task_id: "t-sh", tool_use_id: "sh1", task_type: "local_bash", is_backgrounded: true });
    out({ type: "result", subtype: "success", is_error: false, result: "server up", num_turns: 1, total_cost_usd: 0.01, duration_ms: 1, session_id: "sess-1" });
    return;
  }
```

In `onResponse`, before the `req-1` check:

```ts
  if ((mode === "async" || mode === "quiet") && response["request_id"] === "req-a") {
    out({ type: "user", session_id: "sess-1", parent_tool_use_id: "ag1", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "sub1", content: [{ type: "text", text: "abc123 first" }], is_error: false }] } });
    sys("task_notification", { task_id: "t-ag", tool_use_id: "ag1", status: "completed" });
    tasks([]);
    if (mode === "quiet") return;
    out({ type: "assistant", session_id: "sess-1", message: { role: "assistant", content: [{ type: "text", text: "All read." }] } });
    out({ type: "result", subtype: "success", is_error: false, result: "final", num_turns: 3, total_cost_usd: 0.05, duration_ms: 9, session_id: "sess-1" });
    return;
  }
```

- [x] **Step 2: Write the failing tests** in `claudedrive.test.ts`.
  - Widen `drive`'s `mode` union to include `"async" | "bgshell" | "quiet"`.
  - `drive` gains an optional fourth argument, `{ chat?: boolean; heldGraceMs?: number }`. `chat` overrides `chat`, `action` and `verb` for that run. `heldGraceMs` is passed to `new ClaudeDriver({ command, heldGraceMs })`.

```ts
test("a result while a background subagent runs is held: stdin stays open, the prompt is answered, the real result ends the run", async () => {
  const d = await drive("async");
  const waiting = await d.until((r) => r.status === "waiting", "the subagent's prompt");
  expect(waiting.result).toBeUndefined();
  d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
  const run = await d.until(d.done, "the end");
  expect(run.status).toBe("done");
  expect(run.result?.text).toBe("final");
  const log = await d.sent();
  // the fake logged the answer, so stdin was still open when it was sent
  expect(log.some((m) => m["type"] === "control_response" && (m["response"] as { request_id?: string }).request_id === "req-a")).toBe(true);
});

test("a chat holds the early result too: no idle and no denied prompt while the subagent runs", async () => {
  const d = await drive("async", "do the thing", undefined, { chat: true });
  const waiting = await d.until((r) => r.status === "waiting", "the subagent's prompt");
  d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
  await d.until((r) => r.status === "idle" && r.result?.text === "final", "the reply's end");
});

test("a background shell never holds a result", async () => {
  const run = await (await drive("bgshell")).until((r) => r.status === "done", "the end");
  expect(run.result?.text).toBe("server up");
});

test("subagents done and no further result: the held one ends the run after the grace", async () => {
  const d = await drive("quiet", "do the thing", undefined, { heldGraceMs: 50 });
  const waiting = await d.until((r) => r.status === "waiting", "the subagent's prompt");
  d.ctx.answer(waiting.prompt?.id ?? "", { kind: "allow" });
  const run = await d.until(d.done, "the end");
  expect(run.status).toBe("done");
  expect(run.result?.text).toBe("early");
});
```

- [x] **Step 3: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/claudedrive.test.ts`
Expected: FAIL. The async job ends "done" with result "early" before the prompt. The quiet one never ends, so it times out.

- [x] **Step 4: Implement** in `ClaudeDriver`. `ClaudeOptions` gains `/** how long a held result waits once the subagents are done, for the turn they wake */ heldGraceMs?: number;`, with a default of `HELD_GRACE_MS = 60_000`.

```ts
  /** live subagent task ids (spec P7): task_type local_agent only, since a
   *  background shell may run for good (a dev server) and must not hold a
   *  run open */
  private agents = new Set<string>();
  /** the last result that came while subagents ran */
  private held: Record<string, unknown> | null = null;
  private grace: ReturnType<typeof setTimeout> | null = null;

  /** what one system message says about background work */
  private track(m: Record<string, unknown>): void {
    const sub = str(m, "subtype");
    if (sub === "background_tasks_changed" && Array.isArray(m["tasks"])) {
      // the CLI's own list is the truth: a lost notification cannot hold a run
      this.agents = new Set(
        m["tasks"].filter(isRecord).filter((t) => str(t, "task_type") === "local_agent").map((t) => str(t, "task_id")),
      );
    } else if (sub === "task_started" && str(m, "task_type") === "local_agent") this.agents.add(str(m, "task_id"));
    else if (sub === "task_notification") this.agents.delete(str(m, "task_id"));
  }
```

In `drive`'s loop, replace the `else` branch:

```ts
        } else {
          // any word from the CLI means the turn the subagents woke is running
          if (this.grace) { clearTimeout(this.grace); this.grace = null; }
          if (m["type"] === "system") this.track(m);
          if (m["type"] === "result" && this.agents.size > 0) {
            // spec P5/P6: the main thread paused for a subagent; closing
            // stdin now would fail every later permission request
            this.held = m;
            continue;
          }
          if (m["type"] === "result") this.held = null;
          this.apply(m);
          if (m["type"] === "result" && !chat) proc.stdin.end();
          // subagents done, a result held: the CLI normally starts a turn
          // with their results; if it does not, the held result is the end
          if (this.held && this.agents.size === 0 && !this.grace) {
            const held = this.held;
            this.grace = setTimeout(() => {
              this.grace = null;
              if (this.held !== held) return;
              this.held = null;
              this.apply(held);
              if (!chat) proc?.stdin.end();
            }, this.opts.heldGraceMs ?? HELD_GRACE_MS);
          }
        }
```

After the loop, before `const code = await proc.exited;`:

```ts
      if (this.grace) { clearTimeout(this.grace); this.grace = null; }
      // the process ended with a result still held: it is the run's, not a
      // failure for want of one
      if (this.held) {
        this.apply(this.held);
        this.held = null;
      }
```

Reset `agents`, `held` and `grace` at the top of `drive`. A chat's later turns reuse the same process, so do not reset them in `say`. `track` is a new private method; check that the name does not clash with `DriveCtx.track`, which is a different object, and rename it `noteBackground` if lint or readers would confuse them.

- [x] **Step 5: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/claudedrive.test.ts src/core/runner.test.ts src/core/runner-drivers.test.ts`
Expected: PASS, the old job, chat and die tests included.

- [x] **Step 6: Commit**

```bash
git add src/core/claudedrive.ts src/core/claudedrive.test.ts src/core/testdata/fake-claude.ts
git commit -m "fix(runs): a background subagent no longer ends a Claude run early"
```

This task ships on its own. It fixes runs today, before anything else in this plan lands.

---

## Task 2: the types, the answer parser and the action

**Files:**
- Modify: `src/core/types.ts:770-930`
- Modify: `src/core/driver.ts:51-62, 181-190`
- Modify: `src/core/actions.ts` (ActionSpec, ACTIONS, describeTool)
- Modify: `src/core/claudedrive.ts:118-145` (cliArgs)
- Modify: `src/server/index.ts:1073-1095` (parseAnswer), `:2726-2741` (run route)
- Test: `src/core/claudedrive.test.ts`, `src/core/actions.test.ts`, `src/core/driver.test.ts`, `src/server/runs.test.ts` (or the server test file that already covers `/api/runs/answer`; find it with `grep -l "runs/answer" src/server/*.test.ts`)

**Interfaces:**
- Produces:
  - `RUN_ACTIONS = ["ask", "chat", "propose"]`.
  - `RunTodo { id: string; subject: string; status: "pending" | "in_progress" | "completed"; active?: string }`.
  - `RunStep.parent?: string`, the step id of the Agent call it ran under.
  - `Run.proposal?: string` and `Run.todos?: RunTodo[]`.
  - `RunPrompt` arm `{ id: string; kind: "proposal"; plan: string; auto: boolean }`.
  - `PromptInput` arm `{ kind: "proposal"; plan: string; auto: boolean }`.
  - `RunAnswer` arm `{ kind: "approve"; auto: boolean }`.
  - `ActionSpec.permissionMode?: "plan"` and `DriveSpec.permissionMode?: "plan"`.
  - `ACTIONS.propose`.

- [x] **Step 1: Write the failing tests**

`claudedrive.test.ts`:

```ts
test("cliArgs starts in plan mode when the spec says, whatever yolo says", () => {
  const args = cliArgs({ allowedTools: [], maxTurns: 5, permissionMode: "plan" }, { ...DEFAULT_AGENT, yolo: true });
  expect(args[args.indexOf("--permission-mode") + 1]).toBe("plan");
});
```

`driver.test.ts`:

```ts
test("settle notes for a proposal", () => {
  const p = { kind: "proposal" as const, plan: "1. x", auto: false };
  expect(settleNote(p, { kind: "approve", auto: false })).toBe("approved the plan, asking before commands");
  expect(settleNote(p, { kind: "approve", auto: true })).toBe("approved the plan, running on its own");
  expect(settleNote(p, { kind: "deny", message: "split step 2" })).toBe("sent the plan back: split step 2");
  expect(settleNote(p, { kind: "deny" })).toBe("turned the plan down");
});
```

`actions.test.ts`:

```ts
test("propose starts in plan mode with room for plan and build", () => {
  expect(ACTIONS.propose.permissionMode).toBe("plan");
  expect(ACTIONS.propose.maxTurns).toBe(200);
  expect(ACTIONS.propose.expectsChange).toBe(true);
  expect(ACTIONS.propose.task).toContain("ExitPlanMode");
  expect(ACTIONS.propose.task).toContain("subagents");
});
```

Move `parseAnswer` out of `src/server/index.ts:1073` into a new `src/server/answers.ts`, since `index.ts` is very long. Export it there and import it back into `index.ts`. Then test it directly in `src/server/answers.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { parseAnswer } from "./answers";

describe("parseAnswer", () => {
  test("approve needs a boolean auto", () => {
    expect(parseAnswer({ kind: "approve", auto: true })).toEqual({ kind: "approve", auto: true });
    expect(parseAnswer({ kind: "approve" })).toBeNull();
  });
  test("a deny keeps the user's words, trimmed, and refuses a huge one", () => {
    expect(parseAnswer({ kind: "deny", message: "  split step 2 " })).toEqual({ kind: "deny", message: "split step 2" });
    expect(parseAnswer({ kind: "deny", message: "   " })).toEqual({ kind: "deny" });
    expect(parseAnswer({ kind: "deny", message: "x".repeat(20_001) })).toBeNull();
  });
  test("the old shapes still parse", () => {
    expect(parseAnswer({ kind: "allow" })).toEqual({ kind: "allow" });
    expect(parseAnswer({ kind: "allow-all" })).toEqual({ kind: "allow-all" });
    expect(parseAnswer({ kind: "answers", answers: { q: "a" } })).toEqual({ kind: "answers", answers: { q: "a" } });
  });
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/ src/server/answers.test.ts`
Expected: FAIL on the type errors and the missing action.

- [x] **Step 3: Implement**

`types.ts`:

```ts
export const RUN_ACTIONS = ["ask", "chat", "propose"] as const;

/** One line of the agent's own checklist (Claude's TaskCreate or TodoWrite). */
export interface RunTodo {
  /** the agent's id: "3" from "Task #3 created", or the index for TodoWrite */
  id: string;
  subject: string;
  status: "pending" | "in_progress" | "completed";
  /** the present-tense form the agent gave, shown while in progress */
  active?: string;
}
```

Add to `RunStep`: `/** the step id of the Agent call this ran under, for a subagent's steps */ parent?: string;`.

Add to `Run`:
- `/** the plan the agent proposed last (propose runs) */ proposal?: string;`
- `/** the agent's checklist as it last stood */ todos?: RunTodo[];`

Widen `RunPrompt`:

```ts
export type RunPrompt =
  | (PermissionAsk & { id: string })
  | { id: string; kind: "question"; questions: RunQuestion[] }
  /** a plan the agent wants approved before it builds (Claude's
   *  ExitPlanMode); `auto` says whether "run on its own" may be offered */
  | { id: string; kind: "proposal"; plan: string; auto: boolean };
```

Add `| { kind: "approve"; auto: boolean }` to `RunAnswer`, with the comment "a proposal approved; `auto` runs it without asking".

`driver.ts`:
- `export type PromptInput = PermissionAsk | { kind: "question"; questions: RunQuestion[] } | { kind: "proposal"; plan: string; auto: boolean };`
- `DriveSpec` gains `/** start Claude in this permission mode instead of the agent's own */ permissionMode?: "plan";`.
- `settleNote` gains a branch before the permission lines:

```ts
  if (prompt.kind === "proposal") {
    if (a.kind === "approve") return a.auto ? "approved the plan, running on its own" : "approved the plan, asking before commands";
    if (a.kind === "allow") return "approved the plan, asking before commands";
    return a.kind === "deny" && a.message ? `sent the plan back: ${a.message}` : "turned the plan down";
  }
```

Typecheck now flags every switch over `prompt.kind` and `a.kind` that misses the new arms: `inbox.ts`, `feed.ts`, `Prompts.tsx`, `codexrun.ts`. Add the minimal branch each needs. Tasks 3 and 6 fill in the real UI.

`claudedrive.ts` `cliArgs`: `spec.permissionMode ?? (agent.yolo ? "bypassPermissions" : "default"),`.

`actions.ts`:
- `ActionSpec` gains `/** Claude's starting permission mode, over the agent's yolo */ permissionMode?: "plan";`.
- In `describeTool`, add titles: `TaskCreate` → `todo: ${subject}`, `TaskUpdate` → `todo ${taskId}: ${status}`.

```ts
  propose: {
    label: "plan, then build…",
    verb: "plan",
    blurb:
      "The repo's agent reads the code and proposes a step-by-step plan without changing anything. You approve it, send it back with notes, or turn it down. Once approved it builds the plan in the same session, with a checklist you can watch.",
    notePlaceholder: "what should be built?",
    noteRequired: true,
    allowedTools: [...READ, ...GIT_READ, ...BUN],
    // per reply, and one reply covers both the plan and the build
    maxTurns: 200,
    progress: "planning",
    expectsChange: true,
    mode: "ask",
    permissionMode: "plan",
    task: `Task: plan, then build what the note below asks for. You start in plan mode. Read what you need, using subagents for wide reading, then present a step-by-step plan with ExitPlanMode. Change nothing before the plan is approved. The user may send the plan back with notes; revise it and present it again. Once it is approved: track each step of the plan with your task tool, hand steps that do not depend on each other to subagents running in parallel, run the repository's own checks (typecheck, lint, tests and build, as its scripts name them) at the end, and do not commit unless the note asks you to.`,
  },
```

Server: in the `parseAnswer` you move to `src/server/answers.ts`:

```ts
  if (kind === "approve") {
    const auto = (v as { auto?: unknown }).auto;
    return typeof auto === "boolean" ? { kind, auto } : null;
  }
  if (kind === "deny") {
    const m = (v as { message?: unknown }).message;
    if (m === undefined) return { kind };
    if (typeof m !== "string" || m.length > 20_000) return null;
    return m.trim() ? { kind, message: m.trim() } : { kind };
  }
  if (kind === "allow-all") return { kind };
```

In the run route, after `agentFor`:

```ts
      if (b.action === "propose" && agent.harness !== "claude") return json({ error: "plan, then build needs Claude Code" }, 400);
```

- [x] **Step 4: Run the tests and watch them pass**

Run: `bun run typecheck && env -u TMUX SHELL=/bin/bash bun test src/core/ src/server/`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src ui/src
git commit -m "feat(runs): the propose action and the proposal prompt types"
```

---

## Task 3: ExitPlanMode becomes a proposal; approval switches the mode

**Files:**
- Modify: `src/core/testdata/fake-claude.ts` (mode `propose`)
- Modify: `src/core/claudedrive.ts` (`request`, incoming `control_response`, `permission`)
- Test: `src/core/claudedrive.test.ts`

**Interfaces:**
- Consumes: the Task 2 types.
- Produces:
  - `ClaudeDriver.request(subtype: string, body: Record<string, unknown>, ms?: number): Promise<{ ok: true; response: Record<string, unknown> } | { ok: false; error: string }>`, private.
  - `DriveCtx.proposal(plan: string): void`, implemented in `RunCtx`, which sets `run.proposal` and broadcasts.

- [x] **Step 1: Add the `propose` mode to the fake.**
- `onUser` emits `TaskCreate` tool_use `tc1` `{ subject: "Read the code", activeForm: "Reading the code" }`, its tool_result "Task #1 created successfully: Read the code", then:

```ts
    out({ type: "control_request", request_id: "req-p1", request: { subtype: "can_use_tool", tool_name: "ExitPlanMode", input: { plan: "# Plan\n1. add it" }, tool_use_id: "ep1" } });
```

- The stdin loop also handles host requests:

```ts
    else if (m["type"] === "control_request") {
      const r = (m["request"] ?? {}) as Record<string, unknown>;
      // spec P8: bypass needs the launch flag, and the refusal names why
      const bypassBlocked = r["mode"] === "bypassPermissions" && (!process.argv.includes("--allow-dangerously-skip-permissions") || process.env["FAKE_CLAUDE_REFUSE_BYPASS"] === "1");
      if (r["subtype"] === "set_permission_mode" && bypassBlocked) {
        out({ type: "control_response", response: { subtype: "error", request_id: m["request_id"], error: "Cannot set permission mode to bypassPermissions because the session was not launched with --dangerously-skip-permissions", error_code: "bypass_not_launched" } });
      } else if (r["subtype"] === "set_permission_mode" && process.env["FAKE_CLAUDE_REFUSE_MODE"] !== "1") {
        out({ type: "control_response", response: { subtype: "success", request_id: m["request_id"], response: { mode: r["mode"] } } });
        out({ type: "system", subtype: "status", permissionMode: r["mode"], session_id: "sess-1" });
      } else {
        out({ type: "control_response", response: { subtype: "error", request_id: m["request_id"], error: "refused" } });
      }
    }
```

- `onResponse` in `propose` mode:
  - On a deny of `req-p1`, emit `req-p2` with `{ plan: "# Plan v2\n1. add it\n2. test it" }`.
  - On an allow of `req-p1` or `req-p2`, emit:
    - the tool_result "User has approved your plan. You can now start coding.";
    - `TaskUpdate` tool_use `tu1` `{ taskId: "1", status: "completed" }` and its result "Updated task #1 status";
    - a result whose text is `approved`.
  - On any other deny, emit a result whose text is `declined`.

- [x] **Step 2: Write the failing tests**

```ts
const AGENT_YOLO = { ...AGENT, yolo: true };

test("cliArgs: a plan-mode run on a yolo agent may switch to bypass later", () => {
  const yolo = cliArgs({ allowedTools: [], maxTurns: 5, permissionMode: "plan" }, { ...DEFAULT_AGENT, yolo: true });
  expect(yolo).toContain("--allow-dangerously-skip-permissions");
  expect(cliArgs({ allowedTools: [], maxTurns: 5, permissionMode: "plan" }, { ...DEFAULT_AGENT, yolo: false })).not.toContain("--allow-dangerously-skip-permissions");
  expect(cliArgs({ allowedTools: [], maxTurns: 5 }, { ...DEFAULT_AGENT, yolo: true })).not.toContain("--allow-dangerously-skip-permissions");
});

test("ExitPlanMode is a proposal; approve allows first, then sets acceptEdits (spec P8)", async () => {
  const d = await drive("propose");
  const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
  expect(w.prompt).toMatchObject({ kind: "proposal", plan: "# Plan\n1. add it", auto: false });
  expect(w.proposal).toBe("# Plan\n1. add it");
  d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: true }); // auto refused: not yolo
  const run = await d.until(d.done, "the end");
  expect(run.result?.text).toBe("approved");
  const log = await d.sent();
  const modeAt = log.findIndex((m) => m["type"] === "control_request" && (m["request"] as { subtype?: string }).subtype === "set_permission_mode");
  const allowAt = log.findIndex((m) => m["type"] === "control_response" && (m["response"] as { request_id?: string }).request_id === "req-p1");
  expect(modeAt).toBeGreaterThan(-1);
  expect((log[modeAt]?.["request"] as { mode?: string }).mode).toBe("acceptEdits");
  // the allow resets the session to default, so the switch must come after it
  expect(allowAt).toBeLessThan(modeAt);
});

test("approve on a yolo agent with auto runs on its own", async () => {
  const d = await drive("propose", "build it", undefined, { agent: AGENT_YOLO });
  const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
  expect(w.prompt).toMatchObject({ auto: true });
  d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: true });
  await d.until(d.done, "the end");
  const log = await d.sent();
  const req = log.find((m) => m["type"] === "control_request") as { request: { mode: string } } | undefined;
  expect(req?.request.mode).toBe("bypassPermissions");
  expect((log[0] as { argv: string[] }).argv).toContain("--allow-dangerously-skip-permissions");
});

test("a refused bypass falls back to acceptEdits, with a note", async () => {
  const d = await drive("propose", "build it", undefined, { agent: AGENT_YOLO, env: { FAKE_CLAUDE_REFUSE_BYPASS: "1" } });
  const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
  d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: true });
  const run = await d.until(d.done, "the end");
  const modes = (await d.sent()).filter((m) => m["type"] === "control_request").map((m) => (m["request"] as { mode?: string }).mode);
  expect(modes).toEqual(["bypassPermissions", "acceptEdits"]);
  expect(run.steps.some((s) => s.kind === "note" && s.text?.startsWith("could not run on its own"))).toBe(true);
});

test("revise sends the note back and the next proposal replaces the last", async () => {
  const d = await drive("propose");
  const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
  d.ctx.answer(w.prompt?.id ?? "", { kind: "deny", message: "add a test step" });
  const w2 = await d.until((r) => r.prompt?.kind === "proposal" && r.prompt.id !== w.prompt?.id, "the second proposal");
  expect(w2.proposal).toContain("Plan v2");
  const log = await d.sent();
  expect(responseTo(log, "req-p1")?.response.response).toEqual({ behavior: "deny", message: "add a test step" });
});

test("a refused mode switch still approves, with a note", async () => {
  const d = await drive("propose", "build it", undefined, { env: { FAKE_CLAUDE_REFUSE_MODE: "1" } });
  const w = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
  d.ctx.answer(w.prompt?.id ?? "", { kind: "approve", auto: false });
  const run = await d.until(d.done, "the end");
  expect(run.result?.text).toBe("approved");
  expect(run.steps.some((s) => s.kind === "note" && s.text?.startsWith("could not switch to acceptEdits"))).toBe(true);
});

test("a stop while the proposal waits ends the run stopped", async () => {
  const d = await drive("propose");
  await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
  d.ctx.denyAll();
  d.driver.stop();
  const run = await d.until(d.done, "the end");
  expect(run.status).toBe("stopped");
});
```

`drive`'s options gain `agent?` and `env?`. Check how `runner.ts` marks `stopping` before `driver.stop()`. If `RunCtx` needs a `stopping` flag set for `exitOutcome`, call the same method the Runner calls instead of `denyAll` plus `stop`.

- [x] **Step 3: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/claudedrive.test.ts`
Expected: FAIL. ExitPlanMode shows as a permission.

- [x] **Step 4: Implement** in `ClaudeDriver`:

```ts
  /** our own control requests to the CLI, waiting on its control_response */
  private asked = new Map<string, (r: { ok: true; response: Record<string, unknown> } | { ok: false; error: string }) => void>();
  private asks = 0;

  /** A control request from canopy to the CLI (spec P3), settled by its
   *  control_response, an error, or `ms` without one. */
  private request(subtype: string, body: Record<string, unknown>, ms = 10_000) {
    const id = `canopy-${++this.asks}`;
    return new Promise<{ ok: true; response: Record<string, unknown> } | { ok: false; error: string }>((resolve) => {
      const timer = setTimeout(() => {
        this.asked.delete(id);
        resolve({ ok: false, error: "no answer" });
      }, ms);
      this.asked.set(id, (r) => {
        clearTimeout(timer);
        resolve(r);
      });
      void this.send({ type: "control_request", request_id: id, request: { subtype, ...body } });
    });
  }
```

In `drive`'s loop, before the `control_request` branch:

```ts
        if (m["type"] === "control_response") {
          const r = isRecord(m["response"]) ? m["response"] : {};
          const settle = this.asked.get(str(r, "request_id"));
          if (settle) {
            this.asked.delete(str(r, "request_id"));
            settle(str(r, "subtype") === "success" ? { ok: true, response: isRecord(r["response"]) ? r["response"] : {} } : { ok: false, error: str(r, "error") || "refused" });
          }
          continue;
        }
```

The allow must reach the CLI before the mode switch (spec P8), so `permission` cannot send the switch itself. It leaves a follow-up that `control()` runs once the response is written. Add a field:

```ts
  /** what to send once the current control response is on the wire: the
   *  mode switch after a plan's approval, which the allow would undo */
  private afterReply: (() => Promise<void>) | null = null;
```

In `control()`, after `await this.send({ type: "control_response", ... })`:

```ts
    const after = this.afterReply;
    this.afterReply = null;
    if (after) await after();
```

In `permission`, before the `AskUserQuestion` branch:

```ts
    if (tool === "ExitPlanMode") {
      const plan = str(input, "plan").trim();
      if (!plan) return { behavior: "deny", message: "The plan came through empty. Present it again with ExitPlanMode." };
      ctx.proposal(plan);
      const a = await ctx.ask({ kind: "proposal", plan, auto: ctx.agent.yolo }, requestId);
      if (a.kind === "approve" || a.kind === "allow") {
        // never past what the agent's settings allow: auto needs yolo
        const auto = a.kind === "approve" && a.auto && ctx.agent.yolo;
        this.afterReply = async () => {
          if (auto) {
            const bypass = await this.request("set_permission_mode", { mode: "bypassPermissions" });
            if (bypass.ok) return;
            ctx.note(`could not run on its own (${bypass.error}); asking before commands instead`);
          }
          const edits = await this.request("set_permission_mode", { mode: "acceptEdits" });
          if (!edits.ok) ctx.note(`could not switch to acceptEdits (${edits.error}); every edit will ask`);
        };
        return { behavior: "allow", updatedInput: input };
      }
      return {
        behavior: "deny",
        message: (a.kind === "deny" && a.message) || "The user turned the plan down. Stop here and summarize what you found.",
      };
    }
```

`cliArgs` adds the launch flag that makes the later bypass switch possible (spec P8), only for a plan-mode start on a yolo agent:

```ts
    ...(spec.permissionMode === "plan" && agent.yolo ? ["--allow-dangerously-skip-permissions"] : []),
```

`DriveCtx` gains `proposal(plan: string): void`, which sets `run.proposal` and broadcasts. Implement it in `RunCtx` next to `session`.

When the user writes nothing, the deny's message is the default above. Give the revise button in the UI its own default, "Revise the plan.", so a revise with no note never reads as "turned down". See Task 6.

- [x] **Step 5: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/claudedrive.test.ts src/core/driver.test.ts`
Expected: PASS.

- [x] **Step 6: Commit**

```bash
git add src/core
git commit -m "feat(runs): ExitPlanMode is a proposal, and approval switches the mode"
```

---

## Task 4: todos and subagent parentage

**Files:**
- Create: `src/core/todos.ts`, `src/core/todos.test.ts`
- Modify: `src/core/claudedrive.ts` (`apply`)
- Modify: `src/core/driver.ts` (`DriveCtx.todos`)
- Test: `src/core/claudedrive.test.ts`

**Interfaces:**
- Produces:
  - `todoCreated(todos: readonly RunTodo[], input: Record<string, unknown>, resultText: string): RunTodo[]`
  - `todoUpdated(todos: readonly RunTodo[], input: Record<string, unknown>): RunTodo[]`
  - `todoWritten(input: Record<string, unknown>): RunTodo[] | null`
  - `TODO_TOOLS: ReadonlySet<string>`, which holds TaskCreate, TaskUpdate, TaskList, TaskGet and TodoWrite.
  - `DriveCtx.todos(next: RunTodo[]): void`.

- [x] **Step 1: Write the failing tests**, `src/core/todos.test.ts`:

```ts
import { describe, expect, test } from "bun:test";
import { todoCreated, todoUpdated, todoWritten } from "./todos";

describe("the agent's checklist", () => {
  test("a create takes its id from the result text", () => {
    const t = todoCreated([], { subject: "Edit math.ts", activeForm: "Editing math.ts" }, "Task #4 created successfully: Edit math.ts");
    expect(t).toEqual([{ id: "4", subject: "Edit math.ts", status: "pending", active: "Editing math.ts" }]);
  });
  test("a result without an id adds nothing", () => {
    expect(todoCreated([], { subject: "x" }, "something else")).toEqual([]);
  });
  test("an update moves the status; deleted drops it; an unknown id is ignored", () => {
    const one = [{ id: "1", subject: "a", status: "pending" as const }];
    expect(todoUpdated(one, { taskId: "1", status: "in_progress" })[0]?.status).toBe("in_progress");
    expect(todoUpdated(one, { taskId: "1", status: "deleted" })).toEqual([]);
    expect(todoUpdated(one, { taskId: "9", status: "completed" })).toEqual(one);
    expect(todoUpdated(one, { taskId: "1", status: "bogus" })).toEqual(one);
  });
  test("TodoWrite replaces the list, ids by position", () => {
    expect(todoWritten({ todos: [{ content: "a", status: "completed", activeForm: "Aing" }, { content: "b", status: "pending" }] })).toEqual([
      { id: "1", subject: "a", status: "completed", active: "Aing" },
      { id: "2", subject: "b", status: "pending" },
    ]);
    expect(todoWritten({ todos: "nope" })).toBeNull();
  });
});
```

In `claudedrive.test.ts`, using the `propose` fake:

```ts
test("the checklist follows TaskCreate and TaskUpdate", async () => {
  const d = await drive("propose");
  const w = await d.until((r) => (r.todos?.length ?? 0) > 0, "the first todo");
  expect(w.todos).toEqual([{ id: "1", subject: "Read the code", status: "pending", active: "Reading the code" }]);
  const asked = await d.until((r) => r.prompt?.kind === "proposal", "the proposal");
  d.ctx.answer(asked.prompt?.id ?? "", { kind: "approve", auto: false });
  const run = await d.until(d.done, "the end");
  expect(run.todos?.[0]?.status).toBe("completed");
});
```

Using the `async` fake:

```ts
test("a subagent's steps carry their Agent step as parent", async () => {
  const d = await drive("async");
  const w = await d.until((r) => r.status === "waiting", "the prompt");
  const agentStep = w.steps.find((s) => s.tool?.name === "Agent");
  const child = w.steps.find((s) => s.tool?.name === "Bash");
  expect(agentStep).toBeDefined();
  expect(child?.parent).toBe(agentStep?.id);
  expect(agentStep?.parent).toBeUndefined();
  d.ctx.answer(w.prompt?.id ?? "", { kind: "allow" });
  await d.until(d.done, "the end");
});
```

- [x] **Step 2: Run them and watch them fail**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/todos.test.ts src/core/claudedrive.test.ts`
Expected: FAIL, the module is missing.

- [x] **Step 3: Implement** `src/core/todos.ts`:

```ts
/** The agent's own checklist, read off its todo tools (spec P4): Claude
 *  Code's TaskCreate/TaskUpdate, and the TodoWrite of older versions.
 *  Pure and browser-safe. */
import type { RunTodo } from "./types";

export const TODO_TOOLS: ReadonlySet<string> = new Set(["TaskCreate", "TaskUpdate", "TaskList", "TaskGet", "TodoWrite"]);

const STATUSES = ["pending", "in_progress", "completed"] as const;
const isStatus = (v: unknown): v is RunTodo["status"] => typeof v === "string" && (STATUSES as readonly string[]).includes(v);
const text = (o: Record<string, unknown>, k: string): string => (typeof o[k] === "string" ? (o[k] as string) : "");

export function todoCreated(todos: readonly RunTodo[], input: Record<string, unknown>, resultText: string): RunTodo[] {
  const id = /Task #(\d+) created/.exec(resultText)?.[1];
  const subject = text(input, "subject").trim();
  if (!id || !subject || todos.some((t) => t.id === id)) return [...todos];
  const active = text(input, "activeForm").trim();
  return [...todos, { id, subject, status: "pending", ...(active ? { active } : {}) }];
}

export function todoUpdated(todos: readonly RunTodo[], input: Record<string, unknown>): RunTodo[] {
  const id = text(input, "taskId") || (typeof input["taskId"] === "number" ? String(input["taskId"]) : "");
  if (!todos.some((t) => t.id === id)) return [...todos];
  if (input["status"] === "deleted") return todos.filter((t) => t.id !== id);
  const subject = text(input, "subject").trim();
  return todos.map((t) =>
    t.id !== id ? t : { ...t, ...(isStatus(input["status"]) ? { status: input["status"] } : {}), ...(subject ? { subject } : {}) },
  );
}

export function todoWritten(input: Record<string, unknown>): RunTodo[] | null {
  const raw = input["todos"];
  if (!Array.isArray(raw)) return null;
  const out: RunTodo[] = [];
  raw.forEach((t, i) => {
    if (!t || typeof t !== "object") return;
    const o = t as Record<string, unknown>;
    const subject = text(o, "content").trim();
    if (!subject) return;
    const active = text(o, "activeForm").trim();
    out.push({ id: String(i + 1), subject, status: isStatus(o["status"]) ? o["status"] : "pending", ...(active ? { active } : {}) });
  });
  return out;
}
```

The `as string` in `text` follows a `typeof` check. If lint flags it, write it as `const v = o[k]; return typeof v === "string" ? v : "";`.

In `ClaudeDriver.apply`:
- Read `const parentUse = str(m, "parent_tool_use_id");` and `const parent = parentUse ? this.tools.get(parentUse)?.id : undefined;`.
- Pass `...(parent ? { parent } : {})` into every `ctx.step` in the block.
- Keep `this.todoInputs = new Map<string, { name: string; input: Record<string, unknown> }>()` and `private todos: RunTodo[] = []`.
- On `tool_use`, when `!parentUse && TODO_TOOLS.has(name)`:
  - for `TodoWrite`, `const next = todoWritten(input); if (next) { this.todos = next; ctx.todos(next); }`;
  - for anything else, `this.todoInputs.set(id, { name, input })`.
- On `tool_result` that is not an error, look up `this.todoInputs.get(tool_use_id)`:
  - for `TaskCreate`, `this.todos = todoCreated(this.todos, input, text)`;
  - for `TaskUpdate`, `this.todos = todoUpdated(this.todos, input)`;
  - then `ctx.todos(this.todos)`.

`DriveCtx.todos(next)` sets `run.todos = next` and broadcasts. Implement it in `RunCtx`.

- [x] **Step 4: Run the tests and watch them pass**

Run: `env -u TMUX SHELL=/bin/bash bun test src/core/`
Expected: PASS.

- [x] **Step 5: Commit**

```bash
git add src/core
git commit -m "feat(runs): the agent's checklist and subagent steps under their call"
```

---

## Task 5: the server route end to end

**Files:**
- Modify: `src/server/index.ts` (run route already refuses Codex, Task 2; workspace run route if plan 1 shipped)
- Test: the server runs test file

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write the failing test.** Start the server with a Claude driver whose command is the fake in `propose` mode, the way `runner.test.ts` or `remember.test.ts` stands up a fake `claude`. Then:

```ts
test("propose: start, the proposal over the API, approve, done", async () => {
  const start = await call("POST", `/api/repos/run?id=${id}`, { action: "propose", note: "add a function" });
  expect(start.status).toBe(201);
  const run = await start.json();
  const waiting = await until(async () => {
    const r = (await (await call("GET", "/api/runs")).json()).find((x: { id: string }) => x.id === run.id);
    return r?.prompt?.kind === "proposal" ? r : null;
  });
  const ans = await call("POST", "/api/runs/answer", { id: run.id, promptId: waiting.prompt.id, answer: { kind: "approve", auto: false } });
  expect(ans.status).toBe(200);
  // ... until done, result text "approved", todos[0].status "completed"
});

test("propose on a Codex repo is refused", async () => {
  // route the repo's job role to codex through the agents config, as agents.test.ts does
  const r = await call("POST", `/api/repos/run?id=${id}`, { action: "propose", note: "x" });
  expect(r.status).toBe(400);
  expect((await r.json()).error).toBe("plan, then build needs Claude Code");
});
```

If plan 1 has shipped, also start `POST /api/workspaces/run` with `action: "propose"` and assert 201. `isRunAction` already accepts it, so this only proves the route did not narrow its action list.

- [ ] **Step 2: Run, fix what fails, run again**

Run: `env -u TMUX SHELL=/bin/bash bun test src/server/`
Expected: PASS once the route accepts `propose` and the answer reaches the driver.

- [ ] **Step 3: Commit**

```bash
git add src/server
git commit -m "test(runs): propose end to end through the API"
```

---

## Task 6: the UI

**Files:**
- Modify: `ui/src/components/Prompts.tsx:248-290`
- Modify: `ui/src/runs.ts` and `ui/src/runs.test.ts`
- Modify: `ui/src/components/RunSheet.tsx:256-380` (`Timeline`), `:543-584` (`Step`)
- Modify: `ui/src/components/RepoMenu.tsx:31, 400-440`
- Modify: `ui/src/inbox.ts:190-215`, `ui/src/feed.ts:298`
- Modify: `ui/src/styles.css`

**Interfaces:**
- Produces:
  - `nestSteps(steps: readonly RunStep[]): StepNode[]`, where `StepNode = { step: RunStep; kids: RunStep[] }`.
  - `hideTodoSteps(steps: readonly RunStep[], hasTodos: boolean): RunStep[]`.
  - `ProposalForm({ plan, auto, onApprove(auto: boolean), onRevise(note: string), onDecline() })`.

- [ ] **Step 1: Write the failing test**, in `ui/src/runs.test.ts`:

```ts
import { hideTodoSteps, nestSteps } from "./runs";

const s = (id: string, extra: Partial<RunStep> = {}): RunStep => ({ id, at: 0, kind: "tool", tool: { name: "Bash", title: id, status: "ok" }, ...extra });

test("subagent steps fold under their Agent step, in order", () => {
  const steps = [s("a", { tool: { name: "Agent", title: "agent: read", status: "running" } }), s("b", { parent: "a" }), s("c"), s("d", { parent: "a" })];
  expect(nestSteps(steps).map((n) => [n.step.id, n.kids.map((k) => k.id)])).toEqual([["a", ["b", "d"]], ["c", []]]);
});

test("a step whose parent is unknown stays at the top level", () => {
  expect(nestSteps([s("x", { parent: "gone" })]).map((n) => n.step.id)).toEqual(["x"]);
});

test("todo tool steps hide only when the checklist shows", () => {
  const steps = [s("t", { tool: { name: "TaskCreate", title: "todo: a", status: "ok" } }), s("b")];
  expect(hideTodoSteps(steps, true).map((x) => x.id)).toEqual(["b"]);
  expect(hideTodoSteps(steps, false).map((x) => x.id)).toEqual(["t", "b"]);
});
```

- [ ] **Step 2: Run it and watch it fail**

Run: `env -u TMUX SHELL=/bin/bash bun test ui/src/runs.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement**

`ui/src/runs.ts`:

```ts
export interface StepNode { step: RunStep; kids: RunStep[] }

/** A subagent's steps under the Agent call that started it, so parallel
 *  subagents read as lanes rather than one interleaved list. */
export function nestSteps(steps: readonly RunStep[]): StepNode[] {
  const top: StepNode[] = [];
  const byId = new Map<string, StepNode>();
  for (const step of steps) {
    const home = step.parent ? byId.get(step.parent) : undefined;
    if (home) home.kids.push(step);
    else {
      const node = { step, kids: [] };
      top.push(node);
      byId.set(step.id, node);
    }
  }
  return top;
}

/** the todo tools' own steps, gone when the checklist above says it better */
export const hideTodoSteps = (steps: readonly RunStep[], hasTodos: boolean): RunStep[] =>
  hasTodos ? steps.filter((x) => !(x.tool && TODO_TOOLS.has(x.tool.name))) : [...steps];
```

`TODO_TOOLS` comes from `src/core/todos.ts`, which is browser-safe.

`Prompts.tsx`, in `RunPromptForm`, a `proposal` branch before the question fallthrough:

```tsx
  if (prompt.kind === "proposal") {
    return (
      <ProposalForm
        key={id}
        plan={prompt.plan}
        auto={prompt.auto}
        who={agentWord(harness)}
        onApprove={(auto) => onAnswer({ kind: "approve", auto }, id)}
        onRevise={(note) => onAnswer({ kind: "deny", message: note.trim() || "Revise the plan." }, id)}
        onDecline={() => onAnswer({ kind: "deny" }, id)}
      />
    );
  }
```

`ProposalForm` contains:
- the heading `${who} proposes a plan`;
- `<pre className="proposal-text">{plan}</pre>`, scrollable, at most 50vh;
- a primary button "approve, ask before commands";
- when `auto` is true, a second button "approve, run on its own";
- a textarea "what should change?" with a "revise" button;
- a quiet "turn it down" link button.

Enter in the textarea does not submit, because a plan note is multi-line. Cmd/Ctrl+Enter sends the revise. Follow `Questions`' existing layout and classes for the button row.

`RunSheet.tsx`:
- Above the `Timeline`'s list, when `run.todos?.length`, render this checklist:

```tsx
<ol className="todos" aria-label="The agent's checklist">
  {run.todos.map((t) => (
    <li key={t.id} className={`todo t-${t.status}`}>
      <span className="todo-mark" aria-hidden="true" />
      {t.status === "in_progress" && t.active ? t.active : t.subject}
    </li>
  ))}
</ol>
```

- Below it, when `run.proposal` is set and `run.prompt?.kind !== "proposal"`, render `<details className="proposal"><summary>the approved plan</summary><pre className="proposal-text">{run.proposal}</pre></details>`.
- The timeline maps `nestSteps(hideTodoSteps(run.steps, !!run.todos?.length))`. A node with kids renders its `Step` followed by `<details className="step-kids" open={kidRunning}><summary>{n.kids.length} steps inside</summary><ol>{kids as Step}</ol></details>`, where `kidRunning` is true while any kid's tool status is `running`. Do not go by the node's own status: an async `Agent` step turns `ok` the moment it launches (spec P5), so its own status says nothing about its children.

`RepoMenu.tsx`:
- `const JOBS = ["ask", "propose"] as const;`.
- Each job's `check` gains a branch:

```ts
                    : action === "propose" && jobAgent.harness !== "claude"
                      ? { ok: false as const, why: "plan, then build needs Claude Code" }
```

If plan 1 (workspace primary) has shipped, the workspace gear in `TopBar.tsx` gains "plan, then build in workspace…", which runs `openWsPlan(w.name, "propose")`.

`inbox.ts` `runItem`:
- For a proposal: `title: "plan to approve"`, `detail: p.plan.slice(0, 400)`, `kind: "permission"`. Use the existing kind so the inbox layout needs no new arm; the click opens the run sheet, where the real form is.
- `inbox.ts:41`'s union stays as it is. If a later reviewer wants a distinct kind, that is a separate change.
- Check `Inbox.tsx:267`. If it renders `RunPromptForm` inline, the proposal form shows there too, which is fine.

`feed.ts:298`: `run.prompt.kind === "proposal" ? "has a plan to approve" : ...`.

`styles.css`:
- `.todos`: no box, one line per item.
- `.todo-mark`: a 10px ring, filled `--moss` when `t-completed` and half-filled `--sky` when `t-in_progress`, with a strikethrough on completed text in the faint ink.
- `.proposal-text`: `white-space: pre-wrap; max-block-size: 50vh; overflow: auto`.
- `.step-kids`: indented under its step with a 1px left rule.
- Any motion goes only under `@media (prefers-reduced-motion: no-preference)`.

- [ ] **Step 4: Gates and a browser check**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

Then start a scratch canopy server (memory note "Scratch canopy server for UI checks") on a scratch repo with a `math.ts`, and drive it with playwright-cli:
1. Open the repo menu, choose "plan, then build…" and write "add an add(a,b) function and a bun test".
2. Wait for the proposal. Check that the plan shows, and that "run on its own" is present only when the repo's agent has yolo.
3. Revise with "also export it from index.ts". Check that a second proposal replaces the first.
4. Approve. Watch the checklist tick live and an Agent step fold its children.
5. Check that the run ends done with `math.test.ts` written and nothing committed.
6. At 390px wide, check that the proposal form fits and the buttons stack.

This step spends real Claude usage on Eric's login, so keep the repo tiny.

- [ ] **Step 5: Commit**

```bash
git add ui/src
git commit -m "feat(ui): plan, then build: the proposal, the checklist, nested subagent steps"
```

---

## Task 7: the architecture note

**Files:**
- Modify: `docs/architecture.md`, sections "src/core" (runs and drivers) and "ui/".

- [ ] **Step 1: Write the notes.** Cover:
  - The background count and the held result (P5, P6), and why closing stdin early breaks permission requests.
  - `propose`: plan mode and the proposal prompt. Approval sends `set_permission_mode` (`acceptEdits`, or `bypassPermissions` only with yolo) before allowing `ExitPlanMode`.
  - `run.todos` from TaskCreate and TaskUpdate (or TodoWrite), main thread only.
  - `RunStep.parent` from `parent_tool_use_id`.
  - The names `propose`, `proposal` and `todos`, and why they avoid "plan" and "tasks".
  - Correct `CLAUDE.md`'s runs gotcha. It says "Stdin must stay open until the `result` message (the CLI exits once it is closed)", which spec P5 shows is wrong while a subagent runs. Change it to say stdin stays open until a `result` that arrives with no `local_agent` task live, and name the held result and its grace.

- [ ] **Step 2: Gates**

Run: `bun run typecheck && bun run lint && env -u TMUX SHELL=/bin/bash bun test && bun run build`
Expected: all pass.

- [ ] **Step 3: Commit**

```bash
git add docs/architecture.md CLAUDE.md
git commit -m "docs: plan, then build, and background subagents in runs"
```
