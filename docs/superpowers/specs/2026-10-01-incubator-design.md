# The incubator: new projects from an idea, a URL or a repo

The user wants canopy to bootstrap whole projects with an agent. You hand it an
idea, a URL, a repo or a folder, in any form (text, a voice memo, a screenshot,
a file), and it carries the project through clarification, research, an
evaluation, the build, tests, an acceptance check and a deploy, then reports
how the process itself could be better.

## What the user asked for, and what was assumed

Said by the user:

- One pipeline covering three outcomes: an idea taken all the way to a live
  app, a working local project parked before deploy, and triage of someone
  else's project before adopting it.
- Eval means both a judgment before any code and an acceptance check against
  the original intent before deploy.
- Fully autonomous between stages: the verdict evaluator answers the gates, and
  the user hears of a project when it is live or when it parks.
- Repos are private on GitHub; the host is picked per project from a fixed
  list.
- Deep research first: find similar projects in the user's own workspace and on
  GitHub and the web, rank them by fit with the user's stack, and prefer
  improving, renovating and modernizing something that exists over starting
  from nothing. "Modernizing" includes reading current releases so a build
  starts on today's versions.
- An intent clarification stage, like the one this spec came out of.
- Every input the user gives (audio, image, text, anything) is logged. Only an
  index and summaries go to the memory vault, never the raw inputs.
- The process always advises on its own improvement.
- It runs on the mini.

Assumed, not contradicted: extending one of the user's existing projects works
on a branch and never merges into that project's `main`; agents run on a
per-step allowlist, never with permissions bypassed; nothing an agent does may
spend money, publish a repo, or touch a domain or DNS.

Success: from a phone, the user drops a sentence and a screenshot into canopy,
answers a few questions in the inbox, and later finds either a private repo
deployed at a URL, or a parked project whose reason is one line in the inbox,
with a vault note and a retro either way.

## The stages

intake, clarify, research, eval, build, test, accept, deploy, retro.

1. **Intake.** The inputs arrive and a seed is made: `~/dev/_incubator/<slug>`,
   a git repo holding `.canopy/brief.md` (the first text, or a one-line
   placeholder until clarify writes one) and `.canopy/inputs.md`. For a repo
   input, intake clones it into the seed so research can read the real code.
   The seed is in the scan, so it is a card at once.
2. **Clarify.** An agent reads every input and writes `.canopy/intent.md`:
   what the user said, what it assumes, what success looks like. It may ask up
   to four questions, which go to the inbox as one batch. The project waits for
   the answers; "go on assumptions" skips them. This is the only stage that
   waits on the user by design.
3. **Research.** The agent searches the user's workspace (the devhub manifest,
   `~/dev`, saved references) and GitHub and the web, and writes
   `.canopy/research.md`: a table of candidates with what each is, its license,
   its last activity, its stack, its distance from the user's stack, and what
   renovating it would take, plus the current versions of whatever the build
   will use. It ends in one pick, in this order of preference:
   - **extend** one of the user's projects, when the idea is a feature of
     something that exists;
   - **renovate** an open-source project: clone it into a new private repo with
     `upstream` kept as a remote (a GitHub fork of a public repo cannot be
     private), then bring it to current versions and the user's conventions;
   - **new**: scaffold on the user's stack at current versions.
4. **Eval.** A `judge` gate (below) over the intent and the research. A park
   rewinds to research with the reason.
5. **Build.** The pick carried out, until a dev task runs and the preview shows
   it.
6. **Test.** The project's own gates pass, and a smoke check against the
   running preview passes.
7. **Accept.** A `judge` gate: does what runs match `intent.md`? A park rewinds
   to build with the reason.
8. **Deploy.** The private repo is pushed and deployed to the picked host; the
   URL is reported. For extend, deploy is a push of the branch.
9. **Retro.** Advice on the process, every time a project ends.

## Architecture

Flows run one straight line of steps on one repo. The incubator has a fork in
the road after eval, so a thin layer sits above flows and does the branching,
and every workflow stays a straight line.

### Sprouts and the Incubator

A sprout is one project in the incubator. `Incubator` (`src/core/incubator.ts`,
Bun) keeps one `Sprout` per project, saved as
`$CANOPY_CONFIG_DIR/incubator/<id>/sprout.json`:

```ts
type SproutStatus =
  | "queued" | "clarifying" | "researching" | "building" | "testing"
  | "accepting" | "deploying" | "live" | "parked" | "rejected"
  | "handed-off" | "stopped";

interface Sprout {
  id: string;            // "sp_" + 12 hex
  slug: string;          // folder name, from the intent's title
  status: SproutStatus;
  repoId: string;        // the seed, or the extend target
  seedPath: string;
  inputs: InputEntry[];
  questions?: ClarifyQuestion[]; // open clarify batch, if any
  pick?: Pick;
  privateRepo?: string;  // owner/name once created
  url?: string;          // live URL once deployed
  flows: { workflow: string; flowId: string; outcome?: string }[];
  spent: { runs: number; workMs: number };
  parked?: string;       // the one-line reason
  retro?: { at: number; adviceKeys: string[] };
  createdAt: number;
  updatedAt: number;
}

interface Pick {
  kind: "new" | "renovate" | "extend";
  target?: string;       // the upstream URL, or the extend target's repo path
  host: HostId;
  license?: string;      // SPDX id, for renovate
  why: string;
}
```

The Incubator never runs an agent itself. It starts flows through the existing
`Flows` class, listens on `onChange`, and decides what comes next when a flow
ends. The pure parts (`nextStage(sprout, flow)`, `parsePick`, `pickRefusal`,
`sproutSlug`) live in `src/core/sprout.ts`, browser-safe and tested.

The chain:

| Sprout state | Flow it runs | On pass | On park or fail |
|---|---|---|---|
| clarifying | `clarify` | wait for answers, then research | park |
| researching | `scout` (research, eval) | read `pick.json`, start build | park, or `rejected` when the judge says the idea misses |
| building | `build-new`, `renovate` or `extend` | `live`, or `handed-off` for extend | park |
| any end | `retro` | write advice | the retro failing never changes the sprout's status |

`parsePick` validates `.canopy/pick.json` after scout; `pickRefusal` applies
the hard limits (below). A pick that fails either parks the sprout with the
reason. The build workflows cover build, test, accept and deploy as their own
steps, and the sprout's status follows the step in progress.

At most two sprouts run at a time (`SPROUT_CONCURRENCY`); the rest are
`queued` and start in order. A sprout waiting on clarify answers does not hold
a slot.

### The bundled workflows

In `lib/workflows/`, overridable like the others. Each is a straight line.

- `clarify.md`: one step. Writes `intent.md`, rewrites `brief.md`, writes
  `inputs.md` summaries, and writes `.canopy/questions.json` (zero to four
  questions, multiple choice where it can). It does not ask through
  `AskUserQuestion`, since a run held open for days would not survive a
  restart; the Incubator turns `questions.json` into an inbox item.
