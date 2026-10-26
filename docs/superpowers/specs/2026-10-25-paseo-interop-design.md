# Paseo interop study (FR-046)

FR-046 asks a question, not for a build: should canopy speak to Paseo
(https://github.com/getpaseo/paseo, https://paseo.sh), and if so how? The
research (`2026-10-25-software-factory-borrowings-design.md`) names Paseo
canopy's closest architectural sibling: a self-hosted daemon with desktop,
iOS, Android, web and CLI clients, a worktree per agent, agents that make
worktrees and start and talk to other agents through an MCP server, local
voice, an end-to-end encrypted relay or Tailscale, a Docker image, and a
Docker-style CLI. If Eric ever wants native phone apps without writing
them, a Paseo-compatible surface on canopy or a landing-queue plugin inside
Paseo are the two realistic paths. This spec sets the questions, how to
answer each, the thresholds that make each outcome the right one, and a
time box. Its answers are written back here as an amendment.

## Where things stand (2026-10-25)

What the web said today, fetched 2026-10-25 (the GitHub page itself was not
reachable from this session; the README came through a jsDelivr mirror of
`main`, the repo stats through a mirror dated 2026-10-24, the protocol notes
through DeepWiki's reading of the code, and the SDK reference from
paseo.sh):

- **Licence: Apache-2.0.** The README's License section says so, and the
  mirror agrees. The AGPLv3 the research saw on one comparison page is not
  what the repo says. To confirm against `LICENSE` at HEAD on the day of
  the study.
- **Health.** 6,089 commits on `main`; the newest on 2026-10-24
  ("fix(opencode): show model details on v2 subagent rows (#7799)"); a
  release `0.13.0` cut the same day; TypeScript 97.7%. Pull request numbers
  near 7,800 say many hands. The research put it at 21–22k stars. This is a
  live project.
- **Shape.** "Paseo runs a local server called the daemon that manages your
  coding agents." Clients: an Electron desktop app, an Expo app "native on
  iOS and Android", a web client, the `paseo` CLI (`paseo`, `paseo run
  --provider … --worktree … --host … --cwd …`, `paseo ls`, `paseo attach
  <id>`, `paseo send <id> "…"`), a VS Code extension, and a TypeScript SDK
  `@getpaseo/client`. Agents: Claude Code, Codex, GitHub Copilot, OpenCode,
  Pi, Antigravity, Muse Code.
- **Protocol.** WebSocket to the daemon at `ws://<host>:6767/ws`; typed
  JSON envelopes from a package `@getpaseo/protocol` (`WSInboundMessage`
  and `WSOutboundMessage`, Zod schemas with wire-compatibility tests);
  binary frames for terminal output and file transfer (`TerminalStreamOpcode`
  slots); named types include `create_agent_request`,
  `cancel_agent_request`, `agent_stream`, `workspace_update`, and a `hello`
  after auth carrying `clientId`, app version and `clientCapabilities`.
  Listen targets are TCP, Unix sockets, Windows named pipes and the relay.
  No protocol version number; compatibility is by client capability flags
  (`CLIENT_CAPS`), with the daemon skipping message types an older client
  lacks and hosts answering `unsupported_capability`.
- **Auth and reach.** A bearer token checked at the handshake (unauthorised
  sockets close with `4401`); the Docker image takes `PASEO_PASSWORD`; the
  SDK takes `password` or a whole `authHeader` "for a proxy". Setup offers
  "the end-to-end encrypted relay for device pairing" (an official relay,
  `getpaseo/paseo-relay`, in Elixir; clients set `e2ee.enabled` and
  `e2ee.daemonPublicKeyB64`), else "connect directly over TCP, Tailscale,
  or another VPN". A phone pairs through "Settings → your host → Pair
  Device", and the SDK's `hosts` namespace has `list`, `add`, `update`,
  `remove`: a client talks to several hosts.
- **What a client can do** (SDK reference): `agents.list | create | ref |
  subscribe`; on an agent `send`, `respondToPermission({response: allow |
  deny})`, `run`, `waitForFinish`, `archive`, `detach`, a `timeline`;
  `workspaces.list | open | create | archive` with `setTitle` and nested
  `agents.create` and `terminals`; `terminals.create | list | ref` with
  `write`, `sendKeys`, `capture`, `kill`; `providers.listUsage |
  listModels | …`; `config.get | patch`; `projects.list`. So a Paseo client
  lists agents, drives them, answers permissions and types into terminals.
- **Extension points.** Plugins "run on the daemon and appear in every
  connected client", adding "screens, sidebar items, slash commands, themes,
  and providers" and changing "agent configuration, MCP servers, and
  permissions"; installed with `paseo plugin add owner/slug` or from Git or
  a folder; the README warns they "run with access to your daemon machine".
  Skills ship through `npx skills add getpaseo/paseo`. The daemon package
  lists an MCP server.
- **What canopy has that Paseo does not say it has:** a landing queue with
  gates, review rules and approvals; a board of every repo on every machine
  with Forgejo and ssh sources; health checks that heal; the ranger;
  triggers from Sentry and Linear; a cost ledger. What Paseo has that canopy
  does not: native phone apps, an E2EE relay that needs no tailnet, a plugin
  system, an SDK, a typed client protocol with compatibility tests.
- **canopy's own surfaces.** REST plus SSE at `/api/events`, websockets for
  shells (`/api/term`), caller tokens with rights (`core/callers.ts`), the
  `canopy` CLI. FR-038 (`2026-10-25-agent-surface-design.md`) adds an MCP
  server and run-bound tokens; FR-042 (`2026-10-25-pwa-push-design.md`) is
  the mobile answer without Paseo.

## The questions

Each with how to answer it and what answer counts.

1. **Licence.** Read `LICENSE` at HEAD and the licence of `@getpaseo/client`
   and `@getpaseo/protocol` on npm. Apache-2.0 everywhere means canopy may
   depend on the SDK and the schemas, and a plugin canopy contributes
   carries Apache-2.0 or a compatible licence (FR-045 proposes MIT for the
   package). If any of the three were AGPL, an **adapter** that only speaks
   the wire protocol would still be clean (a protocol is not code), but a
   canopy that imported `@getpaseo/protocol` would not be; that would push
   the adapter to re-type the schemas by hand. Counts for interop: Apache or
   MIT on all three.
2. **Is the protocol a public contract?** Is `@getpaseo/protocol` published
   and documented, or does it live only in the monorepo and change under
   the clients? Read its changelog across the last ten releases and the
   wire-compatibility tests. Counts: a published package with a stated
   compatibility rule. Against: schema changes landing with app releases
   and no notice.
3. **Can canopy's things be Paseo's?** Map canopy's runs (a `Run`'s steps,
   prompt, session), shells (tmux panes over websockets), asks (tailchan's
   hook, the answer key) and landing entries onto Paseo's `agent`,
   `terminal`, permission and `workspace`. Concretely: can an `agent_stream`
   carry a canopy run's `RunStep`s, can `respondToPermission` answer a
   canopy prompt or an ask (the answer key lives in the browser, never on
   the server: a Paseo client answering through canopy would need the key
   to travel through the adapter, which is the same hole FR-042 refused for
   notification actions), can a canopy shell be a Paseo `terminal` (binary
   frames, `sendKeys`, `capture`). Counts: runs and shells map cleanly;
   asks map read-only; the landing queue has no counterpart and would be a
   plugin screen. Against: Paseo's agent model assumes it started the
   process (a `create_agent_request` with a provider), so a canopy run
   started elsewhere may not fit `agent` at all.
