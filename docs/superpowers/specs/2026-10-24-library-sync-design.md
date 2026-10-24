# One Library across backends

Status: phase 1 live on both backends since 2026-10-24 (d2cc24a): the Mac seeded, the mini adopted from it, `librarySync` is on for both, and a tag added on the mini reached the Mac in 18 s, its removal in 48 s. Phase 2 not started. FR-016. One question round: Eric chose "replay when safe" for folder changes (phase 2). Every other call below is marked as mine.

## Why

Each backend keeps its own copy of the Library's files under `<config>/library/<root hash>/`: `categories.json`, `references.json`, `tags.json`, `relations.json` and `health.json`. Peer sync carries commits only, so a tag, note, link, reference, relation or category made on the Mac never reaches the mini. On 2026-10-18 the mini's copy was replaced with the Mac's by hand (the old one is in `/config/library-backup-20261018.tgz`). None of the mini's five files has changed since, so every Library edit after that date lives on the Mac only.

A second gap sits under the data. A project's category is the folder it sits in (`_iter_projects` walks `<root>/<category>/`), and a move, a rename, or a category rename or merge moves real folders. Peer sync finds a repo on the peer by its path, so when the Mac moves `web-apps/foo` to `dev-tools/foo`, the mini's next pass clones `dev-tools/foo` fresh and keeps its own `web-apps/foo`: two copies.

## Goals

- An edit made in either backend's Library, from the page, the CLI or by hand in `categories.json`, reaches the other within two minutes of both being up.
- The Mac asleep is normal. Whichever backend comes back catches up.
- A folder change on one backend is replayed on the other when that is safe, and waits in the inbox as an ask when it is not (phase 2).
- Host keys stay per machine: `host_root`, `terminal_app`, `trusted_origins`, `helper_port`.

## Non-goals

- One shared manifest. Each backend still scans its own disk. Only what Eric records about the projects is shared.
- Backends outside `backends`, and a second Library root on one backend.
- Merging two edits to the same entry. The newer one wins whole.

## Anti-goals (a failure even if it works)

- A fresh or reset backend emptying the other's Library. A backend that has never joined serves nothing and takes nothing.
- A file the engine failed to parse read as empty. The engine's loaders return `{}` or `[]` on a bad file, so a bad read would tombstone every entry and the sync would spread the loss.
- Moving a folder someone is working in (phase 2).
- One backend writing into another's files or folders. Each backend pulls, and changes only its own, as peer sync does.

## Entries

The shared state is flattened into keyed entries. An entry is the unit of merge.

| Key | From | Value |
|---|---|---|
| `cat:<name>` | `categories.json` `categories` | `{label, blurb, keywords}` |
| `ovr:<project>` | `overrides` | the category |
| `link:<project>` | `links` | the whole entry (`dev_port`, `deployed`, `dev`, `dev_path`, `auto`) |
| `note:<project>` | `notes` | the text |
| `arch:` `fav:` `pin:<project>` | `archived`, `favorites`, `pinned` | `true` |
| `ign:<name>` | `ignore` | `true` |
| `set:<key>` | `stale_days`, `github_login`, `dev_port_base` | the value |
| `ref:<id>` | `references.json` | the reference |
| `tag:<project>` | `tags.json` | the project's tag list |
| `rel:<a>\|<b>` | `relations.json` | `true` |
| `health:<url>` | `health.json` | the last check |
| `place:<project>` | the disk (phase 2) | `{dir, origin}` |

Any key not in the table stays local: `version`, `_comment`, the host keys, and a key the engine adds later until it is added here. My call: an allow list, so a new host-specific key never leaks.

Writing entries back keeps each file's order: list members and references keep their place and new ones go at the end; relations are sorted, as `save_relations` already does.

A `link:` entry with `auto` set is a cache that `build` refreshes. If the two machines detect a project's URLs differently, the entry flips each time either one builds. Builds are run by hand, so my call is to accept this and split the `auto` fields out only if it shows up.

## Stamps

`sync.json` sits next to the five files and only the canopy server writes it. Per key it holds the hash of the canonical value, `at` (ms) and `by` (backend name), and it holds a tombstone for each deleted key. A stamping pass compares the files with `sync.json`: a key whose hash changed is stamped at the pass's time, and a key that vanished becomes a tombstone. The pass runs when a file in the state dir changes (`fs.watch`, debounced a second), before answering a peer and before a merge. So the engine's writes, the CLI's and a hand edit are all stamped, and the engine itself does not change. A change is always stamped after the stamp it replaces (`max(now, old + 1)`), so a clock behind the one that stamped the old value, another machine's or a seed's file times, never lets an edit lose to what it replaced. A file that fails to parse skips the whole pass. Tombstones are kept: they are small. My call.

Joining. A backend with no `sync.json` has not joined: it answers peers `{ready: false}` and merges nothing. It joins one of two ways:

- `canopy library sync --seed`: this copy is a starting point. Every entry is stamped at its file's modification time.
- `canopy library sync --adopt <backend>`: back up this copy, then take that backend's entries and stamps whole.

The first machine seeds and every other one adopts. My call. A join with no history cannot tell an entry the other side deleted from one this side added, so it has to be told which way to go.

## Pull and merge

