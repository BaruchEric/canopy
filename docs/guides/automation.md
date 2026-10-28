# Automation: workflows, tasks, and triggers

[Guide index](README.md) · [Tasks and preview](tasks-and-preview.md) · [Agents and runs](agents-and-runs.md)

Workflows run a named sequence of agent steps. Tasks start and supervise a repo's local commands. Triggers start runs when an external event or schedule matches a rule.

## Workflow availability

These instructions follow the current checkout. An older backend may not support dependency conditions or manual steps in custom workflows.

The workflow sheet shows a step list and run timeline. Start workflows from the repo menu or fleet picker.

| Workflow | What it does |
| --- | --- |
| commit | Stages the intended changes and creates a commit without pushing. |
| push | Pushes the branch, rebasing only when safe. |
| ship | Runs gates, commits, then pushes. A failed gate stops it before committing. |
| review | Reads changes and reports problems without editing files. |
| deploy | Checks the project and uses its deployment procedure. This can change the deployed app. |

## Run a workflow on one repo

1. Find the repo on the board and open its `⋯` menu.
2. Choose a workflow. The menu shows its label and step count. A disabled item explains when a precondition is not met or a run is already active.
3. Review the preflight sheet: repo, branch facts, workflow description, ordered steps, checks, gates, and agent profile.
4. Add a note if the workflow needs one or you want to give the agent more context.
5. Choose the workflow's action button, named by its verb, to start.
6. Follow the run sheet. Click a step in the strip to inspect its run or check output.

The workflow menu refreshes when you open it. If a workflow file has an error, its menu item is disabled and marked `will not parse`.

## Run a workflow across repos

1. Choose `select` in the top bar, or press `x`.
2. Pick repos by clicking cards or tree rows. Use shift-click for a range. The `all`, `none`, `invert`, and `only…` controls use the repos currently in view.
3. Choose a workflow from the picker at the bottom, then choose `run on N…`.
4. Review the fleet preflight. It lists the repos that will run and groups skipped repos by reason. Add an optional note.
5. Choose `run on N` to start the eligible repos.
6. Use the fleet sheet to track each repo. Select a repo name to open its flow.

The fleet runs up to three repos at a time. An agent question can hold a place until you answer. Fleet starts reject workflows with explicit `ask` gates or `manual` steps, including committed repo overrides, because these require an attended workflow. Read skipped reasons in the preflight. The fleet picker lists bundled and user workflows; it does not list repo-only workflows.

## Respond to a gate or prompt

At a workflow gate, read the step summary and expand the check result to inspect its command and output. The sheet may also show verdict or judge results, budget details, or steps that were rewound.

Use the main continue button to accept the current result and let the flow proceed. A manual step waits before it runs; continuing releases it. Choose `retry this step` to run that step again when the button is available. Choose `stop here` to end the flow. Budget and stage-runner holds can limit which choices are available.

An agent permission request or question appears in the run timeline. Answer it there. This resumes the agent run; the workflow can still stop later at its own gate.

While a flow is active, `hide` closes the sheet and leaves the work running. Use `stop` to end active work. After a flow ends, `dismiss` removes it from the current view.

## Add a custom workflow

1. Copy [the dependency update example](../workflows/example-update-deps.md) into `~/.config/canopy/workflows/`, or into `$CANOPY_CONFIG_DIR/workflows/` when Canopy uses a custom config directory.
2. For a workflow used by one local repo only, put it in `<repo>/.canopy/workflows/` instead.
3. Give the file a unique `name`, a required `blurb`, and optional `label` and `verb` in its frontmatter. Add `when` to set the repo precondition, and `note` or `note-required` to customize the note field.
4. Add one `##` heading per step. Put step options directly below the heading, before a blank line and the prompt. Common options include `tools`, `turns`, `check`, `gate`, `after`, `when`, and `mode`.
5. Save the file and reopen the repo menu. Choose the new workflow and review its step list before starting it.

Steps run in heading order by default. Use `after` and `when` for dependencies and conditions. A step with an empty body runs only its `check` command. The `tools` option controls which agent tools are preapproved for that step; other requests can still ask for permission.

Workflow files load from three places: Canopy's bundled workflows, your config directory, and a local repo's `.canopy/workflows/`. When names match, the later source wins, so a repo workflow overrides a user workflow and a user workflow overrides a bundled one. Repo-specific files are for local repos. Fleet selection supports bundled and user workflows.

## Run and trust repo tasks

Open the repo's **Tasks** section to inspect its commands and status. Choose `▶` to start a task, `↻` to restart a running task, or `■` to stop it. Select a task to see its live terminal or searchable log. Use `add task` or a task's edit control to change task definitions.

Canopy can find tasks in `package.json` scripts, `Cargo.toml`, and `Makefile`. A checked-in `.canopy/tasks.json` can define or change tasks for everyone who clones the repo. Edits made in Canopy's task editor are kept in its config directory and take precedence over the checked-in file.

Review a task's command before starting it. A checked-in task definition does not by itself start a process. The `keep` option restarts a task after failure or a backend restart, and `withPanel` starts it when the repo panel opens. Canopy honors those automatic starts from a project's task file only when the repo has a remote you can push to. You can still start a task manually after reviewing it.

See [Tasks and preview](tasks-and-preview.md) for task logs, previews, and task settings.

## Monitor trigger rules and runs

1. Open **triggers**, or press `g` then `t` outside a text field.
2. Check each backend's rule cards. They show the source and repo, workflow, labels or schedule, hook-secret state, polling, and any configuration problem. A backend that does not hold the flows lock reports that its hooks start nothing.
3. For a label-polling rule, choose `poll now` to fetch matching issues immediately. Choose `try it` to send a sample issue through an issue rule. This starts a real branch run and marks the event as a test fire. For a schedule rule, `fire now` runs the schedule for one repo or every matching repo.
4. Follow events under **Needs you**, **Working**, **In review**, **Fixed**, **Nothing to fix**, and **Ignored**. An event title opens its run when one exists; issue and pull request links open their source pages.
5. Read the event's status, reason, repo, and branch before choosing an action. Available actions depend on the event state.

| Action | Effect |
| --- | --- |
| `stop` | Stops the run or removes it from the queue. |
| `resume` | Continues a stopped run on the same branch and session. |
| `start again` | Starts a new run on a new branch. |
| `dismiss` | Removes the event from this list. |

Use `canopy issues` for a command-line view of GitHub and Forgejo issue events. It reads every backend listed by the home backend by default. Add `--needs-you` to show only events waiting on you, a repo path or id to filter to one repo, or `--backend URL` to query one backend. This command does not list Sentry or Linear events.

Trigger rules are read from `triggers.json` in Canopy's config directory. The Triggers view shows the hook address and status, with `try it`, `poll now`, and schedule controls where available.
