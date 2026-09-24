# Peer sync: every machine a coworker

Date: 2026-09-23. Status: design approved in chat, awaiting spec review.
Amended 2026-09-23 while planning; see the plan's Spec amendments.

## Why

`~/dev` reaches the mini through `_control/scripts/sync-dev-to-mini.sh`, a one-way rsync from the Mac. The mirror is the wrong model for a machine that does its own work:

- It overwrites. The mini's edits survive only through a hold heuristic (stamps, ctime walks, per-repo exclusion), which is subtle and fails closed by skipping whole repos.
- It leaves stale files. Before the 2026-09-23 delete pass, a removed worktree showed up on the mini as 169 untracked changes.
- It mangles names. macOS writes accented filenames in NFD, git records NFC, so `trip` shows phantom deletions on the mini.
- It knows exactly two machines, and one of them always wins.

The goal is the model coworkers use: each machine has its own clone of every repo, work moves between clones only through git, and each machine resolves its own conflicts. Nothing ever writes into another machine's working tree.

## Decisions

These were settled one at a time in the brainstorming session.

| Question | Decision |
|---|---|
| Uncommitted work | Coworker model plus automatic WIP snapshots: each machine publishes its dirty tree as a ref; nothing lands in another tree unless asked. |
| Non-repo folders | Stay on a one-way rsync mirror (trimmed to exclude every repo). |
| Where work meets | Pull-only between peers over ssh. No hub. `origin` stays the place work is published. |
| Incoming work | Auto fast-forward only when safe; everything else is flagged and left alone. |
| Which repos | Every git repo, including third-party clones and repos without a remote. |
| Ignored files (`.env`) | Copied once from a peer when missing, never overwritten. |
| Topology | A mesh of any number of machines, each listing the peers it pulls from. No machine is canonical. |
| Where it runs | Inside canopy (server timer plus CLI), with the rsync kept for non-repo folders. |

## Topology

Every machine that runs canopy is a peer. Each keeps its own list of the peers it pulls from and never lists itself.

| Machine | `self` | Pulls from (git) | Mirrors to |
|---|---|---|---|
| Mac | `mac` | mini, gpd | qnap |
| mini | `mini` | mac, gpd | none |
| GPD | `gpd` | mac, mini (its `repos` globs only) | none |
| QNAP | not a peer | nothing (no git) | receives the Mac's mirror |

A repo on the Mac then has the remotes `origin`, `mini` and `gpd`; on the mini, `origin`, `mac` and `gpd`.

A peer fetches only another peer's own branches (`refs/heads/*`), never that peer's copies of a third machine's. Work still spreads from machine to machine: the mini fast-forwards to the Mac's commits, and the GPD then gets them from the mini while the Mac is off.

## Configuration

In canopy's config (`$CANOPY_CONFIG_DIR/config.json`), per machine:

```json
{
  "self": "mac",
  "peers": [
    { "name": "mini", "alias": "macmini-ts", "root": "dev", "role": "git" },
    { "name": "gpd", "alias": "gpd", "root": "dev", "role": "git", "repos": ["dev-tools/*", "web-apps/keel"] },
    { "name": "qnap", "alias": "nas", "root": "/share/Arik/dev-mirror", "role": "mirror" }
  ],
  "peerSync": "dry",
  "seed": [".env", ".env.local", ".env.*.local"]
}
```

- `alias` is an ssh_config alias (it supplies user and port), never `user@host`.
- `root` is the peer's workspace root: home-relative unless absolute, so `/Users/ericbaruch/dev` and `/home/eric/dev` both read as `dev`.
- `role: "git"` is a full coworker. `role: "mirror"` receives the trimmed rsync and is never pulled from.
- `repos` is an optional list of globs over repo ids; a peer with it clones and fetches only matching repos.
- `peerSync` is `off`, `dry` (report what would move, move nothing) or `on`.
- `seed` is the allowlist of ignored files copied once.

A repo id is its path relative to the scan root, the same id canopy already uses, so `<peer root>/<id>` names the peer's copy.

## Components

### `src/core/peers.ts` (pure, browser-safe, tested)

