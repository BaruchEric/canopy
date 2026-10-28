# Tasks and preview

[All guides](README.md) · Related: [Daily work](daily-work.md), [Automation](automation.md)

A task runs a named command on the repo's backend. The preview displays the app served by that command. Use a checkout local to that backend for this workflow.

## Start your app

1. Open the repo and confirm its backend.
2. In the intermediate panel, choose **Run my app**. In the full panel, unfold **tasks** and start the dev task.
3. Open the task's terminal or log and wait for the app to report that it is ready. A process marked running may still be starting.
4. Open **preview**. Select the app's listening port and enter the path you want to view if it is not `/`.
5. Exercise the page you changed. Check the task log if the preview reports an error.

The preview uses the selected checkout's backend. On a phone or another computer, entering `localhost` directly in a browser would refer to that device instead. Use Canopy's preview or the app's configured network address.

Use **Stop** to end the dev task. For a running task, **Restart** stops it and starts it again. These task controls are separate from closing the repo panel.

## Define a missing task

Canopy detects tasks from `package.json` scripts, `Cargo.toml`, and `Makefile`. If the intermediate panel offers **Set up run**, it can ask the agent to configure a dev task. A request pasted into an existing agent shell waits for you to press Enter.

To configure it yourself:

1. Open the full panel's **tasks** section and use its task editor.
2. Set the command and any working directory relative to the repo.
3. Mark the app's task as the dev task so the preview and **Run my app** use it.
4. Start it manually and check the output before enabling automatic startup or restart.

Edits through the UI apply to that backend. To share task definitions with other checkouts, put them in the repo's `.canopy/tasks.json`:

```json
[
  { "name": "dev", "cmd": "bun run dev", "dev": true },
  { "name": "test", "cmd": "bun test" }
]
```

Use commands that actually exist in your project. This example is for a Bun project. Backend-specific edits override checked-in definitions, which override detected tasks.

| Setting | Effect |
| --- | --- |
| `dev` | Selects the task used by the app controls and preview. Use one per repo. |
| `cwd` | Runs the command from a subdirectory, such as `web`. |
| `keep` | Restarts failures with increasing delays and restores the task after a backend restart. It gives up after repeated quick failures. |
| `withPanel` | Starts the task when its repo panel opens. |
| `hidden` | Hides a detected task from the normal list. |

Automatic `keep` and `withPanel` behavior applies only to repos Canopy recognizes as yours. Cloning another person's project does not authorize it to start commands automatically.

## Investigate a failed task

1. Open the failed task and read the last run's log. Logs remain available after the process exits.
2. Look for the first useful error, such as a missing dependency, occupied port, or failed test.
3. Correct the cause in the repo's shell, or use **fix with the agent** when offered. Canopy supplies output from the failed task.
4. Run the task again and check its result. For a dev server, also reload and exercise the app.

If a kept task says it gave up, fix the cause before restarting it. A restart loop does not repair a bad command or missing configuration.

## Send feedback from the preview

1. Start the app and load the page in **preview**.
2. Choose **pick**, then select an element on the page.
3. Write a note and choose whether you want to change it or ask about it. Use **add** to collect more notes.
4. Review the annotations, then use **send** to choose the receiving agent or session. **copy all** copies the combined prompt instead.
5. Read the agent's response, reload the preview, and check each requested change.

For visual details, **clip** captures a selected rectangle. **draw** lets you add marks, then **snap** captures them. While picking, `C` copies the hovered element's information and `S` takes its picture.

Screenshots need browser screen-capture support and HTTPS or localhost. Follow the browser's capture prompt and select the intended tab. If capture is unavailable, use the text notes. A page's security policy can block the element picker; describe the element manually when that happens.

## Use the project bench

The bench brings changes, the app, shells, and a task's output into one project view. Use the task or preview section's bench control to focus that area. Use its restore control to return to the surrounding panes.

If the task runs but the app will not load, continue with [Preview troubleshooting](troubleshooting.md#the-app-is-running-but-the-preview-is-blank).
