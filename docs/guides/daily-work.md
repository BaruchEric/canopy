# Daily work

[All guides](README.md) · Related: [Tasks and preview](tasks-and-preview.md), [Agents and runs](agents-and-runs.md)

## Find the repo that needs attention

1. Open **git**, or press `g` then `g` outside a text field.
2. Press `/` to filter the repos by name. Press `d` to toggle repos with changes, or `*` to toggle starred repos.
3. Read the card's branch and change counts. An ahead count means local commits remain to be pushed; a behind count means the tracked branch has commits you have not pulled.
4. Open the repo. If the card combines multiple backends, confirm the selected machine in the panel header before editing or running commands.

Use the card's menu for actions such as a shell, agent settings, and workflows. For several projects, keep multiple panels open in the dock or choose **dock tabs** in Settings' opening options.

## Inspect and stage changes

1. Choose **show more** if the panel is in intermediate mode.
2. Open **changes**. Click a file to inspect its diff.
3. Tick the files you want in the next commit. A tick stages a file; removing the tick unstages it.
4. Check that the selection contains only the work you intend to commit. Open **history** when you need to compare it with an earlier commit.

Staging selects what Git will commit. It does not create a commit or push anything. A file can contain both staged and unstaged edits, so review both when the diff shows them.

## Save and back up your work

Choose either the agent-assisted path or the direct Git controls.

### Ask the agent to save

1. In the intermediate panel, choose **Save my work**. The shell toolbar's save action sends the same request.
2. If an agent is already running in a shell, Canopy pastes the request without submitting it. Read what the shell is waiting for, then press Enter when ready.
3. Follow the agent's output and answer any questions.
4. Inspect the new commit in **history** and confirm that the intended commits no longer show as unpushed.

This request includes both committing and pushing. Agent completion alone is not proof that the push succeeded; read the reported result and the repo status.

### Commit directly

1. Stage your chosen files in **changes**.
2. Write a commit message, or use **suggest** and edit its result.
3. Choose **commit** to create a local commit, or **commit + push** to also send commits to the remote.
4. Read any error shown by the panel. After success, check **history** and the ahead count.

Use an explicit staged selection when you need to control the commit's contents. The combined commit-and-push shortcut can stage everything when nothing is staged and can suggest a missing message. Read its options before using it.

A clean working tree means there are no uncommitted file changes. Check the ahead count separately to know whether commits have been pushed. A successful push does not establish that the app was deployed.

## Pull changes

Read the repo status before choosing **pull**. If Canopy reports a conflict or divergence, inspect the explanation and resolve it in the repo's shell or with an agent. Repeating pull or push without addressing the reported problem will not resolve it.

After a pull, rerun the app or checks relevant to the incoming changes. If the same project exists on multiple machines, confirm the other checkout separately; updating one checkout does not make every checkout identical.

## Work in shells

Open **shell** from the repo menu. The terminal runs on that repo's backend, in its checkout. An agent launched inside it uses that machine's installation and login.

- Open **sessions**, or press `g` then `s`, to work with sessions across repos.
- Use a shell tab's menu to **split right** or **split down**. Click the pane you want to type into and drag the divider to resize it.
- Inside a shell, `Ctrl+Shift+D` splits right and `Alt+Shift+D` splits down.
- Use the tab's menu to move it between the repo's shells and the shells strip. A section's gear can also place changes, history, or another section beside your shells.

A page reload reconnects to backend tmux sessions. Explicitly closing a shell or pane ends that shell; moving it to another place is the way to rearrange it. After a machine reboot, kept shell history can restore the old output in a new shell, but the old processes are gone.

## Clean up idle work

Open the broom in **sessions** or the agents board to preview a sweep. Read each row's reason, select what you want to close, and use **Close N**. PRs require an explicit selection in this sheet. Closing a PR is a public GitHub action and leaves its branch intact.

Settings' **sweep** tab controls scheduled cleanup for the home backend. Review the selected kinds before enabling it. Shells running a foreground program are excluded from automatic cleanup.

## Useful keys

Press `?` outside a text field for the shortcuts available on the current view.

| Key | Action |
| --- | --- |
| `Cmd+K` on Mac, `Ctrl+K` elsewhere | Open Canopy's command line, including from a field or shell |
| `g`, then `g` | Git repos |
| `g`, then `b` | Agents board |
| `g`, then `s` | Sessions |
| `g`, then `h` | Health |
| `w` in git | Waiting on you |
| `x` in git | Toggle repo selection for bulk actions |

Type the second key of a `g` sequence within 1.5 seconds. Single-key shortcuts do not apply while typing in text fields or terminals.