- `scout.md`: research (`retries: 2`, check `canopy incubator pick-check`,
  which validates `pick.json` and exits 1 with the reason), then eval
  (`gate: judge`, `evidence: .canopy/intent.md .canopy/research.md
  .canopy/pick.json`, `back: research`, `retries: 2`).
- `build-new.md`: scaffold, test, accept (`gate: judge`, `back: scaffold`),
  deploy, file (deploy and file replaced by amendment 2, rulings 1 and 3; see amendment 2).
- `renovate.md`: pull upstream into the seed and add the `upstream` remote,
  renovate, test, accept, deploy, file.
- `extend.md`: branch `new/<slug>` in the target repo, build, test, accept,
  push the branch. Never merges. The seed moves to `_incubator/handed-off/`.
- `retro.md`: one step, below.

The last step of `build-new` and `renovate`, file, runs
`canopy library import <seed path>`, so devhub classifies the project into its
category (replaced by amendment 2, rulings 1 and 4; see amendment 2). It runs after deploy so no flow's repo path moves under it; the
Incubator then updates `repoId` and `seedPath` from the rescan. A rejected
sprout's seed moves to `_incubator/rejected/` with its research.

Starting budgets (frontmatter, tuned through retros): clarify 2 runs and 20
minutes, scout 8 runs and 1 hour, build-new and renovate 30 runs and 6 hours,
extend 20 runs and 4 hours, retro 2 runs and 20 minutes.

## Changes to the flow engine

General changes; every workflow can use them.

### Flows survive a restart

`Flows` writes each flow to `$CANOPY_CONFIG_DIR/flows/<id>.json` on every
change, with a snapshot of the parsed `Workflow`, the step summaries and the
pending retry reason, so a resumed flow runs the steps it started with even if
the file was edited since. At startup it loads them:

- a `gated` flow comes back gated;
- a `working` or `waiting` flow lost its run with the old process; it reruns
  the current step with "canopy restarted during this step; read the repo's
  state and finish the step" ahead of the prompt;
- a finished flow is kept for the `KEEP_FINISHED` window as now.

Fleets stay in memory. A loaded flow whose `fleetId` names no fleet drops it.

A record also carries the repo's absolute path and the launch root of the
server that wrote it, since the config dir is shared across roots and repo ids
are relative to one. A server loads only the records for its own root and
finds each repo by path; the others stay on disk untouched. One server owns
the folder: it takes `flows/owner.lock` (a pid file, taken over when that pid
is dead) once its port is bound, and a server without the lock neither loads
nor writes records. A record the engine cannot take back is skipped with a
log line.

### Retries and rewinds

Two step keys in `workflow.ts`:

- `retries: N` (default 0, today's behaviour);
- `back: <step name>` (default the step itself; must name this step or an
  earlier one, checked at parse time).

When a step's check fails, or a `verdict` or `judge` gate parks, and the step
has retries left, the flow rewinds to `back`, carries the reason into that
step's prompt, and resets every step from `back` on to pending. The count is
per step that parked, kept on the flow, and survives a restart. Out of retries,
it parks as today. The evaluator being unreachable and a missing gateway key
park at once, never retry: neither is a judgment of the work.

### Budgets

Frontmatter `budget: <runs> runs, <hours>h`. Runs counts every step run,
retries and restart reruns included. Hours counts time with a step running,
not time gated or waiting on a prompt. Over either, the flow parks with
"budget spent: …". Resuming a budget park through `continue` grants one more
step's worth. Tokens are not counted: Claude on the Max login reports a dollar
figure that is not spending, and Codex reports tokens, so they do not add up.

### The judge gate

The existing `verdict` asks whether a step finished its task, and its
`offScope` question would park every deploy. A second kind, `gate: judge`, asks
whether the work is right:

```ts
JUDGE_QUESTIONS = {
  fit:      choice  { meets, partly, misses }  // does the work meet the intent?
  evidence: boolean // is what was read enough to trust that answer?
  rules:    boolean // does anything break the rules: a host off the list, a
                    // license that forbids the use, spending money, a public
                    // repo, a domain or DNS change?
}
```

`decideJudge` passes only with `fit` = meets at 0.7 or more, `evidence` at 0.5
or more, and `rules` under 0.3. `misses` at 0.7 or more is reported as a
rejection, which scout's eval turns into a `rejected` sprout rather than a
retry. The step key `evidence: <paths>` names files in the repo whose
contents, clipped to 6 KB each (its first half and its end) and 20 KB in all, join the summary in the text
the evaluator reads (`judgeState`). Both live in `verdict.ts`, pure and tested.
Without a gateway key, a `judge` gate asks the user, as `verdict` does.

## Inputs, clarification and memory

### Inputs

Intake takes text, audio, images, URLs and files, from the sheet, a paste, a
drop, or the CLI, and more can be added to a sprout at any stage. Raw inputs go
to `$CANOPY_CONFIG_DIR/incubator/<id>/inputs/`, never into the seed: the seed
is peer-synced and WIP snapshots take untracked files.

Each input becomes an `InputEntry` (`{n, kind, name, at, via, bytes, summary,
processed}`), indexed in `incubator/<id>/inputs.md`. Processing:

- audio is transcribed on the server at intake (`transcribe` hook; the plan
  checks what the mini has, a speech model behind the LiteLLM gateway or
  whisper in the image, and uses that). The transcript is saved beside the
  audio as an input of its own;
- text is kept as is;
- images, URLs and files are summarized by the clarify agent, which is given
  read access to this sprout's `inputs/` folder and nothing else outside the
  repo, and writes the one-line summaries into `.canopy/inputs.md`.

Only `brief.md`, `intent.md` and `inputs.md` (index and summaries) are
committed to the seed. A clarify answer, or anything added later, is logged as
an input too, and an input added after clarify reruns clarify before the next
stage starts.

### Clarify questions

`questions.json` becomes the sprout's `questions` and one inbox item of a new
kind, `clarify`: up to four questions with their options and a free answer
each, plus "go on assumptions". `POST /api/incubator/answer` stores the
answers as an input, appends them to `intent.md`, and moves the sprout to
research. An empty `questions.json` goes straight on.

### The vault note

The Incubator keeps one note per sprout, `02 - Dev/incubator/<slug>.md`,
through the memory gateway's write API (the one `vault write` uses) with a
token of canopy's own, `CANOPY_VAULT_TOKEN`, in the mini's `.env`. It holds the
intent, the inputs index and summaries, the pick and why, the chain of stages
and how each ended, the live URL, and the retro. It is rewritten on each status
change (replace with the last base revision), and a line goes into that day's
daily note when a sprout starts, goes live, parks or is rejected. Raw inputs
and transcripts never go to the vault. Without a token the notes are skipped
with one warning in the log; a failed write is tried again at the next change
and never stops a sprout. The note's text is built by the pure `sproutNote`.

## Retro and the improvements list

`retro.md` runs when a sprout goes live, is handed off, is rejected, or is
stopped by the user, and when a park has gone unanswered for 24 hours. Its
agent reads `incubator/<id>/record.json` (the sprout and every flow it ran,
with retries, parks and their reasons, judge answers, time and runs per stage)
and writes `.canopy/retro.md` and `.canopy/advice.json`:

```ts
interface Advice {
  key: string;          // stable slug, so the same lesson counts across sprouts
  lesson: string;       // one sentence
  file?: string;        // a workflow or allowlist it would change
  edit?: string;        // the proposed change, as a unified diff or prose
}
```

Advice is proposed, never applied by the agent. The Incubator folds it into
`incubator/improvements.md`, counting repeats by key so a lesson three
sprouts have hit sorts first, adds it to the vault note, and sends one inbox
item. Accepting a piece of advice opens a chat on the repo that owns the file
(canopy's own for a bundled workflow, none for one in the config dir, where it
opens the file instead) with the proposed edit as the first message; dismissing
it is remembered so the same key is not offered again until it recurs three
more times.

## Where it runs, and what an agent may do

### The mini

Sprouts run on the backend they are started from, and the page starts them on
home, which is the mini: it is always on, it holds `VERCEL_AI_GATEWAY_API_KEY`
so the judge works, and peer sync brings each seed to the Mac. Like tailchan,
the incubator is home's alone on a page with several backends (amendment 8 of
the multi-backend spec).

