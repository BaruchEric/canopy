---
name: redeploy
description: Redeploy a shared canopy backend (the docker compose stack on macmini-2018, or the one on the De Soto box) with `bun run redeploy`, from the Mac, from a canopy shell on the backend, or on its host. Use whenever the user says deploy, redeploy, ship to the mini, update De Soto, push canopy live, "update canopy.beric.ca", or asks what canopy version is running there, and when a deploy failed (port in use, shells dropped, canopy not answering on :7850).
---

# Redeploy canopy

One command, the same everywhere, run in the canopy checkout:

```
bun run redeploy            # deploy (from the Mac: to the mini)
bun run redeploy desoto     # from the Mac: deploy to the De Soto backend
bun run redeploy all        # from the Mac: each backend in turn, the mini first
bun run redeploy --restart  # deploy, and recreate canopy even if nothing changed
bun run redeploy --force    # deploy even though canopy has runs, flows or landings going
bun run redeploy status     # checkout, deployed commit, containers, port
bun run redeploy log        # the last deploy's full log
```

Where it runs decides what it deploys:

- **On the Mac** it deploys the Mac's committed `main` to the backend named: `mini` (the default), `desoto`, or `all`. It ssh's there, fast-forwards the backend's checkout, checks it is at the Mac's HEAD, then deploys. Commit first: uncommitted changes never reach a backend. The mini takes the commits from the Mac through its `mac` peer remote, so no push is needed. De Soto has no way in to the Mac and takes them from its origin, GitHub, so push before deploying there; without the push it stops with "origin does not have <commit>". `status` and `log` take a backend's name too. `all` runs every backend and exits with the worst code, and `--shells` and `--force` want one backend named, since each ends shells or work on the backend it is given.
- **After a deploy from the Mac** it asks each backend it left alone what it runs (`GET /api/about`) and prints a line for one on another commit, such as `redeploy: desoto runs d1db8db, not e0ea870; bun run redeploy desoto`. Deploy it too unless the user said to leave it.
- **In a canopy shell on a backend** (the `shells` container, which has no docker) it deploys the checkout that shell sees, which is the host's own `~/dev/dev-tools/canopy`. The script ssh's to the host with `~/.ssh/canopy_deploy`. That key's `authorized_keys` line runs `scripts/redeploy.sh --gate` and nothing else. Add `--pull` to take the Mac's `main` first: through the `mac` remote on the mini, from origin on De Soto.
- **On the backend's host** it deploys directly.

The compose run is detached on the host and logged under `~/.cache/canopy-deploy/`. A dropped ssh or a closed tab does not stop it halfway, and a second deploy is refused while one runs.

## Shells

A normal deploy recreates only the canopy container, and only when it changed. A deploy of the commit already running rebuilds to the same image and leaves the container up, so pass `--restart` to get a fresh one anyway. Every shell stays, including the one running the deploy, and browser tabs rejoin. When the deploy would also recreate the `shells` container (a change to the Dockerfile's `shells` stage or `lib/tmux*.conf`, a compose change to that service, a `.env` value it reads such as `GH_TOKEN`, or a base image bump), the script stops with exit 3 and names the cause: the environment names whose values moved, other settings, or the image. That recreate ends every shell. Only rerun with `--shells` once the user agrees. The kept-shells chip (a clock with a back arrow and a count) restores them afterwards.

## When it fails

- **Exit 4, "canopy has work going that recreating its container would cut off"**: the host asked canopy before the `up` and found a run working or waiting on a prompt, a coordinator between turns with a card queued or running, a flow working or waiting, a fleet working, or a landing entry rebasing, in setup, at its gate or landing. Each gets a line with its id, repo and what it is doing. Wait for them to finish and run the deploy again. Only rerun with `--force` once the user agrees to cut them off. `--force` does not stand in for `--shells`. The check is skipped when the deploy leaves the canopy container up (the same commit, no `--restart`), and a canopy that does not answer counts as nothing going.
- **"would not say what it has going"**, **"could not be read"** or **"no jq"**: canopy answered but the host could not read what it has going. The host asks `GET /api/going`, which answers a caller with no token; a canopy from before that route is asked through its four lists instead. Fix that (the mini host needs `curl` and `jq`), or rerun with `--force` once the user agrees.
- **"up failed; what holds 7850"**: another service took canopy's port. On 2026-09-25 it was tailchan, now on 7855. Move the other service, not canopy, since every device and the tunnel use 7850. Then run `docker compose up -d --force-recreate shells canopy` on the mini. A failed bind leaves the shells container running with no published ports, which a plain `up` does not fix.
- **"main here and the Mac's have both moved"** (or "and origin's" on De Soto): someone committed on the backend. Merge on one side, then deploy again.
- **"origin does not have <commit>; this host pulls from origin, so push first"**: De Soto only sees what is on GitHub. Push the Mac's `main`, then deploy again.
- **"no deploy key"** or **"no host to reach"** in a shell: run `scripts/redeploy-setup.sh` on the mini host. It makes the key and writes where a shell dials the host (`~/.ssh/canopy_deploy_host`), which a shell needs because the checkout's `.env` is a link it cannot follow. It is idempotent.
