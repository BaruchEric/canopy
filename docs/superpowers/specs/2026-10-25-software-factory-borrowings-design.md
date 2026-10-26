# Software-factory borrowings: what canopy takes from the 2026 field (FR-032 to FR-046)

Date: 2026-10-25. Status: design, written from a survey of the open-source
"AI software factory" projects as they stood in October 2026, awaiting
Eric's review. This is the index: it says what the field looks like, where
canopy already stands, and ranks fifteen borrowings, each with a spec of its
own beside this file. The research itself is summarised here and not
repeated in the specs.

## Why

In 2026 a "software factory" stopped meaning a better agent and started
meaning the machinery around agents: the backlog that feeds them, the
sandboxes that isolate them, the loops that keep them going, and the gates
that check their output before it ships (Augment's Igor Ostrovsky; the
awesome-software-factories list). canopy grew that machinery on its own:
branch runs in worktrees, a landing queue with gates and review rules, a PR
watch with auto-fix and auto-merge, triggers from Sentry and Linear, a
coordinator, an always-on ranger, health checks, a cost ledger. The survey
asked what the field has that canopy does not, and whether any project is
close enough that adopting or contributing to it beats building on.

## What the field looks like

Three layers, with little overlap between them:

- **Parallel-session managers.** Orca (MIT, about 100k stars, releases
  daily; desktop IDE plus mobile plus `orca serve`), Paseo (Apache-2.0,
  about 21k stars; a daemon with desktop, phone, web and CLI clients, local
  voice, an MCP server agents use to start other agents), Claude Squad (a
  tmux TUI), Vibe Kanban (company shut down 2026-04-10, local-only now).
  They put many agents in worktrees and stop at "review the diff".
- **Ticket-to-merge factories.** Symphony (OpenAI's spec plus an Elixir
  reference; Linear issue → workspace → Codex → CI → PR; policy in a
  `WORKFLOW.md`; not maintained as a product), Optio (MIT; Kubernetes;
  ticket → PR → watches CI and review → resumes on failure, conflict or
  comment → squash-merge; "work until merged"; a needs-you queue; a usage
  limits view), Fabro (MIT; Rust; workflows as Graphviz DOT with agent,
  command, conditional, parallel and human-gate nodes), Mastra Factory
  (Apache-2.0; boards Intake → Triage → Planning → Build → Review → Done,
  each stage manual or auto), Gas Town and Gas City (MIT; Go; Mayor,
  Polecats, Refinery merge queue, Witness; Beads as a git-backed ledger).