### Allowlists

Every step runs on its own `tools:` list; no step bypasses permissions. A
prompt the list does not cover is not answered by anything but the user: it
reaches the inbox as run prompts already do, and the sprout shows waiting.
Every step's prompt tells the agent to stay inside its list and say so when it
cannot.

| Stage | Tools |
|---|---|
| clarify | read, `Read` of the sprout's inputs folder, `WebFetch`, `Edit`/`Write` under `.canopy/` |
| research | read, `WebSearch`, `WebFetch`, `Bash(gh search:*)`, `Bash(gh repo view:*)`, `Bash(gh api:*)`, `Bash(git clone:*)`, `Write` under `.canopy/` (replaced by amendment 2, ruling 3; see amendment 2) |
| build, renovate, extend | `Edit`/`Write` in the repo, `bun`, `bunx`, `git-read`, `git-commit`, the project's own scripts |
| test | `bun`, `bunx`, the project's scripts, `Bash(curl:*)` against the preview |
| deploy | `git-push`, `Bash(vercel deploy:*)`, `Bash(vercel link:*)`, `Bash(vercel env:*)`, `Bash(firebase deploy:*)`, `Bash(bunx convex deploy:*)` (`git-push` and `Bash(vercel deploy:*)` replaced by amendment 2, ruling 1; see amendment 2) |
| retro | read, `Write` under `.canopy/` |

### Hard limits the Incubator enforces

These are checked in code, not trusted to the agent or the judge:

- The Incubator creates the GitHub repo itself, private, through `gh` with
  canopy's `GH_TOKEN`, before the build workflow's deploy step; no allowlist
  holds `gh repo create`, so an agent cannot make a public one.
- `HOSTS` is the fixed list: `vercel`, `vercel+firebase`, `vercel+convex`,
  `mini`. `pickRefusal` parks any other.
- A renovate pick must carry an SPDX license in `ALLOWED_LICENSES` (MIT,
  Apache-2.0, BSD-2-Clause, BSD-3-Clause, ISC, MPL-2.0, Unlicense, 0BSD, GPL-2.0,
  GPL-3.0, LGPL-2.1, LGPL-3.0). AGPL, SSPL, a non-commercial license or no
  license parks with the reason.
- No allowlist entry buys anything, adds a domain or alias, or edits DNS
  (`vercel domains`, `vercel alias`, `vercel buy` and their kind are absent).

### Credentials

Deploys need tokens in the mini's `.env`, passed to the canopy and shells
services: `VERCEL_TOKEN`, `FIREBASE_TOKEN` (or a service account file), and
for Convex a deploy key the build step gets from Convex's own project creation.
`GH_TOKEN` is already there. Before the deploy step starts, `deployReady(host,
env)` checks the host's tokens and parks with "add VERCEL_TOKEN to the mini's
.env" when one is missing. MCP servers stay off in runs, so deploys go through
the CLIs.

The `mini` host deploys a compose stack on the mini itself. canopy's container
cannot run compose on the host, so this host gets a narrow ssh key on the mini
whose forced command only runs `docker compose up -d --build` in a folder under
`~/dev`, the same shape as the peer gate; it arrives in phase 4.

## UI

- **+ project** in the top bar, and ⌘N: a sheet with a large text box, a drop
  zone for images, audio and files, a URL field, and a record button for
  voice. The microphone needs a secure page, so on the tailnet's plain http
  the record button becomes "upload a voice memo".
- **The incubator view** in `ViewNav`: a card per sprout with its stage strip
  (clarify, research, eval, build, test, accept, deploy, retro), status word and
  parked reason. Opening one shows intent, the inputs index, research and the
  pick, the chain of flows (each opening the existing `FlowSheet`), budget
  spent, the URL, the retro, and add input, stop and resume.
