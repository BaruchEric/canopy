# Canopy user guides

Use Canopy to work across Git repositories, keep terminals open, run your apps, and give jobs to coding agents. These guides follow the controls in the current checkout. An older deployed backend may have fewer options.

Start with [Getting started](getting-started.md), then follow the guide for the work you want to do.

| I want to… | Guide |
| --- | --- |
| Open Canopy, connect to a backend, and find a project | [Getting started](getting-started.md) |
| Review changes, commit, push, and organize terminals | [Daily work](daily-work.md) |
| Start an app, read its logs, and annotate its preview | [Tasks and preview](tasks-and-preview.md) |
| Choose an agent, run a job, and land a branch or open a PR | [Agents and runs](agents-and-runs.md) |
| Run repeatable workflows across projects and monitor triggers | [Automation](automation.md) |
| Recover a connection, find a missing feature, or diagnose a failed run | [Troubleshooting](troubleshooting.md) |

## Terms you will see

| Term | Meaning |
| --- | --- |
| Backend | The machine or container running Canopy's server. Commands and agents run there. |
| Source | A folder or forge that Canopy scans for repositories. |
| Repo | A Git repository. A project can have a checkout on more than one backend. |
| Shell | An interactive terminal at a repo, kept in a tmux session on the backend. |
| Task | A named process such as a dev server, test command, or build. |
| Run | A job or chat that Canopy drives through an installed agent CLI. |
| Harness | The agent CLI, such as Claude Code or Codex. |
| Workflow | A saved set of steps, with checks and optional decisions between them. |
| Fleet | One workflow started across selected repos. |
| Worktree | A separate checkout where a branch run can work without editing your main checkout. |
| Landing | Rebasing and checking a branch, then advancing its target branch locally. Pushing is separate. |

## Reference and administration

- [Command reference and feature details](../../README.md#cli)
- [Shared backend deployment](../deploy.md)
- [Custom workflow example](../workflows/example-update-deps.md)
- [Architecture](../architecture.md)

These guides describe using Canopy. Server installation, public access, secrets, and optional service configuration are covered in the deployment documentation.
