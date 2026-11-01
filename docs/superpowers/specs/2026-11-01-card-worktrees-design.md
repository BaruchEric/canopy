# Worktrees kept per card (FR-051)

Date: 2026-11-01. Status: built the same day.

## Intent

A repo card can keep several worktrees at once, each on a branch of its own, and open a shell or an agent in any of them with one click. This is the parallel-agents pattern worktrunk (max-sixty/worktrunk) built a CLI for: worktrees addressed by branch name, a path computed from a template, hooks that prepare a fresh tree, build caches shared copy-on-write, and a port per tree so two dev servers never collide. canopy borrows those conventions instead of depending on the `wt` binary, because its backends run in containers where a Rust binary is one more thing to install, and because canopy already owns a worktree module, a setup line per repo and a shell system that knows where every shell sits.

canopy already made worktrees for branch runs and kept a warm pool for them (FR-039). Those belong to the landing queue. The trees here belong to the user: they stay until removed, nothing lands them, and the card shows them as its own.

## Goals

- From a card, make a worktree on a new or existing branch, with the repo's `setup` line run in it and its ignored build caches cloned from the main checkout.
- Open a plain shell or an agent shell (claude or codex) inside any tree, from the card and from the CLI.
- See each tree's branch, where it stands against its base, how many files it holds changed, its port and its open shells.
- Remove a tree, with the branch kept unless asked, refusing while it holds work unless forced.
- The same from the CLI, including a shell function that changes into a tree by branch name, the way `wt switch` does.

## Non-goals

- Landing a kept tree through the queue. A tree's branch is pushed or merged by hand; the landing queue stays for branch runs.
- Running a canopy job (a run) inside a tree. Runs are one per repo and a tree's agent is an interactive shell, as worktrunk's are.
- Per-tree dev tasks and compose stacks (FR-039 plans 2 and 3). A tree gets a `PORT` in its shells; starting the dev task there is still by hand.
- Trees on a repo another host holds. Only a local, absolute path gets one.

## Where trees live

`<configDir>/trees/<repo key>/<slug>/`, beside the run worktrees under `worktrees/`. The repo key is the one `core/worktree.ts` already uses. The slug is the branch name made safe for a folder: lowercase, runs of anything but letters, digits, dots and underscores become one dash, at most 48 characters. Two branches that slug alike refuse the second.

`<configDir>/trees/<repo key>/trees.json` records each tree: slug, branch, base, port, when it was made, whether caches were copied, and its state (`preparing`, `ready`, `failed` with why). It is written by the server alone. At start the server adopts what is on disk: a folder git no longer lists as a worktree is dropped from the record, and a record whose folder is gone is forgotten.

The scan never finds a tree as a repo, since the config dir is not under a scanned root. The main checkout's elsewhere chips (`⧉`) still count a tree that holds work, which is right: it is work the checkout does not have.

## Making a tree

`POST /api/trees/add {repo, branch, base?, caches?}` (operate):

1. The branch name is checked with git's ref rules. A branch that exists is checked out into the tree; one that does not is created at `base`, which defaults to the repo's default branch (`origin/HEAD`, else `main`, else `master`).
2. `git worktree add` runs at once, and the answer carries the tree in state `preparing`.
3. In the background: the main checkout's ignored entries (`git ls-files --others --ignored --exclude-standard --directory`) are copied into the tree with a copy-on-write clone (`cp -Rc` on macOS, `cp -R --reflink=auto` on Linux, a plain copy elsewhere), unless `caches` is false. Then the repo's `setup` line from `.canopy/gates.json`, when it has one, runs under the gate environment. A failure leaves the tree in place, state `failed` with the last lines, since a half-prepared tree is still a tree.
4. A port is chosen for the tree from `CANOPY_TREE_PORTS` (default `7900-7949`, the range FR-039 plan 2 reserved for task ports), by hashing the branch name into the range and walking forward past ports another tree holds or something listens on. It is kept in the record and handed to every shell in the tree as `PORT` and `CANOPY_TREE_PORT`.

The `trees` event carries the whole list after each step, and again when the repo's main checkout changes (a commit in a tree moves refs in the common git dir, which the checkout's watcher sees).

## Shells in a tree

A shell socket may name `tree=<slug>` with its repo id. The server resolves the slug through the record, never from a path the browser sends, and starts the shell in the tree's folder with `CANOPY_TREE=<slug>`, `PORT` and `CANOPY_TREE_PORT` added to the usual `CANOPY_*` environment. The shell's `path` is the tree's folder, so a kept shell restores into the tree, the agents board files its agent under the repo, and the sweep treats it like any shell. `start=agent` types the repo's shell agent into it, with a harness or profile pick as on the main checkout. The tab is labelled with the branch.

## Removing a tree

`POST /api/trees/remove {repo, tree, force?, deleteBranch?}` (operate). Without `force`, a tree with changed files, commits its base lacks or a live shell is refused, and the answer says which. `git worktree remove --force` then `git worktree prune`; the branch goes only with `deleteBranch`.

## The card

A new panel section, "Worktrees", between landing and tasks: one row per tree with its branch, `↑n ↓m` against the base, `●k` changed files, `:port`, its age, and buttons for a shell, an agent shell, its changes (the elsewhere drill, which already reads a linked worktree's files and commits) and remove. The header counts the trees and says when one is preparing or failed. A form under the rows takes a branch name, a base and two checks (copy caches, open an agent shell when ready). The card itself gets a `⑂ 2 trees` chip that opens the section.

## The CLI

```
canopy worktrees [repo] [--json]                 lists the kept trees with the run and warm trees
canopy worktrees add <repo> <branch> [--base REF] [--no-caches]
canopy worktrees rm <repo> <branch> [--force] [--delete-branch]
canopy worktrees path <repo> <branch>            prints the tree's folder
canopy worktrees shell-init                      prints a shell function, cw, that cds into a tree by branch
```

## Testing

`core/branchtrees.test.ts` makes real repos in a temp dir: slugs and branch names, the hashed port and its walk, the ignored-entry list, the copy, the status counts, add and remove. `server/branchtrees.test.ts` drives the hub with a fake setup and listening list through `handle`, including the refusal paths and adoption. `ui/src/trees.test.ts` covers the words and the chip. The callers test pins the rights.

## Left to the builder

Row and form markup follow the landing section's classes. The chip's tone is quiet; a failed tree turns it rust.
