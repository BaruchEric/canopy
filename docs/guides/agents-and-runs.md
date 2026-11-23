# Agents and runs

[All guides](README.md) · Related: [Automation](automation.md), [Troubleshooting](troubleshooting.md)

Canopy can open an interactive agent in a shell or drive a job through its own run console. Both use an agent installed on the selected backend.

## Choose how to work

| Need | Use |
| --- | --- |
| An ordinary interactive Claude Code or Codex terminal | An agent shell |
| A conversation in Canopy with messages and tool output | Chat |
| A bounded request with a result to inspect | A job |
| A proposed implementation plan followed by building | Plan, then build, which requires Claude Code |
| A repeatable sequence such as checks, commit, and push | A workflow |

## Check the agent settings

1. Open the repo's **agent settings** from its menu.
2. Choose the harness, model, effort, and permissions. An unavailable harness is disabled or reports that it is missing on the backend.
3. For defaults shared by projects, open Settings' **agent defaults** on the intended backend. Use profiles and work-type choices when you want different agents for different jobs.
4. Check the effective agent shown for the action you will start. A repo, workflow, or task override can change the broader default.

**ask** allows permission prompts. **yolo** runs commands without asking. Read the setting before launching work; the pre-flight dialog also says when yolo is on.

With Codex, a provider value names an entry already configured on the backend. Canopy stores the provider ID, not its credentials. Model availability and authentication come from the installed CLI and its configuration.

## Start and follow a job

1. Open the repo menu and choose a job or chat action.
2. Read the pre-flight description and enter a concrete request. Include the expected behavior and how it should be checked.
3. For a job that will edit files, decide whether to use **on a branch of its own**. This creates a separate worktree. Without it, the run works in the selected checkout. When a run or a workflow is already going in the checkout, the box comes ticked; untick it to work in the checkout beside them.
4. Start the run. Follow the commands, output, and agent messages in its console.
5. If it needs input, open the prompt in the console or **waiting on you**. Answer the question or choose the appropriate permission response.
6. When the run finishes, inspect its result, changed files, and checks. A completed agent turn is not proof that the requested behavior works.

In chat, later messages continue the conversation. **end chat** closes it.

Once a run holds two messages of yours, a rail of ticks runs down the right edge of its console, one tick per message. Point at a tick to see that message's first words, the start of the reply and its place, such as "49 of 96". Click it to bring the message to the top. `Option+Up` and `Option+Down` on a Mac, `Alt` with the same arrows elsewhere, step to the message before or after. They also work from the run's message box while it is empty. Once the box holds a draft, they move the caret as they do in any text field. On a phone or a touch screen the ticks become a bar under the console: the place, which opens the list of your messages, between an up and a down button.

## Ask a side question while a run works

A question for a run that is busy does not have to wait for its turn or cut into it. Start the message with `btw` in the run's box, or press **btw** beside send:

```text
btw what does retryBackoff default to?
```

- The box says the message is a side question and offers a model for it. **send it to the run instead** sends the words to the run as typed.
- The answer comes in a thread beside the run, or over it on a phone. The thread starts with what the run knew when you asked, so it can answer about files the run has read. The run gets no message and keeps working.
- Go on in the thread's own box. Its model select changes the model for the messages that follow.
- Close the column to put the thread away. Its tab, marked `btw`, brings it back. **end chat** ends it, and ending the run leaves the thread open.
- The thread is told to answer and to change no file unless you ask. It counts as one of the checkout's runs.

A run that has ended takes no side question; fork it from its replay instead. On the CLI, `canopy run side RUN_ID "your question"` starts one and prints the new chat's ID, and `canopy run say` goes on in it.

## Run several at once on one repo

A repo's checkout takes up to 8 runs at once, so an open chat does not stop a job or a second chat from starting. An incubator project is the exception and keeps one run at a time.