`GET /api/library/sync` answers `{backend, ready, entries: {key: {v, at, by}}, tombs: {key: {at, by}}}`. It is a read like the other Library reads (added to `LIBRARY_READS`), behind the same origin gate. A server-side fetch carries no Origin, and its Host is the peer's ts.net name, which each machine lists in its own `CANOPY_ORIGINS` (docs/deploy.md); on the mini an open bind's tailnet host passes as well.

With `librarySync` set to `on`, each backend pulls from every other `backends` entry's `tailnet` URL at start, every 60 s, and on `canopy library sync` or `POST /api/library/sync` (admin). Public URLs sit behind Cloudflare Access and are not tried. A peer that does not answer is marked away, with the reason and no notice, and it catches up when it answers. `dry` computes and reports and writes nothing, like `peerSync: "dry"`.

The merge goes key by key. The newer `at` wins, and a tie goes to the greater backend name. A foreign tombstone deletes a local entry older than it. Equal values just take the newer stamp and write nothing.

Two holds, both my call:

- Mass deletion. A merge that would delete more than 20 entries, or more than a fifth of them once that is five or more, is held whole until `canopy library sync --accept <backend>`.
- A category tombstone, while the category's folder here still has projects in it, waits for phase 2. Applied alone, it would turn those projects into strays.

Applying. The merged files are written by a new one-shot command in the Python adapter, `__sync-write`, under the engine's lock. It takes the hash of each file as the merge read it and refuses if any of them changed since, so an edit landing mid-merge is never overwritten. Its writes are atomic (a temp file, then rename). Before writing, it copies the files it changes into `sync-backups/<stamp>/`, keeping the last 10. `sync.json` takes the foreign stamps in the same step, so the next stamping pass does not mistake taken entries for local edits. Then, if the Library worker is running, `POST /refresh` rebuilds the manifest; otherwise its next start does.

Status. Health gets a "Library sync" row: off, not joined, on with each peer's last pull, away since, or held (with the count and the command that lets it through). `canopy library sync --status` prints the same. The CLI handles `canopy library sync` itself, before passing the rest of `canopy library` to the engine, which has no `sync` command.

## Phase 2: folders

`place:<project>` entries come from the disk: the project's folder relative to the root and its `origin` remote. The stamping pass lists the category folders, which is cheap, so a move made in the Library, by the CLI or with `mv` in a shell is stamped alike. A rename shows up as one `place:` tombstoned and another added with the same `origin`.

When a foreign `place:` wins and differs from the folder here, the folder is moved here too if all of these hold:

- the folder is there and the target path is free;
- no run, flow, landing or kept-shell cwd is inside it, and no live shell's cwd is;
- it has no linked worktrees, since moving a repo breaks their gitdir pointers;
- no git operation is in progress (peer sync's busy markers).

Anything else becomes an ask in the inbox ("The Mac moved foo to dev-tools. Move it here too?") with Move and Leave. If peer sync already cloned the target before the move arrived, the ask names both paths and moves nothing.

Peer sync's `cloneMissing` gets a skip for a path a pending `place:` says is a move of a local folder, so it stops making the duplicate. A new category's folder is made here. A category tombstone removes its folder once the folder is empty. A reference's `.webloc` follows the reference: it is written when the reference arrives, moved when its category changes, and removed when the reference is tombstoned, but only if the file holds that reference's URL.

Canopy's own per-repo state keyed by path (favorites, archived, notes) is left as a move made here today leaves it. My call: the same fix belongs to both, and it is not in this spec.

## Code

- `src/core/libsync.ts`, pure and tested: `flatten(files)`, `unflatten(entries, files)`, `stampPass(prev, entries, now, self)`, `merge(mine, theirs)`, the holds.
- `src/server/libsync.ts`: `LibrarySync`, which owns the watcher, the timer, the pulls, the status and the routes, and calls the adapter to write.
- `lib/devhub/canopy.py`: `__sync-write`.
- `src/cli/`: `canopy library sync [--seed | --adopt <backend> | --accept <backend> | --status]`.
- `librarySync: "off" | "dry" | "on"` in config.json, off by default and set by hand, as `peerSync` is. My call: no Settings row until the sync has run for a while.

## Testing

- Pure: flatten and unflatten round-trip the fixture files with the host keys untouched; a stamp pass stamps a change, tombstones a delete and skips an unparsable file; the merge rules (newer wins, tie by name, a tombstone against an older value, equal values write nothing); both holds; an unjoined peer is skipped.
- Server: two servers with their own config dirs and fixture roots. A tag made on one through the engine reaches the other's `tags.json`, and a mid-merge write makes `__sync-write` refuse.
- Phase 2: real temporary git repos for the move, the refusals and the ask.

## Rollout

The joins and `--accept` are admin calls, like the Library's other writes, so they run from the Mac's CLI (its own token, and its token for the mini with `--backend`) or a page. A canopy shell's token has no admin right.

1. Ship phase 1 with `librarySync` off.
2. On the Mac: `canopy library sync --seed`.
3. From the Mac: `canopy library sync --adopt mac --backend https://macmini-2018.tail2d2c60.ts.net:7849`. The mini's copy has not changed since 2026-10-18, so the Mac's is the truth. This is also the first check that the mini's container reaches the Mac's tailnet URL; nothing has fetched across backends server to server before.
4. Set `librarySync: "on"` on both. A tag made on the Mac shows on the mini within two minutes, and the other way round.
