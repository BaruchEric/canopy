# The secret store: every secret in one place, managed from canopy

Date: 2026-10-14. Status: design, approved in conversation, awaiting review of
this file. Companion to the kit spec (`2026-10-14-kit-design.md`), whose MCP
servers take their secrets from here. Touches canopy, its compose file on the
mini (a new `secrets` service), and a new private Forgejo repo `eric/secrets`.

## What the user asked for

"Create centralized secret storage as well with full UI management", after
the kit design asked whether MCP secrets should come from env or OpenBao.
Decided in conversation: the design below, with the Mac's key behind a
passphrase, since agents run unattended there (canopy jobs and flows, and the
daily `desk-sweep` launchd job running headless Claude).

Changed after the chat approval, for review: the chat said "a single sops
file". This spec uses a JSON file whose values are each encrypted with age in
process instead. sops would need the decryption key handed to a child process
(on disk, in its env, or on a pipe), and it encrypts every value to the same
recipients; per-value age lets a value go only to the machines that write it
(see Recipients), and no process but the one holding the key ever sees it.

## Why not OpenBao again

OpenBao and Vaultwarden were retired on 2026-09-07 (the `secrets-management`
skill says why): OpenBao held zero secrets inside a lot of ceremony. This
store starts by importing what already exists, and it is a file plus a small
service, with nothing to unseal.

What exists today, by name only (no value was read for this spec):

| Source | Entries |
|---|---|
| `~/.claude/credentials/.credentials.json` (Mac) | about 10 providers: cloudflare, vercel, github, anthropic, openai, firebase, kasa, bhyve, netgear, google oauth, … |
| `~/dev/.env` (Mac, read by `_control`) | 13 keys |
| `~/dev/dev-tools/canopy/.env` (mini) | 21 keys |
| `/opt/stacks/*/.env` (mini, 12 stacks) | about 120 keys, not all secret |
| `/opt/stacks/{memory,executor}/env.sops.yaml` | sops copies of two of the above |

## The threat this is built for

