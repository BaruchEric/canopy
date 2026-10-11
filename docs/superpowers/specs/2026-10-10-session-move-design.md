# Moving a shell's agent session to another backend

Date: 2026-10-10. Status: design agreed with Eric in conversation, written spec awaiting his review.

## What the user asked for

"transfer sessions between servers". Asked what that means, Eric picked:

- what moves is the agent conversation (Claude Code or Codex) **and** the repo's uncommitted work, so the agent picks up mid-edit on the other machine;
- it is a move, not a fork: the source agent stops, and the source tree is reset to clean once the target has taken over (the work stays recoverable under `refs/canopy-moved/<session>`);
- it starts from a live canopy shell's tab row, and only there (no registry row, sessions list or CLI entry in v1);
- the browser carries the transcript between backends (approach A below), not the servers over ssh.

## What already exists

- **Several backends, one page.** The UI talks to each backend directly (`req(b, …)` in `ui/src/api.ts`). A shell tab's id is `<backend>|<hex>`, so every call for it goes to the backend it runs on. `joinRepos` (`ui/src/checkouts.ts`) folds one repo's checkouts on several machines into one card, and `checkoutPref` picks which one a panel shows.
- **Servers never call each other over HTTP.** Between machines they use git over ssh and the narrow `canopy-peer` gate (`askPeer`, `gateCommand` in `src/core/peersync.ts`).
- **Peer sync** snapshots a dirty tree as `refs/wip/<branch>` (`snapshotWip`), fetches peers into `refs/remotes/<peer>/*` and `refs/peer-wip/<peer>/*` (`fetchPeer`), fast-forwards local branches, and lands a peer's WIP as uncommitted files with `takeWip` when the tree is clean, HEAD is the WIP's parent, and nothing is busy. `POST /api/repos/peer {action: "sync"|"take"}` runs either for one repo under `withPeering`.
- **Resume.** `POST /api/repos/resume` opens a tmux shell and types `resumeLine` (`claude … --resume <id>`, `codex resume <id>`), after `hasAgentSession` finds the session under this machine's path.
- **Which session a shell runs.** The registry card for the shell (`cardOfShell`) carries `session` and `transcript`. Without a card, `GET /api/terms/transcript` gives the newest transcript in the shell's repo.
- **Paths.** Mac repos are under `/Users/ericbaruch/dev/`; the mini's are under `/home/eric/dev/` both on the host and inside the containers. Peer sync matches a repo across machines by its id, the path relative to the scan root. The mini's containers bind-mount the host's `~/.claude`, `~/.claude.json` and `~/.codex`.

## What is missing