4. **Can the phone point at canopy?** Does the iOS app take any host (an
   address and a password, or only a relay pairing)? If a host must be
   paired through the relay, canopy would have to speak the relay's E2EE
   protocol too, which doubles the adapter. Counts: a direct host with a
   password or bearer, reachable over the tailnet. Against: relay-only
   pairing.
5. **What may a plugin see and do?** For the **contribute** path: can a
   plugin read an agent's worktree path and branch, run commands on the
   daemon machine (the README says plugins have its access), add a screen
   that lists entries with a button, and hold or release a merge? Read the
   plugin API's types and one real plugin. Counts: yes to all four, and a
   maintainers' word that a landing plugin is welcome (an issue opened
   first). Against: plugins limited to UI and provider config.
6. **Health over 90 days.** Commits per week, distinct authors, time from
   issue to answer, releases. Counts: steady commits from more than two
   people and releases at least monthly. Against: one author and a slowing
   graph, which is how Vibe Kanban and Terragon looked before they stopped.
7. **Voice and usage overlap.** Paseo's local STT/TTS (Parakeet, Kokoro,
   Sherpa ONNX) and `providers.listUsage` are things canopy does another way
   (ElevenLabs and GPT-Live; FR-036's governor). Note what they do, take no
   action; it informs FR-036's probe list.

## The three outcomes

### Adapter

canopy adds a `paseo` listener: a second `Bun.serve` on its own port (the
pattern the coordinator's lane set, `CANOPY_PASEO_PORT`), speaking
`@getpaseo/protocol` for a read-mostly first cut: `hello`, list agents (every
run and every registry card as an agent), `agent_stream` for a run's steps,
terminals for canopy's shells (the same pty bridge `core/term.ts` has, framed
Paseo's way), `workspace_update` for the repo tree. Operate comes later and
only for what needs no answer key: start a run, send a chat message, stop.
Permissions stay read-only through this surface until the answer key has a
home outside the browser.

- Reach: the tailnet alone, with canopy's own token as Paseo's bearer. No
  relay.
- Risks: a protocol with no version number means every Paseo release can
  break the adapter; the agent model may not fit runs started by canopy's
  triggers and flows; a second full client surface to keep honest beside
  the SPA and the CLI; and it reproduces FR-042's result (a phone that
  shows what waits) at several times the cost.
- Worth it only when the phone apps are the reason, the protocol is a
  contract (Q2), and the direct host works (Q4).

### Contribute

A landing-queue plugin in Paseo, built on FR-045's package
(`2026-10-25-landing-package-design.md`): when a Paseo agent finishes on a
worktree, sort the diff, run the gates from the repo's `.canopy/gates.json`
(or Paseo's own name for it), fast-forward or hold with the sensitive files
shown in a plugin screen. canopy itself changes nothing; Eric's idea
reaches Paseo's users.

- Needs Q1 and Q5 to count, and FR-045's plan 1 to have gone.
- Risks: a plugin API that moves; a maintainers' no; the package's Node
  path (no `Bun.Transpiler`) sorting every JS change as `logic`, which a
  Paseo daemon on Node would hit unless the plugin brings esbuild.

### No

Keep FR-042's PWA as the mobile answer, FR-038's MCP server as the agent
surface, and watch Paseo the way canopy watched Kilo and Orca: for ideas.
This is the default, and it is what the thresholds below fall to when any
of them fails.

## Decision thresholds

- **Adapter** when all of: Q1 Apache or MIT on the protocol package; Q2 a
  published protocol with a compatibility rule; Q3 runs and shells map
  cleanly; Q4 a direct host with bearer auth works from the iOS app over
  the tailnet; Q6 healthy. And Eric wants the phone apps more than the PWA.
- **Contribute** when all of: Q1 clean; Q5 plugins can see worktrees, run
  commands and add a screen; a maintainer answers an issue positively
  within the time box; Q6 healthy. And FR-045 has a go.
- **No** otherwise. A "no" is written up with the dated answers so the
  question is not re-asked for six months unless Paseo changes.

## What canopy keeps regardless

The daemon-plus-clients shape (one always-on backend, many pages); the
landing queue and review rules; the board of every repo on every machine
over the tailnet; Forgejo and ssh sources; runs on the user's own `claude`
and `codex` binaries. None of the three outcomes trades any of these.

## Time box and write-up

Two half-days. Day one: Q1, Q2, Q5, Q6 from the repo and npm; open the
issue for Q5. Day two: Q3 and Q4 by hand with the iOS app, a Paseo daemon
in Docker (`ghcr.io/getpaseo/paseo:latest`, port 6767, `PASEO_PASSWORD`) on
the Mac, and canopy's run types beside the SDK reference. The answers go
into this file under `## Answers (date)`, one line per question with the
evidence, then the outcome and the reason. If the time box runs out, the
outcome is "no" with what was learned.

## Not candidates

The research also checked the other session managers and factories, so the
study does not widen into them: Orca (desktop-first, about 100k stars,
daily releases) is where the momentum is, and its agent-callable CLI and
fan-out are already taken by FR-038 and FR-033; Vibe Kanban's company shut
down on 2026-04-10 and the project is sunsetting; Terragon shut down in
February 2026; uzi and Crystal are unmaintained (Nimbalyst continues
Crystal under MIT, as an idea source only); Gas Town's author declared it a
failure in August 2026 and moved on, and Gas City is an SDK for building a
factory, not a client to interoperate with. Optio and Fabro are pipeline
idea sources (FR-034, FR-035), tied to Kubernetes and a Rust binary.

## Components

None until an outcome is chosen. An **adapter** would add
`src/server/paseo.ts`, `src/core/paseoWire.ts` (pure framing, tested
against the SDK's fixtures), `CANOPY_PASEO_PORT` in `.env` and the compose
file, and a "Paseo" section in `docs/architecture.md`. A **contribute**
would add a repo outside canopy that depends on FR-045's package.

## Calls

Made on 2026-10-25:

1. **A study with thresholds, not a build.** The research's "watch or
   interoperate" is a question with a cost on both sides; the thresholds
   make the answer a reading, not a mood.
2. **"No" is the default**, since FR-042 and FR-038 cover the needs an
   adapter would serve at lower cost and no third-party protocol risk.
3. **Read-mostly first for an adapter**, and never permissions through it
   while the answer key lives in the browser.
4. **Two half-days**, since every question has a fast answer once the repo
   is open and the app is installed.

For Eric:

5. Whether the native phone apps are wanted enough to justify an adapter
   at all, before the study spends the second half-day on Q3 and Q4. If
   the PWA (FR-042) is enough, the study is Q1, Q5 and Q6 alone and aims
   only at **contribute**.
6. Whether to open an issue on Paseo's tracker in your name during the
   study (Q5 needs a maintainers' word), which makes canopy's existence
   public in a small way.
7. The six-month quiet period after a "no".

## Out of scope

- Running Paseo as canopy's daemon, or canopy as a Paseo provider: canopy's
  runs are driven over stream-json and JSON-RPC by canopy's own drivers,
  and Paseo's providers are its own.
- Speaking the E2EE relay protocol.
- Adopting Paseo's plugin system inside canopy.
- Any other project in the research's catalogue.

## Testing

A study has no suite. The amendment carries the evidence: the LICENSE
text, the protocol package's version and changelog lines, the SDK calls
tried against a local daemon with their results, the iOS app's host screen
as a photo, the issue link, and the commit graph for 90 days. An adapter,
if chosen, gets its own spec with a `paseoWire.test.ts` replaying the SDK's
fixtures, and that spec is where its tests live.

## Plans

1. **The study**, two half-days, ending in the amendment to this file.
2. **If adapter:** a design spec of its own for the read-mostly listener,
   then a plan.
3. **If contribute:** FR-045's plan 1, then the plugin in its own repo.