- Seeds also show as ordinary cards in the git view.
- **Inbox**: two new kinds, `clarify` (the question batch) and `advice` (the
  retro's advice), through `mergeInbox`.
- **Feed**: an `incubator` kind with a line per status change. **tailchan**:
  a DM when a sprout parks or waits on clarify, a channel line when one goes
  live or is rejected, through the existing notice hooks.
- Pure parts in `ui/src/sprouts.ts` (stage strip, status words, input kinds),
  tested.

## API and CLI

Home backend only. Every change broadcasts the whole sprout as an `incubator`
event, `incubator-gone` on dismiss.

| Route | What it does |
|---|---|
| `POST /api/incubator` | multipart: `text`, `urls[]`, `files[]`, `repo?`; answers 201 with the sprout |
| `GET /api/incubator` | every sprout |
| `GET /api/incubator/one?id=` | one sprout with its inputs index, intent, research and retro text |
| `POST /api/incubator/input?id=` | multipart: add inputs |
| `POST /api/incubator/answer?id=` | `{answers}` or `{skip: true}` |
| `POST /api/incubator/stop?id=` | stops the running flow and the sprout |
| `POST /api/incubator/resume?id=` | resumes a parked sprout's flow with `continue` or `retry` |
| `POST /api/incubator/advice` | `{key, accept}` |
| `DELETE /api/incubator?id=` | dismisses an ended sprout (the seed stays on disk) |

Limits: 25 MB per file, 100 MB per sprout's inputs (413 past either); audio,
image, pdf, text and markdown types (415 otherwise).

CLI: `canopy new "<idea>" [--file <path>]... [--url <url>]... [--repo <url>]`
posts to the backend and prints the sprout's id and its URL in the page;
`canopy incubator list|show <id>|pick-check`.

## Errors

Everything ends parked with a one-line reason in the inbox; nothing dies
silently.

| What happened | What the user sees |
|---|---|
| a token or CLI is missing | parked: "add VERCEL_TOKEN to the mini's .env" |
| budget spent | parked: "budget spent: 30 runs" |
| retries used up | parked with the judge's or check's last reason |
| the judge refuses a pick or a build | rewind while retries last, then parked |
| the eval judges the idea a miss | rejected, with the research kept |
| a prompt outside the allowlist | waiting, the prompt in the inbox |
| `pickRefusal` (host, license) | parked with the rule that refused it |
| transcription failed | the audio kept raw, its entry marked "not transcribed", clarify told |
| a vault write failed | logged, tried again at the next change |
| canopy restarted | gated flows gated, mid-step flows rerun with the restart note, queued sprouts still queued |
| the seed folder vanished | parked: "the seed folder is gone" |

## Testing

- Pure, tested: flow persistence round trip, rewind with `back` and the retry
  count across a restart, budget arithmetic, `decideJudge` and `judgeState`
  clipping, `parsePick`, `pickRefusal` (host, license), `nextStage` through
  every pick and outcome, the inputs index, `sproutNote`, advice folding and
  repeat counts, `ui/src/sprouts.ts`.
- `Flows` with a fake runner: a restart mid-step, retries rewinding to `back`,
  a budget park, a `judge` gate with a fake evaluator.
- `Incubator` with fake `Flows`, a fake evaluator and a fake vault: clarify
  waiting and skipped, every pick, a rejection, a hand-off, the concurrency
  queue, the private repo created before deploy, a missing token.
- Server: every route, its limits and refusals, and the `incubator` events,
  with a stand-in evaluator (`server/incubator.test.ts`).
- One live run behind `CANOPY_INCUBATOR_IT=1`: clarify skipped, a real scout on
  a toy idea, stopping before build.

## Phases

Each phase ships on its own; the UI grows with each.

1. **Flow engine**: persistence, `retries` and `back`, budgets, `gate: judge`
   with `evidence`.
2. **Intake and clarify**: the sprout record, inputs and transcription,
   `clarify.md`, the clarify inbox item, the vault note, the + project sheet
   and the incubator view.
3. **Scout, build-new and Vercel**: `scout.md`, `build-new.md`, the private
   repo, `deployReady`, filing through devhub. The first idea-to-URL run.
4. **Renovate and extend**: `renovate.md`, `extend.md`, the license rules,
   Firebase, Convex and the `mini` host with its forced-command key.
5. **Retro**: `retro.md`, `advice.json`, the improvements list and the
   advice inbox item.

## Out of scope

- Merging an extend branch, or any automatic merge into a `main`.
- Custom domains, DNS, and anything paid.
- Running sprouts on a backend other than home, or on the Mac by default.
- Persisting fleets.
- Counting tokens or dollars in budgets.
- Applying retro advice without the user.

## Amendments

### 1. Phase 2 (2026-10-02)

Accepted deviations from the text above:

- **E1.** The slug comes from the idea's first words at intake, not from the intent's title, since it names the folder before any intent exists. Renaming a seed later costs a path change in the vault note and the record.
- **E2.** Clarify's tools are bare `Edit` and `Write`, not limited to `.canopy/`: codex's `threadPolicy` needs the bare rule for `workspace-write`. The prompt confines the agent and the seed is a fresh repo.
- **E3.** The shortcut for a new project is a bare `n`, not ⌘N, which the browser takes first.
- **E4.** Clarify's budget is written `budget: 2 runs, 0.34h` (20.4 minutes), since the parser takes decimal hours only.
- **E5.** The daily-note line is written when a sprout starts or parks. Going live and rejection do not exist before phase 3.
- **E6.** The vault note is rewritten on every change, not only on a status change.
- **E7.** The project sheet has no retro section until phase 5.

Rulings made while building phase 2:

- Sprout records are restored only by the server that holds the flows lock, and only the records stamped with its own launch root. A server without the lock lists them read-only and answers an intake with 503.
- A seed cloned from a URL has `.claude/settings.json`, `.claude/settings.local.json` and `.mcp.json` removed in a committed change before the first run, so no step runs under the cloned project's own permissions.
- `readSeed` and `writeSeed` refuse any path whose components under the seed include a symlink.
- Stages load workflows from the bundled and the user's own sources only, never a seed's own `.canopy/workflows/`.
- A sprout parked by a live gated flow keeps its concurrency slot.
- Seeds stay peer-synced in phase 2.
- `CANOPY_TRANSCRIBE_URL` is an origin; canopy appends `/v1/audio/transcriptions`.
- In phase 2 only clarify's questions reach the inbox. A park is told by a tailchan DM; parks join the inbox in a later phase.
- Every incubator stage runs with yolo off and without the route's extra flags, whatever the agent routes say: in the incubator's own start, and when a flow on a seed is restored after a restart.
- The vault token and the transcribe key are read once at start and then deleted from canopy's own environment, so no shell, run or tmux server inherits them; `/proc/<canopy>/environ` still holds the values the process started with.
- Clarify reads its inputs with the Read tool by full path, never through a shell, and reads a recording's transcript rather than the recording. A transcribed recording's line in the index says "a voice memo; its words are in [n]", so it never waits on a summary. Its step checks `.canopy/questions.json` (JSON, a list, each with its question text) and has `retries: 1`: a bad file sends clarify back once with the reason, and after that the flow parks gated, so the sprout keeps its slot under the ruling above. Before this, the first real sprout (2026-10-02) asked for three Bash permissions, to read the inputs, to inspect the audio and to check the JSON.

### Amendment 2: phase 3, 2026-10-02

Rulings made while building phase 3 (scout, build-new and Vercel):

1. **Deploy is canopy's code, not an agent step.** The spec's `build-new` ends in deploy and file steps whose allowlist holds `git-push` and `vercel deploy`. Here `build-new` stops at Accept, and the Incubator's `ship` does the rest in code. Under the spec's plan, an agent with `Bash(git push:*)` could push to any repo `GH_TOKEN` can write to, and one with `Bash(vercel deploy:*)` holds the Vercel token. The hard limits (no public repo, no domain or alias) hold by tool allowlist and env scrub. No stage's allowlist holds a push, a repo create or `vercel`. Every stage run, under either harness, and every stage check starts from `stageEnv` (`core/envnames.ts`): no `GH_TOKEN`, `GITHUB_TOKEN`, `GH_ENTERPRISE_TOKEN`, no `GIT_CONFIG_COUNT` with its `GIT_CONFIG_KEY_n`/`GIT_CONFIG_VALUE_n` pairs (the gh credential helper), no `SSH_AUTH_SOCK`, `CANOPY_API` or `TAILCHAN_*`. That is not a sandbox. An agent that runs code (build-new's `bun run`) shares canopy's uid and pid namespace and can still read `/proc/<canopy>/environ`, which holds the env canopy started with, tokens included, and it can read the ssh keys in the read-only `~/.ssh` the containers mount; on the Mac, gh's keychain login stays reachable whatever the env says (see amendment 3). A login file (`~/.profile`, a bashrc) that exported a token again would undo the scrub for a check's `sh -lc` and an agent's commands; none does today. Running stages without a token is a later phase's work. Canopy's own git calls are not covered by the scrub: the watcher's status read, the background fetch and the peer pass run git in a seed under canopy's full env, so a `.git/config` an agent edited (a `core.fsmonitor`, a filter, a `remote.<name>.uploadpack`) runs its command as canopy with every token on the next read or fetch, with no agent run needed. The token-free stages spec closes this with a guard on every git call canopy makes in a seed. Scout holds no `gh` tool, since gh refuses without the token on the mini: Research finds GitHub repos through WebSearch and reads them through WebFetch of `api.github.com` and their READMEs.
2. **Phase 3 deploys `new` picks to `vercel` alone.** `pickRefusal` still knows all four hosts and the license rules. A new `phaseRefusal` parks a `renovate` or `extend` pick with "a renovate pick arrives in phase 4; the research is in .canopy/research.md", and parks any host but `vercel` the same way.
3. **Research reads nothing in the workspace beyond devhub's two indexes and READMEs.** That means `Read(//<root>/_devhub/manifest.json)`, `Read(//<root>/_devhub/references.json)` and `Read(//<root>/**/README.md)`, added by `withWorkspaceRead`. There is no bare `Read`, because `<root>/.env` holds shared secrets and `/proc/<pid>/environ` holds canopy's tokens, and WebFetch could carry either out. There is no `gh api`, because `gh api -X POST user/repos` makes a public repo. There is no `git clone`. The spec's research row had all three.
4. **Filing through devhub and moving a rejected seed wait.** Seeds are peer-synced, and a move on the mini leaves the Mac's copy at the old path. A live or rejected seed stays at `_incubator/<slug>`.
5. **A park with no gated flow behind it joins the inbox** as a `sprout` item of kind `park`, offering continue, retry and stop through the existing resume and stop routes. A park behind a gated flow is already in the inbox as that flow's gate.
6. **Seeds stay peer-synced.** Scaffold's check requires `.gitignore` to cover `node_modules`, `.vercel` and `.env.local`, so no WIP snapshot carries a dependency tree or a token.
7. **Checks reach canopy's CLI as `"$CANOPY_CLI"`.** `runCheck` (`core/check.ts`) sets it to `bin/canopy-check`, which runs `bin/canopy.ts` with `"$CANOPY_BUN"` (the server's own bun) under `--config=/dev/null --no-env-file`. A check runs in the seed, and bun reads `./bunfig.toml` (whose `preload` runs code) and `./.env` from its cwd, so neither is read. That is how scout's check runs `canopy incubator pick-check` in the container, where `canopy` is not on PATH. Clarify's check runs its bun the same way.
8. **`VERCEL_TOKEN` is read once, into the ship config, and deleted from canopy's env** (`SECRET_ENV`). It goes only into the env of the `vercel` processes `ship` spawns, and never onto an argv, where `ps` would show it to every agent in the shared pid namespace. An optional `VERCEL_SCOPE` names a team. Like the vault token, it stays readable through `/proc/<canopy>/environ` in the shared pid namespace, which deleting it cannot reach, so the docs ask for a token scoped to one team kept for incubator projects.
9. **The Vercel CLI is installed in the image**, pinned (`vercel@61.1.0`), the same way codex is. A backend without it parks with "the vercel CLI is not installed on <backend>".
10. **A judge rejection at scout's Eval ends the sprout as `rejected`** with the judge's reason in `parked`, and stops the gated flow. A rejection anywhere else parks, as a gate does now.
11. **New input after a pick drops the pick**, so the chain clarifies again, scouts again and builds again. `nextWorkflow` reads the flows, so a `build-new` from before the newest scout does not count.
12. **The ship pushes from a bare clone canopy makes, never from the seed.** The seed's `.git/config` is the agents' to write, and a `remote.origin.pushurl`, a `url.<x>.pushInsteadOf` or a `credential.helper` there would send canopy's push, or its token, where they chose. `push` runs `git clone --bare --no-local` of the seed into a scratch folder, sets `origin` there, pushes `HEAD` to `main` with hooks and fsmonitor off, and removes the folder. The seed gets no `origin` of its own; the sprout's record holds the repo.
13. **The deploy runs from a clean clone, with the project pinned.** `deploy` clones the seed's `HEAD` into a scratch folder, so nothing uncommitted or ignored (`.env.local`, `.vercel/`) is uploaded, and removes `.vercel/` from it. It refuses a `vercel.json` that sets `alias` or any key off the allowlist (`$schema`, `buildCommand`, `outputDirectory`, `installCommand`, `framework`, `cleanUrls`, `trailingSlash`, `rewrites`, `redirects`, `headers`), and any other config file the CLI reads (`now.json`, `vercel.toml`, `vercel.ts` and its script forms, which run code in a process that holds the token). The vercel children get `VERCEL_ORG_ID` and `VERCEL_PROJECT_ID` from `GET /v9/projects/<name>`, and a project the API will not name by id and team is never deployed. After the deploy, the sprout parks when the API will not describe the deployment or reports an alias off `vercel.app`.
14. **`.canopy/` stays private.** The deploy's folder gets a `.vercelignore` with `.canopy/` as its last line, so no negation before it brings a note back. The smoke check also GETs `<url>/.canopy/intent.md` under the same redirect rules, and parks with "the deploy serves the repo root; .canopy/ is public" when the body is the file itself. A 200 with another body, a single-page app's fallback page, is live, since an SPA answers every path. The project is made with `framework` `vite` or `nextjs` when `package.json` names that dependency, so Vercel does not serve the repo's root.