Agents run as the same user as canopy and can call canopy's API: every canopy
shell carries `CANOPY_API`, and canopy has no login of its own (Cloudflare
Access fronts `canopy.beric.ca`, which a shell on the box never passes
through). On the mini, canopy shares the `shells` container's pid namespace
and uid, and a shell can read canopy's whole filesystem through
`/proc/<canopy pid>/root` (checked on 2026-10-14: `ls /proc/1653/root/config`
from `shells` lists canopy's config). So a key anywhere canopy can read is a
key every shell agent can read. Hence:

- **The mini's keys live in a separate `secrets` service**, with its own pid
  namespace and no volume shared with `shells`, the way the stage runner
  lives apart. canopy talks to it over a unix socket that only canopy's group
  can open.
- **No route returns a value without a human's passkey session**, and the
  `secrets` service, not canopy, verifies the passkey and issues the session.
  Anything that can talk to canopy, canopy included, cannot mint one.
- **A sink is a plaintext file by nature** (`.env`, `credentials.json`, an
  MCP config). An agent that can read a sink can read the values in it. The
  store protects everything else, and the authority to change anything.
- **The Mac is trusted only with what it writes.** An agent on the Mac can
  edit anything canopy reads there, including the pinned key that checks the
  file's signature. Each value is therefore encrypted only to the machines
  whose sinks need it, so a fully compromised Mac exposes the values it
  already writes into plaintext files, and no others.

## Storage

One JSON file, `secrets.json`, in the private Forgejo repo `eric/secrets`
(not mirrored to GitHub, since names, sinks and allowlists are plaintext).
It is kept out of `~/dev` so no peer pass or WIP snapshot touches it. The
writer's checkout is in the `secrets-data` volume, which only the `secrets`
service mounts; the Mac's read-only checkout is at
`~/.config/canopy/secrets`.

```jsonc
{
  "version": 1,
  "keys": {
    "mini": "age1…", "mac": "age1…",
    "breakglass": "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra"
  },
  "secrets": {
    "github-token": {
      "description": "gh and the github MCP server",
      "tags": ["github"],
      "created": "2026-10-14", "rotated": "2026-10-14",
      "to": ["mini", "mac", "breakglass"],
      "allow": ["sink:mac-dev-env", "mcp:github#<definition hash>"],
      "value": "-----BEGIN AGE ENCRYPTED FILE-----\n…"
    }
  },
  "sinks": {
    "mac-dev-env": {
      "machine": "mac", "path": "~/dev/.env", "format": "dotenv",
      "keys": { "OPENAI_API_KEY": "openai-key", "GROQ_API_KEY": "groq-key" }
    },
    "mini-memory-env": {
      "machine": "mini", "path": "/opt/stacks/memory/.env", "format": "dotenv",
      "keys": { "…": "…" }, "restart": "memory"
    },
    "mac-credentials": {
      "machine": "mac", "path": "~/.claude/credentials/.credentials.json",
      "format": "json", "keys": { "providers.github.token": "github-token" }
    }
  },
  "signature": { "by": "mini", "alg": "ed25519", "sig": "…" }
}
```

- **Values.** Each value is encrypted on its own with age (`age-encryption`
  0.3.1, in process). The plaintext is `{"name": …, "value": …, "rotated":
  …}`, and decryption checks the name, so a ciphertext copied onto another
  entry fails. One value per entry keeps git diffs readable and a conflict
  fixable by hand.
- **Recipients.** `to` is always `mini` and `breakglass`, plus each machine
  that owns a sink or MCP allowance using the value (the Mac also for gpd's
  sinks, which it writes). The service computes `to` from the sinks and
  re-encrypts when a sink is added or removed; nobody edits it. The homelab
  key is break-glass only, its private half off-box in the break-glass
  bundle. This mints new identities on purpose, against the skill's "point
  at the one identity" rule, because nothing can use a key kept off-box.
- **Signature.** The `secrets` service signs the canonical JSON of everything
  but `signature` with an ed25519 key in `secrets-data`. Other machines check
  it against the mini's public key pinned in their canopy config and refuse a
  file that fails. On the Mac this stops accidents and casual edits, not a
  determined same-uid agent (which can re-pin), and the per-value recipients
  are what bound the damage there.
- **Metadata stays plain:** names, descriptions, tags, dates, recipients,
  allowlists and sinks are readable without a key.

## The `secrets` service (mini)

A new compose service built from the same image (a `secrets` target in the
Dockerfile, entry `src/secrets/main.ts`):

- Runs as root in its own container, like the stage runner, because it writes
  sinks owned by the host user (uid 1000, mode 0600). No `pid:` sharing, no
  `canopy-config` or `shells` volumes. Mounts: `secrets-data` (its checkout,
  identity, signing key, passkeys, audit log), `/opt/stacks` (sinks), the
  host's `~/.claude/mcp-env` folder (MCP env files, below), and
  `~/.ssh/canopy-restart` (read-only, for stack restarts).
- Listens on `/run/canopy-secrets/secrets.sock` in a volume shared with
  `canopy` alone, socket folder `root:secretscaller 0750`, socket 0660;
  canopy holds the group through `group_add`, `shells` does not. A shell that
  finds the path through `/proc/<canopy>/root` still cannot open it.
- Holds the mini's age identity as a key file in `secrets-data`, mode 0400,
  loaded at start.
- Is the only process on the mini that decrypts. It writes the mini's sinks
  itself, commits as `canopy@mini`, and pushes to Forgejo.
- Prints the first-passkey code to its own stdout only (`docker compose logs
  secrets`), never to a file. Canopy's own logs also go to stdout; nothing
  lands in `canopy-config`.
- Protocol: framed JSON over the socket like `core/stagewire.ts`. canopy
  relays the browser's WebAuthn messages and session token; the service does
  the verification (expected origin `https://canopy.beric.ca`, relying party
  `canopy.beric.ca`).

## One writer

Only the `secrets` service writes the file. Every other machine pulls with
`--ff-only`. A pull that is not a fast-forward, or a file that fails its
signature, is refused, and the machine keeps the last good copy.

Every gated action happens on the mini's own page, `canopy.beric.ca/?view=secrets`.
Another backend's page shows the read-only list (names, tags, sinks, drift)
and links there for the rest. One origin keeps the passkey's relying party
simple and the session cookie first-party.

## Unlocking

- **mini:** the `secrets` service loads its key file at start. Nothing to
  unlock.
- **Mac:** the identity is an age file wrapped with a passphrase (age's scrypt
  recipient). After every canopy start the Mac's Secrets view asks for it;
  canopy unwraps the identity into memory and drops the passphrase. macOS
  does not let a same-uid process read another's memory without a debugger
  entitlement, so the unwrapped key is safe from ordinary agents. Until the
  unlock the Mac is locked: its sinks keep their last contents, and a change
  waits, shown as "locked" on the Mac's column. A wrong passphrase waits 2 s
  more per attempt.
- **gpd** has no canopy backend and no key. The Mac's canopy writes gpd's
  sinks over ssh, the same way the kit reaches gpd.

## The human gate

`@simplewebauthn/server` 14 in the `secrets` service, `@simplewebauthn/browser`
14 in the page.

- **First passkey.** Registration needs a one-time code the service prints
  to its stdout when it has no passkey. After that, registering another
  passkey needs a session.
- **Session.** The service issues a random token; canopy sets it as an
  HttpOnly, Secure, SameSite=Strict cookie and relays it on each gated call.
  15 minutes idle, 1 hour at most. A shell's `CANOPY_API` caller has no
  cookie, so every gated call answers 401.
- **Gated:** reveal, copy, add, edit, rotate, delete, allowlist changes, sink
  add and edit, import approval, passkey management.
- **Not gated:** the list of names and metadata, sink drift, the audit log,
  none of which holds a value. The Mac's unlock is its own proof (the
  passphrase).
