# Getting started

[All guides](README.md) · Next: [Daily work](daily-work.md)

By the end of this guide, you will have a repo open on the correct backend and know where its shell, app, and changes appear.

## Open an existing Canopy installation

1. Open the Canopy address provided for your backend. A local installation normally uses `http://127.0.0.1:7850`.
2. Complete any sign-in required by the site. If Canopy itself requests pairing, follow its sign-in prompt and approve the request from an already signed-in page. The first sign-in uses the code from the server log.
3. Open the **git** view. Canopy lists repos found under the backend's scan folders.
4. If there is a **backends** control, open it and check which machines are online and selected to **show here**.
5. Click a repo card or its entry in the tree. When the project has multiple checkouts, use the panel's machine switcher to choose where you want to work.

The browser is a remote control. Opening the page on your laptop does not move a repo or its commands from another backend to the laptop.

## Start a local installation from the checkout

Skip this section if your backend is already running. You need Bun and Git on the backend, plus tmux for persistent shells. Agent features also need the chosen agent CLI installed and signed in on that machine. GitHub features use the backend's `gh` login.

From the Canopy checkout, run:

```bash
bun install
bun run build
bun link
canopy ui ~/dev
```

Replace `~/dev` with the parent folder containing your projects. Keep the server terminal running. Open `http://127.0.0.1:7850` if a browser does not open automatically.

Choose the workspace parent as the scan root. Starting at Canopy's own checkout shows only repos beneath that directory. For a persistent shared installation, follow [Deployment](../deploy.md).

## Choose how much the panel shows

A new browser uses the **intermediate** panel. It shows a plain-language status, an agent shell, and buttons to run the app and save work.

- Choose **show more** to reveal the full panel for this repo until you close it.
- Open Settings, then **layout**, and set **repo panel** to **advanced** for the full view everywhere.
- In the same settings section, **show the tour again** restarts the guided introduction.

Advanced panels include changes, tasks, history, files, preview, and other sections. Click a section heading to unfold it. Layout preferences belong to this browser and can differ by screen size.

## Make a first change

1. Open a local checkout on its own backend. The intermediate panel starts an agent shell when it needs one.
2. Complete any folder-trust or login prompt in that shell.
3. Describe a small change, such as `Explain where the home page lives, then change its heading to "Welcome".`
4. When the agent finishes, choose **show more** and inspect **changes**. Open each changed file to read its diff.
5. Use **Run my app** if a dev task exists. Otherwise, **Set up run** asks the agent to configure one. Follow [Tasks and preview](tasks-and-preview.md) to check the result.
6. Save using the process in [Daily work](daily-work.md#save-and-back-up-your-work).

**Save my work** asks an agent to commit and push. It is an instruction to the agent, not an immediate file-save operation. If Canopy pastes it into an existing agent shell, read the prompt and press Enter to send it.

## Add another source

For a running backend:

1. Click the root folder path in the top bar to open **folders**.
2. Under **add a folder**, choose the backend if several are connected.
3. Choose **this machine**, enter or browse to the parent folder, and choose **add**. Here, "this machine" means the selected backend.
4. Check the folder's repo count and any scan error. Use **rescan** to look for new repos again.

For a local installation, run these commands on the backend machine, using the same config directory as its server:

```bash
canopy source
canopy source add ~/work
```

The first command lists extra sources in the local config; the second adds a folder for the next `canopy ui` start. These commands edit local configuration rather than calling a remote backend. For a running server, use the UI's source controls to add a folder without restarting it.

For SSH and forge sources, see the [command reference](../../README.md#cli). Some features require a local checkout on a backend; scanning an SSH or forge source does not make it local.

## Connect a CLI to a shared backend

Replace the example origin with the backend's direct address:

```bash
canopy auth login --backend http://backend-name:7850
canopy auth status --backend http://backend-name:7850
```

Approve the pairing request in the Canopy inbox. The CLI saves a token for that backend. Set `CANOPY_API` to its address for later API commands, or supply `--backend` where the command supports it. A browser login does not sign in your CLI.

You have finished setup when the intended repo appears, its machine is correct, and a shell opens there. If any of these fail, use [Troubleshooting](troubleshooting.md).