- `normalizePeers(raw)`/`normalizeSeed(raw)` validate the config field by field, like `normalizeAgent`.
- `peerUrl(peer, id)` is `<alias>:<root>/<id>` (no alias for a peer mounted as a local path, in tests).
- `peerRefspecs(name)` is `+refs/heads/*:refs/remotes/<name>/*` and `+refs/wip/*:refs/peer-wip/<name>/*`.
- `ffTarget(branch, tips, contains)` picks the one tip that contains every other candidate as the fast-forward target, or folds every tip that disagrees into `diverged`.
- `globMatch`/`repoWanted`/`seedWanted` apply the `repos` and `seed` globs; `isSafeRel` refuses an unsafe relative path or file name out of a peer's untrusted listing.
- `BUSY_MARKERS` lists the `.git` paths that mean an operation is in progress (`MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, `index.lock`).
- `parseRefLines`/`parseWipLines` read `git for-each-ref` output; `peerMissing`/`peerUnreachable` classify a fetch's stderr.
- `parseQuotedWords` parses the ssh gate's own command line (see Integrity rule 2).
- `linkPeers` re-attaches `PeerState` to repos across a scan.

### `src/core/peersync.ts` (Bun)

`snapshotWip` builds and commits the WIP tree (see the sync pass, step 1); `initRepo` adds or repairs each peer's remote; `fetchPeer` fetches one peer by url and explicit refspecs (step 2); `fastForward` does step 3; `peerWips` reads what peers have pending; `serveList`/`serveSeeds`/`serveSeed`, and `safeId`/`gateCommand`, are what the ssh gate serves and authorizes (Integrity rule 2); `askPeer` asks a peer in-process or over ssh; `seedRepo`/`cloneMissing` do steps 4 and 5, treating a peer's answer as untrusted input; `takeWip`/`trackBranch` are the manual actions. `syncRepo(id, opts, seen)` runs the per-repo pass under a per-repo lock and returns a `PeerState`; `syncAll(ids, opts, concurrency)` runs it over every repo, behind a whole-pass lock, after `cloneMissing`. Every git command goes through the existing `git()`/`onHost`, so ssh reuses canopy's per-host ControlMaster socket.

### Types (`src/core/types.ts`)

```ts
type PeerRole = "git" | "mirror";
interface Peer { name: string; alias: string; root: string; role: PeerRole; repos?: string[] }
interface PeerSeen { name: string; ok: boolean; at: number; error?: string }
interface PeerBranch { branch: string; peer: string; ahead: number; behind: number }
interface PeerWip { peer: string; branch: string; at: number; parent: string; files: number }
interface PeerState {
  moved: { branch: string; from: string; to: string; peer: string }[];
  diverged: PeerBranch[];
  wip: PeerWip[];          // what peers have pending
  ownWip?: { branch: string; at: number };
  peerOnly: { peer: string; branch: string }[]; // branches a peer has that this repo does not, for "track" (amendment 4)
  onlyHere: boolean;       // no git peer has this repo
  error?: string;
}
```

`Repo` gains an optional `peers?: PeerState`, re-attached across scans the way `pulls` is.

### Server (`src/server/`)

- The pass joins `refreshActivity` on the `REMOTE_REFRESH` timer (5 minutes), after the origin fetch, skipping a repo with an active run, the same way `fetchLocal` does.
- `state.peerSeen` holds a `PeerSeen` per peer.
- `GET /api/peers` is `{ self, peers, seen, sync }`.
- `POST /api/repos/peer?id=` `{ action: "take" | "track" | "sync" | "seed", peer, branch }`.
- A `peers` event carries `seen`; each repo whose `PeerState` changed is broadcast as a repo event, so the card updates through the existing path.
- One `ctl notify soft` the first time a branch becomes diverged; the feed gets a line per move, divergence and new WIP.

### CLI (`src/cli/`)

`canopy peers status | init | sync [id] | take <id> <peer> [branch] | track <id> <peer> <branch> | seed <id> | gate --root dir`. `init` adds or repairs every peer's remote in every repo under the root and is safe to re-run; `gate` is what a peer's `authorized_keys` command runs and is never invoked by hand.

### UI (`ui/src/`)

- `ui/src/peers.ts` (pure, tested): chip words and tooltips.
- Card and panel head: `⇅ mini ↑2 ↓3` for a diverged branch, `WIP on mac/main 12m ago` for a pending peer WIP, `only here` when no git peer has the repo.
- Panel: a peers section listing each peer's branches against yours, pending WIPs with "take" and "view" (opens the WIP's own commit), divergences with "open shell" and "merge with claude" (starts or continues the repo's own chat with a fixed first message — no new run type, amendment 5), branches only a peer has with "track", and a "sync now" button.
- Top bar: a peers line from `seen`, one word per peer (`mini · 3m ago`, or `gpd · offline` with no age, since a failed attempt's timestamp is not the last time it actually answered).

### Trimmed rsync (`_control/scripts/sync-dev-to-mini.sh`)

Excludes every directory that holds `.git`, keeps the delete pass and backups for everything else, and drops the hold logic and stamps. It stays until mirror peers are implemented in canopy, which replaces it.

## The sync pass

Per repo, in order. `peerSync: "dry"` computes every step and records what it would do; it still fetches — a dry pass needs the peer's own tips to know what it would move, so step 2 writes `refs/remotes/<peer>/*` and `refs/peer-wip/<peer>/*` the same as a live pass — but touches no local branch, the index, the working tree, or any file.

1. **Snapshot own WIP.** Skipped on a detached HEAD. If the tree is dirty:
   - Copy `.git/index` to a temp file, then with `GIT_INDEX_FILE` pointed at it run `git add -A` and `git write-tree`. The real index and working tree are untouched, and untracked files that are not ignored are included.
   - If the tree hash equals the current `refs/wip/<branch>`'s tree, stop.
   - Otherwise `git commit-tree <tree> -p HEAD -m "wip <self> <iso time>"` and `git update-ref refs/wip/<branch> <commit>`. Older snapshots stay in the reflog.
   - If the tree is clean and `refs/wip/<branch>` exists, delete it, so peers see nothing pending.
2. **Fetch every git peer.** `git fetch --prune`, by url and explicit refspecs rather than by remote name, so a dry pass (which never adds the peer remotes) still reaches every peer. Pruning drops a WIP the peer has since cleaned up. A peer that lacks the repo (the fetch fails with "does not appear to be a git repository" or "not found") is not an error; it just counts toward `onlyHere` (amendment 6). An unreachable peer is recorded in `seen` and skipped for the rest of the pass, not just this repo, so one asleep machine costs one timeout total rather than one per repo (amendment 7).
3. **Fast-forward what is safe.**
   - Checked-out branch: only with a clean tree, no busy marker, and an `ffTarget` answer; `git merge --ff-only <peer>/<branch>`.
   - Other local branches: the same containment rule, applied with `git update-ref refs/heads/<b> <new> <old>`. The working tree does not matter for these.
   - A branch that exists only on a peer is never created locally; it shows as `mini/feat-x` with a "track" action (`PeerState.peerOnly`, amendment 4).
   - Diverged: nothing moves; the divergence is recorded.
4. **Seed ignored files, on clone and on demand — not every pass** (amendment 3: asking every peer for every repo's ignored files every five minutes costs a lot and buys nothing once a repo has its `.env`). Seeding runs once when step 5 clones a repo from a peer, and otherwise only when asked for directly (`canopy peers seed`, the panel's **seed** button). For each allowlisted file this repo lacks and a peer has, the file is asked for over the gate (or in-process for a peer mounted as a local path) as base64, written beside the target under a random name at mode 0600, then hard-linked into place, which fails rather than overwrites if the target exists by then.
5. **Clone missing repos** (once per pass, before the per-repo steps). A repo a git peer has, that this machine lacks and whose id matches the peer's `repos` globs (if any), is cloned from that peer. Then `origin` is set to the peer's `origin` URL, the other peers are added as remotes, and step 4 runs for the new clone. A failed clone removes its partial directory. A repo present here and on no git peer is marked `onlyHere` and left alone.

**Taking a WIP** is always a manual action (`canopy peers take` or the panel):

- If the tree is clean and HEAD equals the WIP's parent: `git read-tree -u -m HEAD <wip>` then `git reset` (mixed), so the files appear exactly as on the peer, uncommitted.
- Otherwise: `git branch wip/<peer>/<branch> <wip>`, and the user merges it.

## Integrity rules

1. **Nobody pushes to a peer.** `init` sets each peer remote's push URL to a disabled value, so `git push mini` fails. Repos keep git's default `receive.denyCurrentBranch`.
2. **ssh keys can fetch and do nothing else.** Each peer's key sits in `authorized_keys` behind `restrict,command="<bun> <canopy>/bin/canopy.ts peers gate --root <workspace>"` (`restrict` covers `no-pty,no-port-forwarding,no-agent-forwarding,no-X11-forwarding`; a bare `command=` without it would still let the key open a full session if some other restriction were ever dropped). The gate is a canopy subcommand, not raw `find`/`cat` (amendment 1): it parses `SSH_ORIGINAL_COMMAND` and allows exactly `git-upload-pack '<path under root>'`, `canopy-peer list`, `canopy-peer seeds '<id>'` and `canopy-peer seed '<id>' '<file>'`. It realpath-checks every candidate path — the literal one, and every suffix git's own `enter_repo()` would try without `--strict` — following a worktree's gitfile and its `commondir` where one leads, so nothing under the root can hand a symlink or a linked worktree off to somewhere outside it. Before reading anything it deletes every `GIT_*` variable from its own process environment, so the in-process listing and seed calls inherit none of it, and it reads the serving machine's config read-only, refusing every command on one it cannot read or parse rather than falling back to defaults. Every peer needs bun and a canopy checkout on the serving host. `sshd` must not `AcceptEnv` `GIT_*` or `BUN_*` for that key (the default accepts only `LANG`/`LC_*`); either one reaching the gate's environment could run code before the gate does anything (amendment 2 names the dedicated key and alias each machine uses for this).
3. **Peers write only their own namespaces.** Forced fetches land only in `refs/remotes/<peer>/*` and `refs/peer-wip/<peer>/*`. Local branches move only by compare-and-swap (`update-ref <new> <old>`), only forward.
4. **Nothing moves during a git operation.** A busy marker skips step 3 (fast-forward) for every branch in the repo, not only the one checked out — a rebase detaches HEAD, and a checked-out-only guard would let the branch it is rewriting move anyway. Step 1 (the WIP snapshot) is not gated by a busy marker; it snapshots the dirty tree as it stands, mid-operation or not.
5. **One pass per repo at a time** inside canopy, so the timer and a manual sync never overlap on a repo.
6. **rsync never enters a repo.** A mirror peer is never pulled from.
7. **Seeding is atomic and never overwrites.**

Known limit: two machines editing the same file while both are dirty. Both WIPs show on both sides; the first to commit wins the fast-forward, and the other then sees `diverged`. That is the moment to merge, as with any two coworkers.

## Failure handling

- Peer unreachable: `seen` records it with the time; the top bar shows it; cards are not flagged.
- Per-repo failure (fetch refused, bad path, clone failed): `PeerState.error` on the repo, shown on the card, retried next pass.
- Divergence: chip, feed line, one notification when it first appears.
- A repo whose peers disagree with each other: `diverged` lists every peer involved.

## Migration

The mini's copies are already full clones carrying the Mac's `.git`, so they become peers in place.

1. ssh both ways: a `mac` alias in the mini's `~/.ssh/config` to the Mac's tailnet name; a dedicated `canopy_peer` key and a `mac-peer`/`mini-peer` alias with `IdentitiesOnly yes` on each side, so the forced command never captures a key used for ordinary logins (amendment 2); the mini's key in the Mac's `authorized_keys` behind the gate wrapper, and the Mac's key in the mini's the same way.
2. Set `self`, `peers`, `seed` and `peerSync: "dry"` in each machine's canopy config (the mini's is on the `canopy_canopy-config` volume).
3. `canopy peers init` on each machine.
4. Trim `sync-dev-to-mini.sh` to exclude repos.
5. A day on `dry`, reading the feed; then `on`.
6. Fix the `trip` NFD names once on the mini by re-checking out the affected files (`git checkout -- test/fixtures/m9-cities`); with repos out of the rsync they stay fixed.

Rollback: `peerSync: "off"` and the old rsync flags. The remotes are harmless if left.

## Testing

- `src/core/peers.test.ts`: config validation, URL and refspecs, `ffTarget` over clean/behind/ahead/diverged/multi-peer, `repoWanted`, `seedList`, busy markers.
- `src/core/peersync.test.ts`, integration on real repos in a temp dir, peers wired by plain paths (git treats a path as a remote the same way as ssh):
  - WIP round trip, with `.git/index` byte-identical before and after.
  - Fast-forward happens when clean; refused when dirty, mid-rebase or diverged.
  - Non-checked-out branch moves by compare-and-swap, never backwards.
  - WIP ref pruned on the peer after the owner cleans up.
  - Seeding copies once and never overwrites.
  - Clone of a missing repo sets `origin` from the peer and adds the other peers.
  - `git push <peer>` fails after `init`.
  - `dry` writes no local branch, index, working tree or file — it still fetches into the peer's own ref namespaces, since a dry pass needs the peer's tips to report what it would do.
- `src/server/peers.test.ts`: `/api/peers`, the `peer` route's 400/404 cases, the `peers` event.
- `ui/src/peers.test.ts`: chip words.
- Manual: a dry day on the Mac and the mini, then a Mac-off test from the phone.

## Out of scope

- Mirror peers inside canopy (the rsync script covers them until a follow-up).
- Pulling from `origin` automatically. Canopy already fetches own remotes; merging from `origin` stays manual.
- Syncing the memory vault, which has its own sync.
