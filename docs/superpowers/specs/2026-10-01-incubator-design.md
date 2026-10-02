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
  deploy, file.
- `renovate.md`: pull upstream into the seed and add the `upstream` remote,
  renovate, test, accept, deploy, file.
- `extend.md`: branch `new/<slug>` in the target repo, build, test, accept,
  push the branch. Never merges. The seed moves to `_incubator/handed-off/`.
- `retro.md`: one step, below.

The last step of `build-new` and `renovate`, file, runs
`canopy library import <seed path>`, so devhub classifies the project into its
category. It runs after deploy so no flow's repo path moves under it; the
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
contents, clipped to 6 KB each and 20 KB in all, join the summary in the text
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
| research | read, `WebSearch`, `WebFetch`, `Bash(gh search:*)`, `Bash(gh repo view:*)`, `Bash(gh api:*)`, `Bash(git clone:*)`, `Write` under `.canopy/` |
| build, renovate, extend | `Edit`/`Write` in the repo, `bun`, `bunx`, `git-read`, `git-commit`, the project's own scripts |
| test | `bun`, `bunx`, the project's scripts, `Bash(curl:*)` against the preview |
| deploy | `git-push`, `Bash(vercel deploy:*)`, `Bash(vercel link:*)`, `Bash(vercel env:*)`, `Bash(firebase deploy:*)`, `Bash(bunx convex deploy:*)` |
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
