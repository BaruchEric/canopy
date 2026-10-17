# A coordinator that splits a goal into runs (FR-010)

FR-010 asks for one chat that takes a goal, proposes the tasks, and starts
a run per task, each shown as a card with a live one-line status. The
coordinator gets its own model and effort, low by default, since it mostly
routes work. It builds on the landing queue (FR-012, FR-013) and, once it
ships, the PR watch (FR-011), so a coordinator's runs land or open PRs the
way any branch run does.

## Where things stand (2026-10-16)

- **No run starts another.** `Run` has no parent field and there is no
  `canopy run` command. Ordinary runs get only `CANOPY_RUN`, `CANOPY_REPO`
  and `CANOPY_BACKEND` (`runEnv`, `runner.ts`), and Claude runs start with
  no MCP servers (`--strict-mcp-config`).
- **The ranger already coordinates through the API.** `lib/ranger.md`
  tells it to `curl -X POST "$CANOPY_API/api/repos/run?id=<repo>"` with
  `{"action":"ask","note":…}`, read `/api/runs`, and set a `run` wake to
  hear when one ends (`ranger.ts`). That is the pattern this spec reuses.
- **Chats stay open.** A chat run keeps stdin open after each result
  (`ClaudeDriver.say`, `POST /api/runs/say`), status `idle` between turns.
- **Propose plans, then builds.** `ACTIONS.propose` starts in plan mode,
  keeps the plan in `Run.proposal`, and settles it through
  `Run.proposalState`. It runs on its own branch by default.
- **Fleets cap concurrency.** `FLEET_CONCURRENCY = 3` in `flow.ts`.
- **Routing has roles.** `AGENT_ROLES` is `shell, chat, job, flow,
  suggest` (`route.ts`), resolved per repo through profiles into
  `AgentSettings` (harness, model, effort, yolo).

## The coordinator

A new run action, `coordinate`: a chat run at a repo (or at a workspace,
like workspace runs) whose prompt is `lib/coordinator.md`. It gets a new
routing role, `coordinate`, so its model and effort are set apart from the
runs it starts. The role's default is the user's default harness at effort
`low`.

It talks to canopy through the API, as the ranger does: the run gets
`CANOPY_API`, `CANOPY_RUN` and `CANOPY_COORD_TOKEN` in its env. The server,
not the prompt, keeps it to proposing. Each coordinator run gets a token of
its own, and a request carrying it is accepted only on
`/api/coordinator/plan` and the read routes (`/api/tree`, `/api/runs`,
`/api/landing`). The server refuses that token on every route that starts,
stops or answers a run. A Bash allowance cannot restrict curl to one URL,
so canopy does not rely on one. The token alone is not enough while the
API answers any caller on its own network without one: the coordinator
could curl a run route bare. So the plan has to close that too, for
example by having the server require a caller credential on the run routes
(the page's session, a shell's or the ranger's token) and give the
coordinator's token none of those rights.

### Proposing tasks

The coordinator ends a planning turn by writing its tasks to
`POST /api/coordinator/plan {run, tasks: [{title, repo, note, action}]}`,
where `action` is `propose` or `ask`. Canopy keeps the list on the
coordinator's run (`Run.tasks`) and shows it in the run sheet as cards, each
with its title, repo and note, editable, with a remove button. Nothing
starts until Eric presses **start these**, which starts every card's run as
a branch run with `Run.parent = <coordinator id>`.

At most 3 child runs work at once per coordinator. The rest wait as
`queued` cards and start as earlier ones settle.

### The cards

Each card shows the child's status and one line of what it is doing now:
the latest timeline entry's summary (a tool call, an ask, the result
line). A card links to the child's run sheet, and its landing state (ready,
queued 2nd, landed, sent back) or, with FR-011, its PR and CI chip.

### Hearing back

When a child settles, canopy writes a short note into the coordinator's
chat as a user message: the child's title, outcome, result line and branch
state. The coordinator can then propose follow-ups (another
`/api/coordinator/plan` call adds cards), answer, or stop. While the
coordinator's chat is mid-turn the note waits for it to go idle.

A child's asks go to the inbox as they do today, not to the coordinator.

## Components

- `src/core/types.ts`: `Run.parent`, `Run.tasks` (`CoordTask {id, title,
  repo, note, action, run?, state}`), the `coordinate` action.
- `src/core/actions.ts`: `ACTIONS.coordinate` (a chat, prompt from
  `lib/coordinator.md`).
- `src/core/route.ts`: the `coordinate` role and its low-effort default.
- `src/core/coordinator.ts` (new, pure): validating a plan, the queue of
  cards (3 at once), the settle note's text.
- `src/server/coordinator.ts` (new): the plan route, start these, starting
  queued cards as children settle, writing settle notes into the chat.
- `src/core/runner.ts`: `CANOPY_API` and the token in `runEnv` for a
  coordinator run only.
- `src/server/index.ts`: the token check at the edge, refusing it outside
  the plan and read routes.
- `lib/coordinator.md` (new).
- UI: the action in the card menu, the task cards in the run sheet, start
  these, the parent link on a child's sheet.

## Calls for Eric

1. **The coordinator proposes and Eric starts.** No child run starts
   without "start these", and the server enforces it (the token above). A
   later setting could let it start follow-ups on its own, but not in the
   first version. The header check alone is not enough (Eric,
   2026-10-16): the run routes get a real per-caller credential first
   (the page's session, a shell's or the ranger's token), as its own
   piece of work that ships before the coordinator, and the coordinator's
   token carries none of those rights. That piece is
   `2026-10-16-caller-credential-design.md`. Its call 1 (Eric,
   2026-10-16) adds a requirement here: coordinator runs run isolated, as
   the stage runner runs incubator stages (own pid namespace, no `~/.ssh`,
   no canopy config, no tmux socket), with a network rule that reaches
   canopy's port alone, and the coordinator stays off the Mac until a
   sandbox there is checked. The coordinator plan designs that.
2. **Children are branch runs.** Each lands through the queue (or opens a
   PR with FR-011). None works in the main checkout.
3. **Three children at once**, the fleet cap.
4. **The coordinator reaches canopy over the API with curl**, like the
   ranger, rather than through an MCP server canopy would have to add to
   runs.
5. **Build it after FR-011**, so a child can open a PR from the start.

## Testing

- `coordinator.test.ts`: plan validation (unknown repo, bad action, too
  many tasks), the 3-at-once queue, the settle note.
- A server test with a fake runner: start these starts 3 and queues the
  rest, a child settling starts the next and writes the note, a note waits
  for an idle chat, a coordinator stopped stops its queued cards and leaves
  running children alone.
- A live check: a goal across two scratch repos, three tasks proposed,
  edited, started, two landing and one sent back, and the coordinator
  proposing a follow-up from the note.
