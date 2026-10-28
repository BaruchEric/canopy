# Troubleshooting

[All guides](README.md)

Start with the repo and backend involved, the action you attempted, and the exact message shown. Check **waiting on you** before retrying a job; it may be waiting for a decision rather than failing.

## A repo is missing

1. Clear the name filter and any dirty, starred, or other filters in **git**.
2. Check the **backends** control. The machine must be online and selected to **show here**.
3. Check that the repo is beneath a configured scan source. The folder used by `canopy ui` is the launch root.
4. Click the root folder path in the top bar and use **rescan**, or **add a folder** for a missing parent directory. For local startup configuration, run `canopy source` and `canopy source add /path/to/projects` on the backend machine using the server's config directory. CLI source changes apply on the next `canopy ui` start.

For the Library view, choose the local workspace parent as the launch root. Library needs Python 3.10 or newer on the backend and does not manage SSH and forge sources the same way the Git view does.

## I cannot find a control from a guide

Choose **show more**, or set Settings, **layout**, **repo panel** to **advanced**. Unfold the relevant section. If you moved that section into a shell tab, look there or use its **back to the card** action.

Some controls depend on the backend's installed tools or optional services. A forge-only repo or SSH source also has fewer actions than a local checkout. Check the selected machine and deployment version before assuming the feature is missing from your project.

## A backend is offline or asks for sign-in

Open **backends** and read the state and address for the affected machine. Use its sign-in link if offered, then retry. Check that you can reach that address from the current device, including its VPN or tailnet connection when required.

For CLI authentication:

```bash
canopy auth status --backend http://backend-name:7850
canopy auth login --backend http://backend-name:7850
```

Use your actual backend address. Approve the login request in the inbox of an already signed-in page. A fresh installation can use the first sign-in code from its server log. A CLI redirected to a web login needs the backend's direct reachable address; signing in through the browser alone does not create a CLI token.

## The agent does not start

Check the effective harness in the repo's settings and pre-flight. It must be installed, configured, and signed in on the selected backend. A working CLI on your laptop does not establish that the shared backend has it.

Read any refusal for an unsupported action. For example, **Plan, then build** requires Claude Code. Also inspect open chats, active runs, and any capacity message before starting another job.

If **Set up run**, **Save my work**, or a fix button seemed to do nothing, inspect the agent shell. These actions paste into an existing session without pressing Enter. Complete the shell's current question, then submit the intended request.

## A run is waiting or a branch will not land

Open the run console and **waiting on you**. Questions, permission prompts, workflow gates, and landing approvals require different answers. Read the reason before choosing an action.

For a branch sent back from landing, inspect its gate output or conflict. Fix that cause and retry. For a PR, open its CI details and the auto-merge waiting reason. A ready run is not necessarily landed, pushed, or merged.

## The app is running but the preview is blank

1. Read the task log and verify that the app finished starting.
2. Confirm the preview's port and path match the app's output.
3. Check the selected backend. The server must be reachable from Canopy's preview connection, not only from a different machine.
4. Try the preview's open-in-browser action to distinguish an app failure from an embedding restriction.
5. If Canopy reports a blocked preview, consult [Deployment](../deploy.md) for preview routing and HTTPS configuration. A page's security policy can also prevent embedding or picking elements.

After fixing the problem, reload the preview and exercise the app. A listening port alone does not prove the page works.

## A task keeps restarting

Open the task's log and fix the first actionable error. Stop it while investigating if repeated restarts obscure the output. Check its command, working directory, dependencies, environment, and port.

A task with `keep` backs off and eventually gives up after repeated quick failures. Restart it after correcting the cause. Backend-specific task edits override `.canopy/tasks.json`, so compare both if different machines behave differently.

## A shell disappeared after a reboot

Canopy keeps live shells in tmux, which survives a page reload and a Canopy server restart while the tmux server remains running. Rebooting the machine ends those processes.

Settings, **shell history**, **keep shell history** enables periodic snapshots on that backend. Restoring one creates a new shell with the previous output and offers to continue the agent conversation where supported. Restart ordinary processes yourself. Snapshots contain what the terminal printed, including any secrets printed there.

If a sweep closed the shell, inspect the sweep sheet's **swept** section for a restore action. Explicitly closing a shell or pane is different from hiding or moving it.

## Desktop openers are absent

Kitty, Terminal, Finder, and similar desktop actions need access to a desktop machine. A shared backend can use a helper on the computer you are sitting at:

```bash
canopy helper --pair --backend http://backend-name:7850
```

Use the actual backend address and approve the helper's pairing request. See [Deployment](../deploy.md) for the full helper setup. Without a helper, some openers hide and VS Code may use a Remote-SSH link.

## Check Canopy's health

Open **health**, or press `g` then `h`, and expand a failing row for its reason and recent changes. Use the offered heal action only after reading what it will restart or take over.

The CLI provides the same diagnostics:

```bash
canopy health --bad
canopy health show CHECK_ID
```

When reporting a problem, include the backend, repo, action, exact error, and relevant task or run output. Include the run ID when available. Remove secrets before sharing logs.
