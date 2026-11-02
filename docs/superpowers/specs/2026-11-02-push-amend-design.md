# A rejected push that names an upstream amend (FR-048)

Date: 2026-11-02. Status: built the same day.

## The case

`web-apps/atlas`: main pulled 9944ed5 from the Mac peer, then the Mac amended it and pushed the amend, b254442. The next push here was rejected as behind, canopy rebased main onto origin/main, and the rebase stopped on a conflict, because the amend had added lines next to the ones 9944ed5 wrote. Nothing was wrong with either side: the local commit was a stale copy of one upstream already held.

## Detection

It runs only where today's push already gave up: the tracked upstream rejected the push as behind, canopy fetched, and `rebase @{u}` stopped and was aborted. A rebase that goes through (git drops a stale copy whose change upstream fully holds) keeps working as it does now.

Facts, all gathered with git through `exec.ts`, so an ssh locator works too: the merge base of HEAD and `@{u}`; the commits on each side since it (`log --reverse`, hash, parents, author time, author email, full message); for each candidate, the paths the local commit changed (`diff-tree --root`) and `diff --numstat` from the local commit to its upstream counterpart. A pure function (`core/stalecopy.ts`) decides:

- A local commit and an upstream commit match when their full messages (subject and body), author times (to the second) and author emails are equal. `commit --amend` keeps all three. The email is a call beyond the FR's wording, a stricter match at no cost.
- The upstream copy is a superset when, in every file the local commit changed, the diff from the local commit's tree to the copy's tree removes no line and is not binary: the copy keeps every line the local commit left in those files and may add more, in them or elsewhere. Dropping the local commit then loses none of its lines. An amend that rewrote one of the commit's own lines fails this and is not offered.
- Refused, with the reason said: a local commit that matches more than one upstream commit (or two local commits matching one), a matched commit that sits above local commits upstream lacks (`rebase --onto` would drop those too), local merge commits, and a copy that is not a superset.
- Offered: the matched commits are the oldest local ones, in a row from the merge base. Usually that is one commit, as in atlas.

When the stopped rebase names the commit it stopped on (`REBASE_HEAD`) and that commit is not one of the stale copies, the conflict belongs to a later commit and nothing is offered.

## What the card says

The push note keeps git's rejection and the conflict line, then: "Upstream holds an amended copy of 9944ed5 fix nav (b254442: same message and author time, and every line 9944ed5 left in its files)." Its button reads "drop the stale copy and push" when local commits sit after the stale one, "drop the stale copy" when none do. The agent hand-off that every failed push gets waits for a press here instead of starting by itself, since canopy has the fix. The waiting panel's push row shows the same offer.

## The action

`POST /api/repos/dropstale {stale, onto}` (operate): the newest stale commit and the upstream tip the note named. The server reads the facts again and goes on only when they give the same offer, so a branch or upstream that moved since is refused with "push again". It refuses a detached HEAD (a rebase in progress has one) and uncommitted changes to tracked files. Then `git rebase --onto <upstream tip> <stale commit> <branch>`, which replays the commits after the stale one and keeps them. A conflict there aborts the rebase, names the files and the commit, and leaves the branch as it was. When commits remain ahead, the push runs again.

CLI: `canopy push <repo> --drop-stale` does the same when the push is refused this way.

## Out of scope

- An amend that changed the message or reset the author date: nothing ties the two commits together.
- Offering the move before a push, from the card's ahead and behind counts alone.
- Pull: `pull --ff-only` refuses a diverged branch as before.
- Dropping a stale copy from the middle of the local commits.