- Each run has a name. Canopy cuts one from the first message, and a moment later your own `claude` writes a shorter one. Start a run under your own name with `--name` on the CLI.
- The row of tabs under a run's head lists every run going on the repo. Press another tab to switch to that run. Press this run's tab to rename it; a name you type is never replaced. **+ chat** starts another chat; while the checkout is in use it opens the pre-flight first. A run popped out into its own window has the same row: a tab there takes the window to that run.
- The repo menu lists each run with its name and state. The card's chip shows the run that most needs you, with `+N` for the others.
- Runs in one checkout share its files. Each is told to leave the others' changes alone and to commit only its own files, and Canopy tells both when they have edited the same file.
- A job or a chat that starts while the checkout is in use gets a branch of its own unless you untick **on a branch of its own** in its pre-flight. A chat on a branch needs a first message. It commits on its branch without pushing, so its work reaches main only when you land it after the chat ends, and it holds one of the repo's three branch slots while it is open.
- A workflow and plain runs share a checkout too. Start a chat or a job while a workflow runs, or a workflow while a run is at work: the pre-flight says what the start will share the checkout with, and the run's first note names the workflow. A workflow's check reads the files as they are, another run's unfinished changes included, so a check first waits up to ten minutes for a run that is mid-turn, and the step says whom it waits for. A check that still fails beside a run at work says which runs were there. A checkout takes one workflow at a time.
- A run across a workspace works in every member's folder, so it counts as a run in each member's checkout and starts beside a workflow going in any of them.

## Start from an issue

For a branch run, start the note with a GitHub issue number such as `#123`, or a GitHub issue URL, then add your instructions. Canopy reads the issue through the backend's `gh` login and includes its title, body, labels, and recent comments. Check the **from issue** line in the pre-flight before starting.

## Land a completed branch

1. Open the ready branch run and review its diff and result.
2. Choose **land**. If the review requires approval, inspect the listed files and complete the approval shown by Canopy.
3. Follow the landing queue. It rebases onto the target, runs the repo's gates and configured scenarios, and advances the target when they pass.
4. If the branch is sent back, read the failed check or conflict and address it before trying again.
5. After landing, inspect the target branch and push separately when you want to publish those commits.

Landing does not push. A branch may also qualify for automatic landing under the repo's review policy; check that policy before assuming every branch will wait for a click.

A holdout judge that cannot answer may offer **land anyway**. That explicitly skips judge checks while rerunning command scenarios. Read the held result before using the override.

## Open a pull request instead

Choose **open a PR when done** in a branch run's pre-flight, or **open PR** when the branch is ready. This pushes the branch and opens a GitHub PR instead of landing it locally.

The run then shows the PR and CI state. Open the CI chip to inspect individual checks. Two separate controls determine follow-up behavior:

- **auto-fix CI and address comments** lets the run make and push fixes in response to failed checks and eligible review comments.
- **auto-merge when ready** allows merging when the PR satisfies its requirements. Read the displayed reason when it is waiting.

Opening the PR, passing checks, and merging are different events. Confirm the final PR state on GitHub. Comments from people without write access are shown for review rather than acted on automatically.

## Compare multiple attempts

When the branch pre-flight offers multiple runs, choose two or three attempts and review the additional resource use before starting. Each attempt gets its own branch. The group lets you choose a green, ready member; review the candidates before picking a winner.

The optional **auto-land the winner when its own review says auto** still depends on that winner's review policy. It does not make every winner eligible for automatic landing.

## Use the CLI and keep a transcript

These commands target a running backend. Replace the repo path and run ID with your own values. The start form below creates a branch run:

```bash
canopy run /path/to/repo ask -m "Fix the empty-state message and run the relevant checks"
canopy run ls
canopy run name RUN_ID "empty state copy"
canopy run stop RUN_ID
canopy run
canopy run show RUN_ID
canopy run export RUN_ID --out run-notes.md
canopy queue
```

Use `--backend URL` when targeting another backend. For remote starts, a repo ID known to that backend avoids requiring the checkout path to exist on the CLI's machine.

`canopy run ls` lists the runs going now with their names, `run name` renames one and `run stop` stops one and leaves the others going. `canopy run` alone lists kept transcripts. Export one when you need a durable copy outside Canopy's retention window. Review the transcript before sharing it, since it can contain project content and command output.