- **Methodology layers.** Spec Kit (MIT, about 140k stars, `/speckit.converge`
  closes the loop between spec and code), Superpowers (MIT, approaching 300k
  stars, in Anthropic's plugin marketplace), BMAD, OpenSpec, Backlog.md.
  They shape how one agent works and complement any harness.

The canonical patterns, and who does each: spec-driven development (Spec
Kit, OpenSpec, BMAD); a worktree per task (everyone); orchestrator and
workers (Gas Town); the issue tracker as control plane (Symphony, Optio,
ccpm); workflow as code with human gates (Fabro, Symphony, Mastra); merge
queues with gates (Gas Town's Refinery, ADHDev, YYLO, Optio); holdout tests
the agent cannot see (StrongDM's scenarios, dark-factory's sealed envelope);
digital twins of third-party services (StrongDM alone); Ralph loops (the
same prompt re-fed with tests as back-pressure); best-of-N fan-out with a
reviewer (Orca, Claudexor, Anneal).

Two cautionary findings. StrongDM's "nobody writes or reviews the code"
factory is the dark end; Dex Horthy's own lights-off run ended with an
outage and "a codebase humans hadn't looked at in three months", and every
real deployment that reports numbers (Vercel's AI SDK at 25–35% of merged
PRs, Astro's triage, Mastra, OpenAI's Symphony teams) keeps a human on the
merge. And Steve Yegge, who gave the field its vocabulary, wrote in August
2026 that Gas Town "fell apart at the seams", that he "only ever wound up
using it to build itself", and that his replacement harness "occupies about
20-25% of all my Wyvern work". The architecture he says is convergent (crew,
fleet, mail, tmux underneath, handoffs, a merge queue) is the one canopy
already has.

The subscription question is the constraint that matters most here.
Anthropic's terms for running Claude on a plan rather than an API key
changed in January, February, April, May/June and October 2026. The Oct 7
2026 Help Center wording lets `claude -p`, the Agent SDK and third-party apps
draw on a Max plan's usage limits, and adds $100–200 a month of API credits
that apply only when billed through an API key. canopy's way, the user's own
logged-in `claude` binary over stream-json, is the most defensible of the
subscription paths and is what Orca, Paseo and OpenHands advertise too. It
stays. The policy is a known risk, not a reason to move.

## Where canopy stands

Ahead of every project surveyed on one thing: a serialized landing queue
that rebases, runs the repo's gates, sorts the diff into docs, comments,
format and logic, holds sensitive files for approval, and fast-forwards
main without ever pushing it. Only Gas Town's Refinery, ADHDev, YYLO and
Optio's CI-gated auto-merge come near, and none sorts the diff. Also ahead:
several backends on one board over a tailnet, Forgejo beside GitHub, health
checks that heal, the ranger, the cost ledger, and a board of every repo
rather than one project.

Overlapping, with nothing to take: tmux persistence and worktrees (Claude
Squad, Gas Town, Paseo), voice (Paseo), permission relay to a remote page
(Omnara, Happy), triggers and automations (OpenHands, Optio).

Missing, in the order the specs rank them below: tests the agent cannot see;
one prompt run N times with a reviewer picking the winner; a workflow that
branches, runs steps side by side and marks a step manual; issues from
GitHub and Forgejo worked until merged, conflicts included; dispatch that
knows what is left on the plan; a record of a piece of work that outlives
its runs; canopy as something an agent can call; a dev stack per worktree;
a warning before two runs edit the same file; a check that SPEC.md still
tells the truth; a phone that is told when canopy needs Eric; a run that can
be replayed or forked; a figure for how much of the spend goes into canopy
itself.

## The borrowings, ranked

Value per unit of effort, highest first. Each line names the spec, where the
idea comes from, and the one call that shapes it.

| # | FR | Spec | From | Priority | The call that shapes it |
|---|---|---|---|---|---|
| 1 | FR-032 | `2026-10-25-scenario-gates-design.md` | StrongDM, dark-factory | P1 | Scenarios live under `<configDir>/scenarios/<repo key>/`, outside every checkout; they run in the queue after the gates and before auto-merge; a red one names the scenario, never its text; judge scenarios reuse Jev |
| 2 | FR-035 | `2026-10-25-work-until-merged-design.md` | Optio, Symphony, ccpm | P1 | `github` and `forgejo` trigger sources (hook or poll); Forgejo issues land through the queue, GitHub ones through a PR; the PR watch rebases on `BEHIND`/`DIRTY` and pushes `run/*` with `--force-with-lease` to the sha it last pushed |
| 3 | FR-036 | `2026-10-25-capacity-governor-design.md` | Gas Town, Optio, Claudexor; absorbs FR-028 | P1 | Three priorities on every start; `low` holds at 70% of the five-hour window, `normal` at 90%, `interactive` never; a limit hit makes a run `limited` and retried after reset, not failed; the credits lane is written out and left for Eric |
| 4 | FR-038 | `2026-10-25-agent-surface-design.md` | Orca's CLI, Paseo's MCP, Gas Town's `gt nudge` | P1 | `canopy mcp` over stdio, tools filtered by the token's kind; a `run` caller kind minted per run only when the profile turns it on, delivered through a 0600 `--mcp-config` file, revoked at settle, never able to land, push or answer a prompt |
| 5 | FR-033 | `2026-10-25-best-of-n-design.md` | Orca, Claudexor, Anneal | P2 | `times` up to the branch-slot cap, members share `Run.group`; gates and scenarios dry-run on each, a read-only `compare` run ranks them; the winner lands by its own sort, the rest drop when it lands |
| 6 | FR-034 | `2026-10-25-workflow-graph-design.md` | Fabro, Symphony, Mastra | P2 | Three optional step keys, `after:`, `when:`, `mode:`, in the markdown format that exists; parallel only for read-only steps; the landing queue is the fan-in |
| 7 | FR-040 | `2026-10-25-collision-warnings-design.md` | Concord, foremerge, juliensimon/canopy | P2 | No declarations: canopy already sees every edit tool call; a live touched set per run, overlap raises a notice and a chip, never a hold; one group never collides with itself |
| 8 | FR-037 | `2026-10-25-work-ledger-design.md` | Beads, Symphony | P2 | A work item per branch under `<configDir>/work/`, not in the repo; git carries the id in the branch name, a `Canopy-Work:` trailer and the PR body; handoff notes fenced into every later run on the branch |
| 9 | FR-041 | `2026-10-25-spec-converge-design.md` | Spec Kit's converge, Spexcode | P2 | A `schedule` trigger source; a bundled `spec-converge` workflow; SPEC.md stays on the sensitive list, so the fix always waits for a look |
| 10 | FR-042 | `2026-10-25-pwa-push-design.md` | Paseo, Happy, Orca mobile | P2 | A PWA, not native apps; a hand-written service worker that caches the shell only; the server builds the "needs you" list and pushes the key and a title, never a token |
| 11 | FR-039 | `2026-10-25-worktree-stacks-design.md` | Coasts, Treehouse | P3 | `warm: N` in gates.json, set per machine; a task per worktree with allotted ports; compose per worktree by project name; canopy's own stack on the mini is refused |
| 12 | FR-043 | `2026-10-25-run-replay-design.md` | OrcaReplay | P3 | Both directions of the wire written to `<configDir>/runs/<id>/`, redacted, kept 30 days; replay is pure UI; fork is `--fork-session` from the original's base, cross-harness fork is a fenced summary |
| 13 | FR-044 | `2026-10-25-harness-share-design.md` | Yegge's 20–25% | P3 | A `harness` mark on repos; the share of dollars and sessions, eight weeks of plain CSS bars, rust past 25% |
| 14 | FR-045 | `2026-10-25-landing-package-design.md` | the survey's own conclusion | P3 | The queue's pure model and git half as a Bun workspace package; no-go by default, go when a second consumer is real |
| 15 | FR-046 | `2026-10-25-paseo-interop-design.md` | Paseo | P3 | A study with thresholds, two half-days, "no" as the default; Paseo is Apache-2.0 per its README, a WebSocket protocol with capability flags, 0.13.0 on 2026-10-24 |

The first four stand on their own and each makes agents land other repos'
code better, which is the test Yegge's warning sets. FR-033 wants FR-032
(scenarios score the members) and FR-040 (a group never collides with
itself). FR-037 and FR-038 want each other a little: notes are written
through the agent surface once runs have a token, and read as fenced text
until then. FR-041 brings the `schedule` source that FR-036 and FR-044 also
use.

## Adopt, contribute, or keep building

Keep building canopy. No project surveyed combines driving the user's own
subscription CLI, several machines on one board, Forgejo, and a gated
landing queue, and switching would give up the queue. Paseo is the one to
watch: it has canopy's daemon-plus-clients shape, multi-host model, voice
and worktrees, and native phone apps canopy does not have; FR-046 asks the
questions that decide whether canopy speaks its protocol or contributes a
landing-queue plugin, and FR-045 makes the queue something it could take.
Orca is where the momentum is, and its two best ideas, fan-out and an agent
CLI, are FR-033 and FR-038. Optio and Fabro are idea mines for pipeline
semantics and poor fits to adopt (Kubernetes, a Rust binary). Vibe Kanban,
Terragon, uzi, Crystal and Gas Town itself are shut down, unmaintained or
abandoned by their author, and are not candidates.

## Standing warnings

- **Harness time.** Yegge's 20–25% is the figure FR-044 measures. The specs
  are ordered so the first four change what lands in other repos, not how
  canopy looks.
- **Policy.** canopy's model matches the Oct 7 2026 wording. The credits
  lane in FR-036 is the one borrowing that would reverse a dated decision
  (2026-08-24, no API key or SDK; Out of scope, "storing API keys for
  Claude") and it is held for Eric's word, with the recommendation to wait.
- **The name.** `github.com/juliensimon/canopy` is a macOS app that runs
  parallel Claude Code sessions in worktrees with collision detection. If
  anything of canopy's goes public (FR-045), the package takes another name.
- **Numbers.** Stars, release versions and the productivity figures vendors
  report (Vercel, Mastra, Symphony, Astro) were as found in October 2026 and
  self-reported; none was verified here.

## Not borrowed, and why

- StrongDM's digital twins of Okta, Jira, Slack and Google. canopy's repos
  do not talk to those at the volume that makes clones pay.
- Anthropic's Scion. Replacing git is the wrong size for one developer; the
  lesson taken is that once agents write code the bottleneck is landing, CI
  and review, which the queue already targets.
- Kubernetes pods (Optio), a desktop IDE (Orca), local models (Kilo, Paseo's
  STT is local but canopy's Whisper already is), a kanban (Vibe Kanban,
  Cline): other shapes, not missing pieces.
- Ralph loops as a feature. A flow with `retries:` and `back:` already is
  one.
- Dark-factory operation itself. Review rules decide what lands alone, and
  the answer stays "docs, comments, format".

## Calls for Eric, gathered

The specs mark their own; these cross a dated decision or a boundary and
deserve one answer each.

1. **The credits lane (FR-036).** An `ANTHROPIC_API_KEY` in the secret
   store, handed only to one named profile's `claude -p` env for the ranger
   and `low` work, funded by the plan's monthly credits. Reverses
   2026-08-24 and the Out of scope line. Recommendation: hold; the governor
   stands without it.
2. **A forced push, with a lease (FR-035).** The PR watch rebases a
   `run/*` branch and pushes it with `--force-with-lease=<branch>:<sha
   canopy last pushed>`, on canopy's branches alone. The PR-watch spec said
   push is never forced. Recommendation: allow it under that lease, since a
   rebased branch cannot be pushed any other way and the lease refuses to
   overwrite anything canopy did not write.
3. **Where scenarios live and travel (FR-032).** Under the config dir, so
   they never sync with the repo; export and import by hand, or an orphan
   branch. Recommendation: the config dir, exported by `canopy scenarios`.
4. **Run tokens on by default or per profile (FR-038).** Recommendation:
   off by default, on per profile, since a token in a run is a new surface.
5. **A licence and a name for anything published (FR-045, FR-046).** canopy
   has no LICENSE file today. Recommendation: MIT for a package, a name
   without "canopy" in it, and no publishing until a second consumer is
   real.
6. **Whether native phone apps matter enough to run the Paseo study's
   adapter questions at all (FR-046)**, or whether the PWA of FR-042 is the
   answer. Recommendation: the PWA first; run the study only if it falls
   short on the phone.

## Suggested order

Plans are written when a spec is approved; this is the order the specs
assume.

1. FR-032 scenario gates, plan 1 (deterministic scenarios in the queue).
2. FR-036 capacity governor, plan 1 (probes, the model, the holds, the
   chip; absorbs FR-028).
3. FR-038 agent surface, plan 1 (`canopy mcp` for shells and the ranger
   with the tokens they already have).
4. FR-035 work until merged, plan 1 (the `github` and `forgejo` sources,
   polled) and plan 2 (the conflict loop).
5. FR-040 collision warnings (one plan), then FR-033 best-of-N.
6. FR-041 spec converge (brings `schedule`), FR-034 workflow graph,
   FR-037 work ledger, FR-042 PWA and push.
7. FR-039, FR-043, FR-044, then FR-045 and FR-046 when their go criteria
   are met.

## Sources

The survey drew on primary pages where they could be reached and on the
community lists otherwise; the specs cite the ones each rests on. The main
ones: Igor Ostrovsky, "Software factories" (igoro.com); the
awesome-software-factories lists (wippa-studios, varun1505); StrongDM's
factory writeups as mirrored (rywalker.com/research/strongdm-factory);
Steve Yegge, "The Shape of Things to Come" (yegge.ai) and "Welcome to Gas
City" (medium); Anthropic, "Redesigning source control" (2026-10-13) as
summarised; Anthropic's Help Center, "Use the Claude Agent SDK with your
Claude plan" and "Monthly API credits for Max and Team plans" (Oct 2026);
the repositories of Orca (stablyai/orca), Paseo (getpaseo/paseo), OpenHands,
Optio (jonwiggins/optio), Claude Squad (smtg-ai/claude-squad), Symphony
(openai/symphony), Mastra's softwarefactory-template, Fabro (fabro-sh/fabro),
Gas Town, Gas City and Beads (gastownhall), Spec Kit (github/spec-kit),
Superpowers (obra); Vercel, "Building a software factory for AI SDK"
(2026-08-12); Mastra, "Announcing Mastra Factory beta" (2026-09).
