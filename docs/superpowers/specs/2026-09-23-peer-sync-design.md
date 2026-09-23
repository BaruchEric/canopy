# Peer sync: every machine a coworker

Date: 2026-09-23. Status: design approved in chat, awaiting spec review.

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

- `normalizePeers(raw)` validates the config field by field, like `normalizeAgent`.
- `peerUrl(peer, id)` is `<alias>:<root>/<id>`.
- `peerRefspecs(name)` is `+refs/heads/*:refs/remotes/<name>/*` and `+refs/wip/*:refs/peer-wip/<name>/*`.
- `ffTarget(local, peerTips, contains)` picks the peer tip that contains the local tip and every other peer tip, or reports `diverged` with the peers that disagree, or `current`.
- `wipArgs(...)` builds the snapshot sequence (see the sync pass).
- `seedList(allowlist, localIgnored, peerHas)` picks the files to copy.
- `busyMarkers` lists the `.git` paths that mean an operation is in progress (`MERGE_HEAD`, `rebase-merge`, `rebase-apply`, `CHERRY_PICK_HEAD`, `REVERT_HEAD`, `BISECT_LOG`, `index.lock`).
- `repoWanted(peer, id)` applies the `repos` globs.

### `src/core/peersync.ts` (Bun)

`syncRepo(repo, peers, opts)` runs one pass over one repo and returns a `PeerState`. `syncAll` runs it over every repo at `FETCH_CONCURRENCY`. `cloneMissing(peers)` lists each peer's repos through the existing remote `scanSource` walk and clones what is missing here. Every git command goes through the existing `git()`/`onHost`, so ssh reuses canopy's per-host ControlMaster socket.

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
  onlyHere: boolean;       // no git peer has this repo
  error?: string;
}
```

`Repo` gains an optional `peers?: PeerState`, re-attached across scans the way `pulls` is.

### Server (`src/server/`)

- The pass joins `refreshActivity` on the `REMOTE_REFRESH` timer (5 minutes), after the origin fetch, skipping a repo with an active run, the same way `fetchLocal` does.
- `state.peerSeen` holds a `PeerSeen` per peer.
- `GET /api/peers` is `{ self, peers, seen, sync }`.
- `POST /api/repos/peer?id=` `{ action: "take" | "track" | "sync", peer, branch }`.
- A `peers` event carries `seen`; each repo whose `PeerState` changed is broadcast as a repo event, so the card updates through the existing path.
- One `ctl notify soft` the first time a branch becomes diverged; the feed gets a line per move, divergence and new WIP.

### CLI (`src/cli/`)

`canopy peers status | sync [id] | init [peer] | take <id> <peer> [branch]`. `init` adds the remotes and settings to every matching repo and is safe to re-run.

### UI (`ui/src/`)

- `ui/src/peers.ts` (pure, tested): chip words and tooltips.
- Card and panel head: `⇅ mini ↑2 ↓3` for a diverged branch, `WIP on mac 12m` for a pending peer WIP, `only here` when no git peer has the repo.
- Panel: a peers section listing each peer's branches against yours, pending WIPs with "take" and "view diff", divergences with "open shell" and "merge with claude".
- Top bar: a peers line (`mini · 3m`, `gpd · 6d`) from `seen`.

### Trimmed rsync (`_control/scripts/sync-dev-to-mini.sh`)

Excludes every directory that holds `.git`, keeps the delete pass and backups for everything else, and drops the hold logic and stamps. It stays until mirror peers are implemented in canopy, which replaces it.

## The sync pass

Per repo, in order. `peerSync: "dry"` computes every step and records what it would do without writing anything.

1. **Snapshot own WIP.** Skipped on a detached HEAD. If the tree is dirty:
   - Copy `.git/index` to a temp file, then with `GIT_INDEX_FILE` pointed at it run `git add -A` and `git write-tree`. The real index and working tree are untouched, and untracked files that are not ignored are included.
   - If the tree hash equals the current `refs/wip/<branch>`'s tree, stop.
   - Otherwise `git commit-tree <tree> -p HEAD -m "wip <self> <iso time>"` and `git update-ref refs/wip/<branch> <commit>`. Older snapshots stay in the reflog.
   - If the tree is clean and `refs/wip/<branch>` exists, delete it, so peers see nothing pending.
2. **Fetch every git peer.** `git fetch --prune <peer>`. Pruning drops a WIP the peer has since cleaned up. An unreachable peer is recorded in `seen` and skipped.
3. **Fast-forward what is safe.**
   - Checked-out branch: only with a clean tree, no busy marker, and an `ffTarget` answer; `git merge --ff-only <peer>/<branch>`.
   - Other local branches: the same containment rule, applied with `git update-ref refs/heads/<b> <new> <old>`. The working tree does not matter for these.
   - A branch that exists only on a peer is never created locally; it shows as `mini/feat-x` with a "track" action.
   - Diverged: nothing moves; the divergence is recorded.
4. **Seed ignored files.** For each allowlisted file this repo lacks and a peer has, copy it through `onHost(peer, cat …)` into a temp file beside the target, mode 0600, then rename if the target is still missing. Never overwrite.
5. **Clone missing repos** (once per pass, before the per-repo steps). A repo a git peer has, that this machine lacks and whose id matches the peer's `repos` globs (if any), is cloned from that peer. Then `origin` is set to the peer's `origin` URL, the other peers are added as remotes, and step 4 runs. A failed clone removes its partial directory. A repo present here and on no git peer is marked `onlyHere` and left alone.

**Taking a WIP** is always a manual action (`canopy peers take` or the panel):

- If the tree is clean and HEAD equals the WIP's parent: `git read-tree -u -m HEAD <wip>` then `git reset` (mixed), so the files appear exactly as on the peer, uncommitted.
- Otherwise: `git branch wip/<peer>/<branch> <wip>`, and the user merges it.

## Integrity rules

1. **Nobody pushes to a peer.** `init` sets each peer remote's push URL to a disabled value, so `git push mini` fails. Repos keep git's default `receive.denyCurrentBranch`.
2. **ssh keys can fetch and do nothing else.** Each peer's key sits in `authorized_keys` behind a `command=` wrapper that allows only `git-upload-pack` (and the `cat` of an allowlisted seed file and the repo-listing `find` canopy's scan sends), with `no-pty,no-port-forwarding`.
3. **Peers write only their own namespaces.** Forced fetches land only in `refs/remotes/<peer>/*` and `refs/peer-wip/<peer>/*`. Local branches move only by compare-and-swap (`update-ref <new> <old>`), only forward.
4. **Nothing moves during a git operation.** Any busy marker skips steps 1 and 3 for that repo.
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

1. ssh both ways: a `mac` alias in the mini's `~/.ssh/config` to the Mac's tailnet name; the mini's key in the Mac's `authorized_keys` behind the restricted wrapper, and the Mac's key in the mini's the same way.
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
  - `dry` changes nothing on disk.
- `src/server/peers.test.ts`: `/api/peers`, the `peer` route's 400/404 cases, the `peers` event.
- `ui/src/peers.test.ts`: chip words.
- Manual: a dry day on the Mac and the mini, then a Mac-off test from the phone.

## Out of scope

- Mirror peers inside canopy (the rsync script covers them until a follow-up).
- Pulling from `origin` automatically. Canopy already fetches own remotes; merging from `origin` stays manual.
- Syncing the memory vault, which has its own sync.
