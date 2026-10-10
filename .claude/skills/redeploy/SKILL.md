---
name: redeploy
description: Redeploy the shared canopy backend (the docker compose stack on macmini-2018) with `bun run redeploy`, from the Mac, from a canopy shell on the mini, or on the mini itself. Use whenever the user says deploy, redeploy, ship to the mini, push canopy live, "update canopy.beric.ca", or asks what canopy version is running there, and when a deploy failed (port in use, shells dropped, canopy not answering on :7850).
---

# Redeploy canopy

One command, the same everywhere, run in the canopy checkout:

```
bun run redeploy            # deploy
bun run redeploy --restart  # deploy, and recreate canopy even if nothing changed
bun run redeploy status     # checkout, deployed commit, containers, port
bun run redeploy log        # the last deploy's full log
```

Where it runs decides what it deploys:

- **On the Mac** it deploys the Mac's committed `main`. It ssh's to `macmini-2018`, fast-forwards the mini's checkout from the Mac through the `mac` peer remote, checks the mini is at the Mac's HEAD, then deploys. Commit first: uncommitted changes never reach the mini. Pushing to GitHub is not needed, since the mini cannot read the private https origin anyway.
- **In a canopy shell on the mini** (the `shells` container, which has no docker) it deploys the checkout that shell sees, which is the mini's own `~/dev/dev-tools/canopy`. The script ssh's to the host with `~/.ssh/canopy_deploy`. That key's `authorized_keys` line runs `scripts/redeploy.sh --gate` and nothing else. Add `--pull` to take the Mac's `main` first.
- **On the mini host** it deploys directly.

The compose run is detached on the host and logged under `~/.cache/canopy-deploy/`. A dropped ssh or a closed tab does not stop it halfway, and a second deploy is refused while one runs.

## Shells

A normal deploy recreates only the canopy container, and only when it changed. A deploy of the commit already running rebuilds to the same image and leaves the container up, so pass `--restart` to get a fresh one anyway. Every shell stays, including the one running the deploy, and browser tabs rejoin. When the deploy would also recreate the `shells` container (a change to the Dockerfile's `shells` stage or `lib/tmux*.conf`, a compose change to that service, or a base image bump), the script stops with exit 3 and says so. That recreate ends every shell. Only rerun with `--shells` once the user agrees. The kept-shells chip (a clock with a back arrow and a count) restores them afterwards.

## When it fails

- **"up failed; what holds 7850"**: another service took canopy's port. On 2026-09-25 it was tailchan, now on 7855. Move the other service, not canopy, since every device and the tunnel use 7850. Then run `docker compose up -d --force-recreate shells canopy` on the mini. A failed bind leaves the shells container running with no published ports, which a plain `up` does not fix.
- **"the mini's main and the Mac's have both moved"**: someone committed on the mini. Merge on one side, then deploy again.
- **"no deploy key"** in a shell: run `scripts/redeploy-setup.sh` once on the mini host. It is idempotent.