- No code copies a file from one machine to another (only `askPeer`'s small allowlisted seeds).
- Claude files a conversation under `~/.claude/projects/<projectFolder(cwd)>/`, so a Mac session is invisible to `hasAgentSession` on the mini.
- No route stops a shell's agent, and no route resets a working tree.

## The main decision: the browser carries the transcript

The page asks the source for the transcript and posts it to the target. The servers stay unaware of each other, as they are today, and the `canopy-peer` gate gains nothing. The alternative, a `transcript <session>` gate command the target calls over ssh, would let any peer that reaches the gate read conversation transcripts, a wider opening than anything the gate allows now. The cost of the choice is that a long transcript (tens of MB) goes through the device running the page, phone included; the 64 MB cap below bounds it.

The uncommitted work still moves through peer sync: the target fetches from the source over ssh and lands the snapshot with `takeWip`.

## The flow

The page runs five steps, each one call to one backend.

1. **Check** (target). `POST /api/repos/movecheck?id=<target repo>` with `{from, branch, head, transcriptBytes}`. The target runs a peer sync of this repo, then requires:
   - peer sync is not `off`, and `from` is a git peer of this repo;
   - no canopy run or workflow is active on the repo;
   - the tree is clean;
   - `branch` is checked out and its HEAD equals `head` after the sync (a fast-forward during the sync counts; a target that is ahead or diverged is refused);
   - `transcriptBytes` is at most 64 MB;
   - no transcript of that session id already exists here, or the existing one passes the prefix rule (see "The transcript"), which the check can only confirm at load, so here it only reports that one exists.

   It returns `{ok: true}` or `{ok: false, reason}`. Nothing changes on either side. The source supplies `branch`, `head` and `transcriptBytes` through `GET /api/terms/move/plan?term=`, which also returns the session id, harness, first prompt, last activity time and the list of uncommitted files for the confirm sheet.

2. **Stop** (source). `POST /api/terms/move/out?term=` with `{session}`.
   - Marks the shell as moving; a second `out` for it is refused (409).
   - Ends the agent with `endAgent`: Escape (which stops a running turn and does nothing at an idle prompt), then `/exit` for Claude or `/quit` for Codex, typed and entered as two separate key sends, then waits up to 20 s for the pane's current command to be a shell again. If the agent does not exit, the step fails with nothing else touched.
   - Takes the repo's peer lock and runs `snapshotWip`. Returns `{session, harness, branch, head, wip}` (`wip` null for a clean tree).

3. **Transcript** (source). `GET /api/terms/move/transcript?term=&session=` streams the session file as it now is (complete, since the agent has exited).

4. **Load** (target). `POST /api/repos/movein?id=` with a multipart body: the transcript file and `{from, session, harness, branch, head, wip, term, place, cols, rows}`. Under the repo's peer lock the target:
   - fetches from `from` (`fetchPeer`);
   - if `wip` is set, lands it with `takeWip`, accepting only the clean landing (`how: "tree"`); any other outcome undoes nothing it did not do and fails the step;
   - writes the transcript (see below);
   - resumes the session in a new tmux shell (`resumeTerm`) and returns its term id.

5. **Clean** (source). `POST /api/terms/move/finish?term=`. Under the peer lock, `resetTree` returns the tree to HEAD (tracked files restored, files untracked in the snapshot removed), then the old shell ends (`endTerm`). Before the reset it points `refs/canopy-moved/<session>` at the snapshot commit. Peer sync never fetches that namespace and its pass never deletes it, so the work stays on the source after the pass drops `refs/wip/<branch>` (deleting a ref drops its reflog with it, so the reflog alone would not keep it).

Gitignored files (`.env`, build output) are not in a WIP snapshot and do not move. The confirm sheet says so when the repo has any.

## The transcript

New `src/core/move.ts` (pure where it can be, tested):

- **Claude.** One JSON object per line; most lines carry a top-level `cwd`. Each `cwd` under the source repo path is rewritten to the target repo path, keeping any subfolder part (`/Users/ericbaruch/dev/x/ui` becomes `/home/eric/dev/x/ui`). Message content, tool inputs and quoted paths are left as they are. The file is written to `~/.claude/projects/<projectFolder(target path)>/<session>.jsonl`, after which `hasAgentSession` finds it.
- **Codex.** The rollout keeps the source's `YYYY/MM/DD/` folders and file name under `$CODEX_HOME/sessions/`, with `cwd` rewritten in the first `session_meta` line. `codex resume <id>` finds it by id.
- **A file already there.** If the target already holds that session id (an earlier move the other way), the incoming file replaces it only when the existing one is a line-for-line prefix of it. Otherwise the load fails: the two copies have split, and canopy does not pick one.
- **Integrity.** Every line must parse as JSON before anything is written; the file is written to a temp name beside the destination and renamed. Over 64 MB is refused.

The mini's canopy container writes into the host's `~/.claude` through the bind mount, and `claude` in the `shells` container reads it. The build checks that both sides agree on ownership and that a moved file resumes there.

## The UI

- **The button.** "move to <backend>" in a shell tab's row (`AgentButtons.tsx`), beside "switch to codex". Shown when an agent runs in the shell, the shell is not a task or a seed's, and the repo's card has a checkout on another backend the page shows. With two or more such backends it opens a short list.
- **The confirm sheet** (`ui/src/components/MoveSheet.tsx`). Before anything stops it shows the session's first prompt and last activity (so a wrong guess of the session is caught), the target backend and its repo path, the count of uncommitted files with a toggle to list them, a note when gitignored files will stay behind, and the check's result, run as the sheet opens. A failed check disables "move" and shows its reason.
- **Progress.** The sheet lists the five steps and ticks each off. When load succeeds, the new tab takes the old tab's place in the same panel, and the panel's `checkoutPref` switches to the target.
- **Failure.**
  - Before stop: everything is as it was; the sheet shows the reason.
  - After stop, before load succeeds: "resume here" calls `POST /api/terms/move/undo`, which types the resume line back into the same source shell (the agent quit back to it) and forgets the move. The source tree is still dirty, since nothing reset it.
  - At clean: the session already runs on the target. The sheet says so and offers "clean source" to retry the step.
- **Code.** A store action `moveShell(tabId, toBackend)` in `ui/src/store.ts` runs the steps; calls go in `ui/src/api.ts`. Styles use the existing tokens in `ui/src/styles.css`.

## Safety

- **Locks.** Each side holds the repo's peer lock (`withPeering`) for its own steps, so a background sync pass cannot snapshot or fast-forward mid-move. Both sides refuse with 409 while a canopy run or workflow is active on the repo.
- **Each step can be run again.** Check changes nothing. Stop on an agent that has already exited only snapshots. Load that finds the WIP already landed and the transcript already written only starts the shell. Clean on a tree already at HEAD only ends the shell.
- **`resetTree` refuses drift.** It compares the working tree with the snapshot taken at stop and refuses (409) if anything changed since, so an edit made on the source after the move is never thrown away.
- **Auth.** The new routes sit behind the same access checks as the other mutating routes. The upload is a single body capped at 64 MB plus the form fields.

## Files

- New: `src/core/move.ts` (the transcript rewrite and placement, and `endAgent`) and `move.test.ts`; `ui/src/move.ts` (the step runner) and `move.test.ts`; `ui/src/components/MoveSheet.tsx`.
- Changed: `src/core/peersync.ts` (`resetTree`), `src/server/index.ts` (seven routes: `/api/terms/move/plan`, `/api/terms/move/out`, `/api/terms/move/transcript`, `/api/terms/move/finish`, `/api/terms/move/undo` on the source, `/api/repos/movecheck` and `/api/repos/movein` on the target, since `/api/repos/<action>` takes one lowercase word), `src/core/sessions.ts` (`transcriptFile`), `ui/src/api.ts`, `ui/src/store.ts`, `ui/src/components/AgentButtons.tsx`, `ui/src/styles.css`, `docs/architecture.md` (a "Moving a session" section).

## Testing

- **Unit.** `move.test.ts`: the `cwd` rewrite at the repo root and in a subfolder, a `cwd` outside the repo left alone, the Codex `session_meta` line, the prefix rule (replace, refuse a split), a cut-off last line refused, the size cap. `move.test.ts` also: `endAgent` against a fake pane, including an agent that never exits. `peersync.test.ts`: `resetTree` cleaning a tree that matches its snapshot and refusing one that drifted.
- **Server.** Two scratch checkouts set up as each other's peers with the existing peersync fixtures, and fixture transcripts under two separate homes. End to end: plan, check, out, transcript, in, finish. Then a dirty target refused at check, a target branch ahead refused at check, and a load failure leaving the source dirty and resumable.
- **Live.** After the four gates, a throwaway Claude session in a scratch repo moves from the Mac to the mini and back, in a real browser. Each time, the resumed agent recalls an earlier turn, and the uncommitted files appear on the target and are gone from the source.

## Out of scope

- Moving a headless run (`claude -p`) or a past session from the sessions list.
- A CLI entry (`canopy move`).
- Forking a session (both sides keep going).
- Carrying gitignored files.
- Rewriting paths inside message content.

## What the probes showed (2026-10-10, plan Task 0)

- **A hand-moved Claude session resumes on the mini.** A `claude -p` session made in the Mac's `~/dev/dev-tools/canopy` (24 `cwd` lines, all the compact `"cwd":"…"` form) was copied with `cwd` rewritten to `/home/eric/dev/dev-tools/canopy` into the mini host's `~/.claude/projects/-home-eric-dev-dev-tools-canopy/`. `claude -p --resume <id>` inside `canopy-shells-1` at that folder recalled the codeword. The host writes the file as uid 1000 and the container runs as `bun`, uid 1000, so ownership needs nothing. The resume appended to the same file rather than forking a new id.
- **The sibling folder.** Some sessions have `projects/<folder>/<session>/tool-results/` beside the transcript (64 KB in the one looked at). The probe session had none and resumed fine. Moving that folder stays out of scope: the transcript already carries what the agent saw, and only a later re-read of a saved tool output would miss it.
- **Claude quits on Escape, `/exit`, Enter** sent as three separate key sends in a tmux pane: back at the shell in 2 s, and slash autocomplete did not pick another command.
- **Codex quits on `/quit` and on `/exit` alike**, back at the shell in 1 s. Codex 0.162 runs its work in a shared daemon, and quitting the TUI only disconnects: it prints "Any running work continues". So Escape before the quit command matters for Codex (it stops the turn in progress), and if a turn kept going in the daemon and edited files after the snapshot, `resetTree`'s drift check refuses the reset rather than losing those edits. Codex stays on `/quit`.
- **Backend names are peer names.** The Mac's config has self `mac`, peer `mini`; the mini's has self `mini`, peer `mac`; both list backends `mini` and `mac`, and peer sync is on for both. The page's `backendOf(tab.id)` is what the target looks up among its peers, so no mapping is needed.

## As built

The design held in shape: five steps, the browser carrying the transcript, the snapshot kept before the reset. What the code does that the design did not say:

- **Route names.** The source answers `/api/terms/move/plan`, `/move/out`, `/move/transcript`, `/move/finish` and `/move/undo`. The target answers `/api/repos/movecheck` and `/api/repos/movein`, because `/api/repos/<action>` takes one lowercase word.
- **Undo.** `move/undo` types the resume line into the same shell instead of opening a new one, and does nothing when an agent is back in the pane.
- **Codex.** It quits with `/quit` (Claude with `/exit`), after an Escape, with the text and the Enter sent as separate key sends.
- **The snapshot.** `refs/canopy-moved/<session>` holds it, and `refs/canopy-moved-index/<session>` holds what was staged when that differs from HEAD: the index's tree as a commit whose parent is the snapshot, so a staged version that differs from the file on disk survives the reset. `resetTree` runs `git clean` before `git reset --hard`, so an uncommitted `.gitignore` rule cannot hide files from the clean. It refuses files marked assume-unchanged or skip-worktree, a HEAD that moved, and a merge or rebase in progress, and it resets with `submodule.recurse=false`.
- **The source's record.** `state.moving` holds a stage union: `stopping` (held before the first await, so a second out is refused), `stopped` (the agent is gone, no snapshot yet), `saved` (the snapshot is in hand). `move/transcript` and `move/finish` refuse until the stage is `saved`. Out moves to the next stage only while the record is still the one it set, and otherwise answers 409 "the move was called off". Ending the shell, or the shell exiting, drops the record.
- **The move id.** The sheet mints one per try and `move/out` takes it as `move` and echoes it in `MoveOut`. `move/transcript`, `move/finish` and `move/undo` must name it, and answer 409 for another move's id, so a second window can never undo the first's move. The page mints it rather than the source because out's answer can be lost after the agent quit, and the undo needs the id then.
- **Finish.** `move/finish` answers 409 while an agent runs in the pane again.
- **The target's load.** `movein` refuses everything it can before it takes the work: harness, dry mode, active runs, a split transcript, the fetch and the branch. The term id in its metadata is an idempotency key, so a retry after a lost answer finds the shell and touches nothing, and a retry that arrives while the first load still runs waits for it. A term id another shell holds is refused before any work lands. The work lands first and the transcript second; a retry that finds the tree already equal to the snapshot skips the take. `movecheck` also refuses when peer sync is in dry mode.
- **The sheet.** It keeps the tab, harness and session it opened on, since the stop quits the agent and the tab row may come to show another shell. Closing a failed sheet after the agent stopped runs the undo; a 4xx from out means nothing was touched, so there is nothing to undo. The one exception is the 409 for an agent that did not quit within 20 s: the quit keys went in, but the source already dropped its record, so a late quit leaves the agent stopped and the user resumes it by hand.
- **A lost load answer.** A load that fails with no HTTP status is unknown, not failed. The sheet tries once more under the same shell name; if that is unanswered too, it says the target may already run the session and offers "check again" and "resume here anyway", and closing it does not undo. A loaded tab lands exactly once (`landOnce`), whether by success, the clean retry, closing, or the sheet going away.

### Live check

Not run yet. It waits on the owner's go to push and redeploy the mini. It will cover, in a real browser on canopy.beric.ca with a scratch repo checked out on both machines:

1. Start Claude in a Mac shell, tell it a codeword, and leave one modified and one new file.
2. Move to the mini. The mini's tab opens, the agent returns the codeword, both files are on the mini uncommitted, the Mac's tree is clean, and `git rev-parse refs/canopy-moved/<session>` works on the Mac.
3. Move it back to the Mac and repeat the checks the other way. The second move replaces the Mac's earlier transcript under the prefix rule.
4. On the mini host, `ls -ln` on the moved transcript shows an owner the `claude` user in the shells container can read (the bind-mount question).