Also in phase 3:

- The Vercel project name: canopy makes the project through `POST /v11/projects` under the first candidate `GET /v9/projects/<name>` answers 404 for, going on to the next on a 409, so it never deploys over a project the account already has.
- The smoke GET uses redirect "manual". It follows only same-host https redirects, by hand, at most 5. A redirect to another host, or one with no usable Location, is a sign-in page and not live. A sixth hop is a loop.
- The Shipper replaces `VERCEL_TOKEN` with `***` in any error text built from vercel output.

### Amendment 3: token-free stages, 2026-10-02

The design is `2026-10-02-incubator-token-free-stages-design.md`, built on `feat/incubator-phase-3` (parts 1 to 2b) and `feat/incubator-stages` (part 3).

**What it replaces.** It replaces amendment 2's residual that an agent that runs code shares canopy's uid and pid namespace, and so can read `/proc/<canopy>/environ` and the mounted `~/.ssh`. Under the stage runner that no longer holds. On a backend that runs stages unisolated (`CANOPY_INCUBATOR_UNISOLATED=1`, the Mac), it still does, and the env scrub (`stageEnv`) stays as defense in depth there. Amendment 2's note on rule 7, checks reaching canopy's CLI as `"$CANOPY_CLI"`, is replaced for scout and clarify by built-in checks.