- **Audit log.** Every gated action and every sink write, by secret name,
  sink and passkey, never a value, kept in `secrets-data` and shown in the
  view.

## Sinks

A sink is where a value leaves the store: a key in a dotenv file, a path in a
JSON file, or, through the kit, an MCP server's env.

- The machine that owns the sink writes it: on the mini the `secrets`
  service, on the Mac the Mac's canopy (its own sinks and gpd's). The write
  is atomic (temp file, then rename, in the same folder), mode 0600, owner
  the host user, and keeps every key the sink does not name exactly as it
  was. A file that does not parse refuses the write.
- A sink path inside a repo canopy scans is refused unless git ignores it
  there, since a peer WIP snapshot takes untracked files
  (`~/dev/dev-tools/canopy/.env` is ignored, so it is allowed).
- **Drift:** each scan compares a sink's values with the store's in the
  memory of the process that decrypted them (the `secrets` service on the
  mini, the unlocked Mac canopy on the Mac). No hash of a value is stored,
  logged or sent, since a hash of a short secret can be brute-forced. Only
  the verdict leaves: in step or drifted, and the view marks a sink edited
  in place. A value that differs before canopy ever wrote that file reads as
  drift, never as something to overwrite. "Take
  this value" (gated) imports the file's value as a new rotation.
- **Restart:** a sink may name a compose stack. After a write the view lists
  the stacks to restart. The restart button (gated, with a confirm) has the
  `secrets` service ssh to the host with the `canopy-restart` key, whose
  `authorized_keys` line forces `canopy-restart <stack>`, a script that runs
  only `docker compose -f /opt/stacks/<stack>/docker-compose.yml up -d` for a
  stack name it checks against the folders under `/opt/stacks`.

## The kit's MCP secrets

`${secret:NAME}` in `kit.json` resolves only when `NAME`'s signed allowlist
holds `mcp:<server>#<hash>`, where the hash covers the server's command,
args, url and env names. A changed definition voids the allowance until a
human confirms it in the view; until then the kit marks the server "not
allowed" and leaves it out of the agent's config.

