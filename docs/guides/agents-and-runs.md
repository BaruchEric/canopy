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
3. For a job that will edit files, decide whether to use **on a branch of its own**. This creates a separate worktree. Without it, the run works in the selected checkout.
4. Start the run. Follow the commands, output, and agent messages in its console.
5. If it needs input, open the prompt in the console or **waiting on you**. Answer the question or choose the appropriate permission response.
6. When the run finishes, inspect its result, changed files, and checks. A completed agent turn is not proof that the requested behavior works.

In chat, later messages continue the conversation. **end chat** closes it. A chat can retain the repo's ordinary run slot between messages, so end an unused chat if it prevents another job from starting.

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
canopy run
canopy run show RUN_ID
canopy run export RUN_ID --out run-notes.md
canopy queue
```

Use `--backend URL` when targeting another backend. For remote starts, a repo ID known to that backend avoids requiring the checkout path to exist on the CLI's machine.

The run list includes kept transcripts. Export one when you need a durable copy outside Canopy's retention window. Review the transcript before sharing it, since it can contain project content and command output.