**Canopy's git never runs a seed's config.** Every git call canopy makes on a path under `<root>/_incubator/` goes through a guard (`guardSeed` in `core/seedgit.ts`): in `git()`, in `seed.ts`'s own git calls, before ship clones a seed, and in the peer gate before it serves one. The guard reads the `.git/config` git itself would use with `--no-includes`, allows only the keys canopy and plain commits write, and refuses any other key, a url holding `::` or starting with `-`, a gitfile or symlinked `.git`, a `commondir` or `config.worktree`, and a `.git` with no `HEAD`. Every allowed call carries `GIT_CEILING_DIRECTORIES` at the seeds dir and flags that turn off fsmonitor, hooks, `ext::`, implicit bare repos and submodule recursion. Its reading is memoized by the config file's ctime, inode, size and mtime. A refused seed shows the reason as its scan error and the sprout parks with it. Canopy runs no git in a seed while a stage process or check is alive there, and keeps the card's last status meanwhile.

**A stage reads no settings of the seed's, and nothing starts in a seed on its own.** A stage Claude run uses `--setting-sources user`. Canopy drops every Codex trust table under `<root>/_incubator/` from Codex's config at start and before every stage Codex run (`core/codextrust.ts`), so Codex never reads a seed's own config. A task in a seed never starts by `keep` or start-with-panel, a shell in a seed never starts an agent (start, resume and restore with continue are refused, and the UI offers none), a commit suggestion for a seed runs from a scratch folder with the stage env, and the launcher does not build a seed.

**Stages run in a container with no tokens.** The `stages` compose service holds claude, codex, bun and git, and no token, `~/.ssh`, `~/.config/git`, `.env` or docker socket. It has its own pid namespace and network, and mounts only `_incubator` read-write, `_incubator/.shared` read-only over it, its own claude and codex logins, and the runner's socket volume. Canopy starts a process there only through the stage runner (`src/stage/runner.ts`), one connection per process. The runner starts only `claude`, `codex` or `sh`, only in a seed, with an env of its own base plus three `CANOPY_*` names, and kills the tree, the process group and every process with its cwd in the seed when the run ends. It also answers `hello` (its harnesses) and `busy` (whether anything runs in a seed). `StageClient` (`core/stageclient.ts`) is canopy's side: an `RpcSpawn` for both drivers through `DriveCtx.spawn`, handed out through `RunnerOptions.stageExec`, and an `exec` for checks. `@pick-check` and `@questions` are built-in checks that canopy runs in its own process over `readSeed` (`core/builtincheck.ts`); any other check line runs as shell through the runner. A stage reads its inputs and a per-sprout workspace snapshot from `_incubator/.shared/` (`core/stageshare.ts`), and nothing from `canopy-config` is mounted. Stages fail closed: with `CANOPY_STAGE_SOCKET` set every stage runs through the runner, and while it is away sprouts stay queued and flows park, then resume on their own at the next good hello; without it, stages start only under `CANOPY_INCUBATOR_UNISOLATED=1`. The network fence (`scripts/stages-fence.sh`) drops, in the raw table's `PREROUTING` on the stages bridge `br-canopy-stg`, every packet to a private, tailnet, link-local, multicast or broadcast address and every IPv6 packet, through a root-owned copy and a boot unit ordered before docker. The stages resolve through public DNS, and a fence check in the stages image (`src/stage/fencecheck.ts`) shows what it blocks.

**Residuals.**