No agent config file ever holds a secret value. A server with secrets is
written by the kit as a launch through `~/.claude/bin/canopy-mcp-env <server>
-- <command> <args>`, a small script (tracked in dotclaude) that reads the
dotenv file `~/.claude/mcp-env/<server>.env` (mode 0600, the folder
gitignored in dotclaude) into the environment and execs the command. That
file is an ordinary sink, written by the machine that owns it. An http server
with secret headers gets Claude's `headersHelper` set to `canopy-mcp-env
--headers <server>`. Codex reads an http server's token only from its own
environment (`bearer_token_env_var`), which a wrapper cannot reach, so an
http server with secrets reads "not supported for codex" in the view until
there is a way that keeps the value out of the config. The paths sit under `~/.claude`, so they resolve inside the canopy
containers too.

## Import

The Secrets view's import (gated) lists names from every known source: the
table above, plus `~/.claude.json` MCP env and headers and
`~/.codex/config.toml` MCP env. The human ticks what to bring in.

- Sources on the mini: the `secrets` service reads them itself.
- Sources on the Mac: the Mac's canopy reads them, encrypts each value to the
  mini's key, and posts them as an import proposal. A tampered Mac could
  send the values elsewhere, but they are Mac files it can already read, so
  nothing new leaks. Nothing enters the store until a human approves the
  proposal on the mini's page. A proposal no one approves expires after 24
  hours. Since a proposal arrives without a passkey session, the service
  caps it: at most 200 values per proposal, 16 KiB per sealed value and 500
  values waiting in all. Waiting proposals live in the service's memory, so a
  restart drops them and the Mac proposes again on its next import.
- Identical values merge when the service finds them equal in memory, and the
  view suggests one name for them.
- Each source file can become a sink in the same step, so it stays generated
  from the store from then on.
- Values never pass through an agent: no part of import prints a value, and
  the tests assert that no route or log line carries one.

## The UI

A `secrets` view (`components/Secrets.tsx`, pure helpers in `ui/src/secrets.ts`):

- **List:** search, tag filters, name, description, rotated date, where it is
  used (sinks and MCP servers), drift and lock badges.
- **Secret sheet:** masked value with reveal (hidden again after 20 s) and
  copy, edit, rotate, delete (refused while a sink or allowance still uses
  it), the allowlist editor, history (rotations by date, no values).
- **Rotate:** shows every sink and server the change reaches, writes them,
  then lists the stacks to restart with their buttons.
- **Sinks:** a tab listing sinks per machine with drift, a sink editor (path,
  format, key map) and a "write now".
- **Import:** a tab with the wizard and the pending proposals.
- **Passkeys and audit:** a tab with the registered passkeys (add, remove)
  and the audit log.
- A lock bar when the page's backend is locked (the Mac), with the
  passphrase field.

CLI: `canopy secrets list`, `canopy secrets status` (sinks, drift, lock), and
`canopy secrets unlock` (asks for the passphrase on the terminal). There is
no `get`.

## Components

- `src/core/secretfile.ts` (pure, tested): parse, canonical JSON, sign and
  verify, recipients from sinks, the allowlist check, sink planning.
- `src/core/secretcrypt.ts`: age encryption and decryption with the
  name-bound plaintext, identity wrapping with a passphrase.
- `src/core/sinks.ts`: dotenv and JSON reading and writing that keep
  unmanaged keys, drift by comparing values in memory, the scanned-repo
  refusal.
- `src/core/secretwire.ts` (pure): the socket frames and their refusals.
- `src/secrets/` : the service (store, git writer, WebAuthn, sessions, audit,
  sinks, restart) and `main.ts`.
- `src/server/secrets.ts`: canopy's routes, which relay to the service on the
  mini and serve the read-only list and the Mac's unlock and sinks
  elsewhere; the `secrets` SSE event.
- `docker/canopy-restart`, the compose service, and the install steps in
  `docs/deploy.md`.

## Recovery

- **The mini's `secrets-data` volume is lost:** every value can still be
  decrypted with the break-glass key from the latest checkout (the Mac's or
  gpd's, or Forgejo). The path, written into `docs/deploy.md`: restore the
  break-glass key to a temp file, run `canopy secrets recover <checkout>`,
  which decrypts every value with it, generates a new mini identity and
  signing key, re-encrypts to the new keys, and prints the new public
  signing key; re-pin that on the Mac (`canopy secrets pin <key>`); register
  a passkey again with the new first-passkey code; delete the break-glass
  key file. The audit log restarts empty.
- **The Mac's passphrase is lost:** generate a new Mac identity in the view;
  the service re-encrypts the Mac's values to it.
- **Forgejo is lost:** any machine's checkout is a full copy; push it to a
  new repo and point the remotes there.

## Phases

1. The store (file, crypto, signature, recipients), the `secrets` service
   with its socket and the passkey gate, the Mac's passphrase unlock, the
   Secrets view (list, sheet, add, edit, reveal, delete, audit, passkeys),
   dotenv and JSON sinks with drift, import from every source in the table,
   and recovery.
2. The kit's MCP references with allowlists (with the kit's phase 2), and
   rotation with its impact list.
3. Stack restarts through the forced-command key, and gpd's sinks over ssh.

## Out of scope

- Human passwords (the role Vaultwarden had). RoboForm stays where those are.
- The incubator's private env: `CANOPY_VAULT_TOKEN` and the rest stay `.env`
  keys canopy reads at start. The mini's canopy `.env` becomes a sink, so they
  are managed from here without changing how canopy reads them.
- CI secrets on GitHub.

## Errors

- Signature fails or a pull is refused: the view says which, the machine
  keeps its last good file, and no sink is written from the bad one.
- The `secrets` service away: canopy's view on the mini says so and lists
  read-only from the last checkout canopy can read (metadata only).
- The mini away: other machines keep their last good file; their lists say
  "read-only, mini away".
- A sink file that will not parse, or a path that is refused: the sink reads
  "blocked" with the reason; the other sinks still write.

## Testing

- `secretfile.test.ts`: canonical JSON, sign and verify, a tampered
  allowlist refused, a swapped ciphertext refused by its bound name,
  recipients computed from sinks.
- `secretcrypt.test.ts`: round trip to several recipients, passphrase wrap
  and unwrap, a wrong passphrase.
- `sinks.test.ts`: dotenv and JSON keep unmanaged keys byte for byte, the
  scanned-repo refusal, drift found by comparing values with no hash of one
  anywhere in the output.
- `secrets/*.test.ts`: every gated request refused without a session (a test
  that walks the request table, so a new request cannot skip the gate), the
  first-passkey code, the audit log carrying no value, the 24-hour proposal
  expiry and the proposal caps, recovery from a break-glass key.
- `server/compose.test.ts`: the `secrets` service shares no pid namespace
  and no volume with `shells`, and only `canopy` has the socket's group.
- A test that scans every log line and response in the suite for a known
  fixture secret and fails on a hit.
- `ui/src/secrets.test.ts`: list filters, badges, the reveal timer.