- **Residual:** a stage can read its own Claude and Codex OAuth credentials, in the stage config dirs. This is inherent to running the agent.
- **Residual:** a stage can write `_incubator/` itself (a `.git` there, a `.gitattributes`), so the guard never trusts it: seed git calls carry `GIT_CEILING_DIRECTORIES`, canopy runs no git in the seeds dir, and the scan never takes it as a repo.
- **Residual:** a stage can write any seed under `_incubator/`, including other sprouts' seeds. `.shared/` is read-only, but a stage can read every sprout's `.shared/inputs/`.
- **Residual:** what the user starts by hand in a seed (a task, a plain shell and whatever they type there, the guided panel's run button) runs in the shells container with its tokens. That is the user's act. The incubator view says so on a seed's sheet.
- **Residual:** stage egress to the internet is open, so an agent can still send what it can read: the seed, the shared inputs, its own OAuth credentials.
- **Residual:** a stage process that calls `setsid` and then `chdir("/")`, or double-forks out of the tree, escapes the three kill layers at the end of its run: the tree, the process group, and the cwd sweep. The runner, as pid 1's child in its own pid namespace, also kills every orphan there at each run's end and every 30 s (`sweepOrphans`). It spares pid 1, itself, the trees of live connections, and trees whose top has ppid 0 (what `docker exec` starts, the healthcheck among them), and stops each process before it kills it. Such a process now lives until the next sweep, not until the container stops.
- **Residual:** while it lives, such a process can unlink the runner's socket and serve its own. It could then answer `busy: false` while seed processes live, pass the healthcheck, take later runs' spawn requests, and report shell checks as passed. Built-in checks and judge gates run in canopy and are out of its reach. A token is reachable through it: a false `busy: false` lets canopy run git in a seed, the process swaps that seed's `.git/config` between canopy's guard and git's own read, and git then runs the config's commands as canopy, which holds every token. This fix closes most of that. Orphans die at each run's end and every 30 s, and the canopy server runs no git in a seed while any stage is alive: a check or run in any seed, or a stage process until the runner calls its seed quiet, makes every seed busy, and a runner that keeps saying busy keeps them busy. What stays open is a process alive between two sweeps, and the peer gate (`canopy peers gate`), a process of its own that never sees the server's busy rule, so a peer's fetch still runs upload-pack in a seed while a stage is alive. The fix for both is to read seed status and serve seeds through the stage runner, so canopy runs no git in a seed at all. A socket taken over and then swept leaves the real runner unreachable, so stages park until the stages container restarts. Canopy and every stage process share the host uid across both containers, so no file mode or peer credential tells them apart. The socket fix: run the runner as root, have it drop its children to the `bun` user, and put the socket dir at `root:stagecaller 0750` with `group_add` on canopy.
- **Residual:** if the fence unit fails at boot, docker still starts stages unfenced, since the unit is not `RequiredBy` docker (that would take every container down). A missing fence now holds every stage instead of letting it run: the stage runner starts nothing until its probe of `CANOPY_FENCE_PROBE`, a URL past the host that answers whenever nothing drops the packet, times out. It probes at start and every 5 minutes, refuses every spawn while the target is unset, answers, or fails some other way, and says so in its hello, so canopy shows "stages unfenced", holds the queue and parks a flow's step until a hello says fenced. What stays open is a fence that drops the probe target while letting something else through, which the deploy docs' fence check covers.
- **Residual:** every stage runs as the same user in one long-lived container, so a stage that runs code can leave files a later stage reads. What a later stage runs is closed: claude and codex sit in root-owned `/opt/stage-tools`, the PATH names root-owned folders only (the build fails otherwise), the stage runner refuses a program whose file or any folder above it its own user can write, `DISABLE_AUTOUPDATER=1` stops claude replacing itself, and stage checks run `sh -c`, not a login shell. The settings that steer a later stage are checked: before each spawn the runner refuses while `$CLAUDE_CONFIG_DIR/settings.json` or `settings.local.json` holds a key other than `$schema`, `model` or `theme`, or `$CODEX_HOME/config.toml` holds a top-level key other than the model, reasoning, personality, service tier, login method and `notice` (seed trust tables are swept first), naming the file and the key, and the step fails until the user removes it by hand. Still open, in the home: `~/.bashrc` and `~/.profile` (claude's Bash tool starts a shell that reads them), `~/.bunfig.toml` (a preload for every later `bun`), `~/.gitconfig` (hooks, aliases, an fsmonitor for every later git), and anything else a later stage's tools read from there. Still open, in the two mounted config dirs, which the settings check does not read past its three files: `CLAUDE.md` and `AGENTS.md` memory, skills and commands, `.claude.json` (per-project `allowedTools`, trust and MCP entries) and the logins' credentials. The open hardening step is `read_only: true` on the stages service with a tmpfs home. It would close every write outside the home, the seeds and the config dirs, and a stage's leftovers in the home would last only until the container restarts, not for good: within one container's life a tmpfs home is as writable as today's. Closing the home files for good takes a home that is itself read-only, with only the config dirs and the seeds writable, and the config dirs' own files stay open either way.
- **Residual:** the fence script can be swapped between reading it and running `sudo ... --install`, since the checkout is writable by canopy's containers and peer sync. The deploy docs narrow this by copying the script to a root-owned path first, reading that copy, and installing from it.
- **Residual:** a runner that dies during a check reads as a failed check and spends a retry. The check's connection closes with no exit frame, which reads as a kill (137), and only a runner that is away when a check starts makes the check wait for it.
- **Residual:** under mode `off` or `unisolated` no watch runs, so a stage park waits for a resume by hand.

### Amendment 4: hardening, 2026-10-03

Built on `feat/incubator-hardening`; the plan is `docs/superpowers/plans/2026-10-03-incubator-hardening.md`.

**Why.** On 2026-10-03, on the mini, sprout `sp_e77e1e62f5a8` (a bill splitter) passed scout, with Research and Eval done and `pick.json` saying new on vercel, and then sat in `researching` with no build flow. `Incubator.scouted()` commits the scout files through `seeds.commit`, which waited for every seed to go quiet, and the other sprout's scout was still running. Under `SPROUT_CONCURRENCY` 2 and `SEED_QUIET_MAX` 2 h, one sprout's long build-new would hold the other's transitions and then park it for no reason of its own. The rule that every seed is busy while any stage lives existed only for amendment 3's socket-takeover residual: a stray stage process fakes `busy: false`, swaps a seed's `.git/config` between canopy's guard and git's own read, and git runs it as canopy, which holds tokens. This amendment takes canopy's git out of the seeds on an isolated backend, so that rule can go, and closes the socket and home residuals as far as they go.

Rulings:

1. **On an isolated backend canopy runs no git in a seed; the stage runner does.** `git()` (`core/exec.ts`) is the one seam every git call canopy makes in a seed goes through: the scan, the watcher's status read, the diff and commit routes, `seed.ts`'s commit, and the bundle below. With `CANOPY_STAGE_SOCKET` set, a git call on a path under the seeds dir goes to the runner as a `git` request (`{seed, args, env}`) and runs in the stages container as the stage user. It is one general request, not narrow kinds (status, commit, bundle): narrow kinds would leave every other git call a seed card makes to be refused one by one, and the property is the same either way, since every child of the runner is token-free. The runner runs `git` with `SEED_GIT_FLAGS` ahead of the args, only in a seed's own top folder, with an env of its own: `PATH`, `LANG`, `LC_ALL`, `HOME` and `XDG_CONFIG_HOME` at `/nonexistent`, `GIT_CONFIG_NOSYSTEM=1`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_CEILING_DIRECTORIES` at the stage root and `GIT_TERMINAL_PROMPT=0`, plus from the request only `GIT_OPTIONAL_LOCKS` and the author and committer names and emails. A request env with any other name is refused, in canopy before it is sent and again in the runner, since dropping a name like `GIT_INDEX_FILE` would silently change what a command writes.
2. **A git request waits for the fence, as a spawn does.** A seed's config is the agents' to write, so git there may run their code, and nothing runs in the stages container unfenced. While the runner is away or unfenced, git in a seed answers `SEED_AWAY`, which the scan, the watcher and canopy's own commit treat as they treat `SEED_BUSY`: the card keeps its last status and is read again later, and a commit waits. It never falls back to local git.
3. **A git request is a run to the runner's sweeps.** The orphan sweep and another run's seed sweep spare it. Its own end kills its tree and its process group, not everything in the seed. A git process counts in a `busy` answer like any other.
4. **The guard stays.** `guardSeed` and `SEED_GIT_FLAGS` still run in canopy before a git request is sent, as defense in depth, and they are the whole guard on an unisolated backend (the Mac, `CANOPY_INCUBATOR_UNISOLATED=1`), where git in a seed runs in canopy's process as before.
5. **A seed is busy on its own on an isolated backend.** A seed is busy while a check runs in it, a stage run on it is active, or a stage process there is held by `holdQuiet`; no other seed is. One sprout's long build no longer holds another's commit, status read or ship. Within one seed the order stays: canopy reads or commits a seed only once its own stage is quiet, so it never commits while that seed's stage is mid-write, and its git never lands in the seed sweep at a run's end. An unisolated backend keeps the global rule: its stages run as canopy, and nothing there changes.
6. **The ship clones from a bundle, never from the seed.** `bundleSeed` (`core/seedmirror.ts`) runs `git bundle create - --all HEAD` through `git()`'s seam, waiting for the seed to be quiet, with stdout streamed into a scratch file canopy owns. A bundle is plain data: canopy reads its HEAD with `git bundle list-heads` and clones it without running anything of the seed's. `push` clones it bare and pushes the bundle's HEAD commit to `main`; `deploy` clones it without a checkout and checks that commit out detached. A seed with no commit has no bundle, and the ship fails with that reason.
7. **A mirror per seed, for the peer gate.** Canopy keeps a bare mirror of each seed at `<root>/.canopy-mirrors/<slug>/.git`, inited and configured by canopy alone, updated by a fetch of `+refs/*:refs/*` with prune from a fresh bundle, with its HEAD set detached to the bundle's HEAD. It sits in the dev root because the gate runs on the host as the user, from `authorized_keys`, and cannot read canopy's config volume; the stages container mounts only `_incubator`, so no stage can write it. The bare repo is named `.git` because the Mac's `sync-dev-to-mini.sh` treats any folder holding a `.git` as a repo and leaves it out of its delete pass, which would otherwise remove a mini-only dot folder every two hours. A missing mirror is made again at the next sync. A mirror syncs after canopy's own commit in a seed, after a run's or a flow's outcome is read in a seed, and at the top of each activity pass, and only when the seed's refs or HEAD differ from what it last took. The gate serves what the mirror last took, at most one activity pass behind.
8. **The peer gate runs no git in a seed, on any backend.** `git-upload-pack` of `<root>/_incubator/<slug>` (or of its `.git`) serves `<root>/.canopy-mirrors/<slug>/.git`, and refuses when there is none; any other path that leads into the seeds dir, by name or through a symlink, is refused. `canopy-peer list` reports a seed with no origin without running git (a seed never has an origin, amendment 2 ruling 12), and `canopy-peer seeds` and `seed` refuse a seed. No flag turns this on, so a gate whose mirrors are gone refuses rather than serve the seed.
9. **On an isolated backend seeds leave the peer pass.** `initRepo` would write peer remotes into a seed's config; `snapshotWip`, the peer fetch, the fast-forward and the wip reads would run git there; and the stages container has no ssh key and the fence keeps it off the tailnet. So the peer pass, the peer routes, the background fetch and `cloneMissing` leave every path under `_incubator/` alone there. Seeds flow one way: a peer reads an isolated backend's seeds from its mirrors, and nothing a peer commits to its own copy comes back.
10. **The runner runs as root and drops every child.** Each child, git included, starts through `setpriv --reuid=<uid> --regid=<gid> --clear-groups --no-new-privs` (`CANOPY_STAGE_UID` and `CANOPY_STAGE_GID`, baked into the image from the build args), so it carries no supplementary group and cannot gain one. Whether the stage user could write a program or a folder above it is judged from `stat` for that uid and gid (`writableBy`), since `access(W_OK)` as root says yes to almost everything. `sweepCodexTrust` keeps `config.toml`'s owner when it rewrites the file as root. A runner started as root without a stage uid, or with uid 0, refuses to start.
11. **The socket dir is `root:stagecaller 0750` and the socket `root:stagecaller 0660`.** The runner sets both at every start, since the `stage-sock` volume on the mini keeps the ownership it was first made with. Canopy's service carries `group_add` with stagecaller's gid (`STAGECALLER_GID`, default 7850). A stage child holds no supplementary group, so it cannot enter the dir: it can neither connect, nor unlink the socket, nor bind one of its own there.
12. **The stage uid stays the host uid, canopy's.** Canopy (`makeSeed`, `writeSeed`, `.shared`), the stages, the user's shells and peer sync all write the seeds as the host uid. A second uid would need a shared group, setgid folders and a group-writable umask in every one of them, the Mac's editors included, and a file one side made 0644 would lock the other out. The socket fix does not need it: the gate on the socket is the group, and the two containers' pid namespaces keep processes of the same uid apart.
13. **The stages container is read-only.** `read_only: true`, with a tmpfs at `/home/bun` (the stage uid and gid, mode 0700, 2 GB, which bun's install cache shares) and one at `/tmp` (mode 1777, 1 GB). The tmpfs hides the image's own home (`.bashrc`, ble.sh), so a stage's shells start plain. Both are mounted `exec`: docker makes a tmpfs noexec by default, and build-new's `bun create` unpacks and runs a package under `/tmp`, as `bunx` does, and a browser install lands in `~/.cache`. noexec would close little, since a stage can plant a program in the seed it works in. `nosuid` and `nodev` stay. The runner and its healthcheck run as root with `BUN_RUNTIME_TRANSPILER_CACHE_PATH=0`, so root never makes a cache folder in the stage user's home.
14. **Made while building.** The gate runs `git-upload-pack --strict` on a mirror, so no suffix is probed past it, and maps only a seed name that is one plain segment (`mirrorSlug`); anything else under the seeds dir is refused. `mirrorRefusal` compares the mirror's real path with the one canopy keeps, so a link in its place is refused. `serveList` and `serveSeeds` also treat a repo outside the seeds dir whose `.git` leads into one (a link, a gitfile, a commondir) as a seed. A root start refuses a caller gid equal to the stage gid, since a stage would then hold the socket's group. `writableBy` counts a sticky world-writable folder as writable. The stages container now runs as root, so a login or any exec that acts as a stage names the user (`docker compose exec -u bun`). The gate also refuses a mirror whose seed is gone (`mirrorRefusal` lstats `_incubator/<slug>` as a real folder), since a mirror outlives its seed.

**Residuals, as amendment 3 left them and as they stand now.** The token-free stages spec's list is updated to match.

- **Closed:** the peer gate running upload-pack in a seed (ruling 8), and canopy's git running a seed's config as canopy on an isolated backend (ruling 1). A `.git/config` swapped between the guard and git's own read now runs as the stage user in the stages container.
- **Narrowed:** a stage process that escapes the kill layers still lives until the next orphan sweep, but it can no longer take over the runner's socket (ruling 11). While it lives it can do what any stage can: write any seed, and make canopy's reading of a seed (a card's status, a commit's result, a bundle) say what it chose. That reaches a card, a commit and what a ship deploys, never a token.
- **Narrowed:** a stage's leftovers in the home last until the stages container restarts, not for good (ruling 13), and nothing outside the home, `/tmp`, the seeds, the socket dir and the two config dirs is writable. Still open within one container's life: `~/.bashrc`, `~/.profile`, `~/.bunfig.toml`, `~/.gitconfig`, bun's install cache and anything else in the tmpfs home a later stage's tools read. Still open for good: the config dirs' own files (`CLAUDE.md`, `AGENTS.md`, skills, commands, `.claude.json`, the logins), as before.
- **New:** seeds flow one way between an isolated backend and its peers (ruling 9). A commit made to a peer's copy of a seed stays there; to bring it back, push it from a shell on the backend, which is the user's act.
- **New:** a peer reads a seed as its mirror last took it, at most one activity pass behind (ruling 7). A slug used again after its seed was removed overwrites the old mirror (the fetch is forced and prunes), so a peer that kept the old seed's copy sees it diverge.
- **New:** a `canopy` command typed on the backend's host (`canopy peers sync`, `canopy tree`) runs git in a seed as the user, behind the guard only where that command sets the seeds roots. That is the user's act, like a shell.
- **Unchanged:** an unisolated backend keeps the global busy rule and runs seed git in canopy's process behind the guard; its stages run as canopy and can read its tokens, as amendment 3 says.
