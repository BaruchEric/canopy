# canopy as a headless backend: the server, the git scan, the tmux shells,
# and the claude runner, with no desktop. The desktop openers and the
# launcher are macOS commands, so they are hidden here (the server refuses
# them and the UI drops them); the in-browser core is the whole point. See
# docs/prd-shared-backend.md and docs/deploy.md.
#
# Two images come out of this file. `shells` is everything a shell needs
# (git, tmux, claude, codex, the user, the PATH) and no canopy code: the
# tmux server runs in a container of its own off it (the `shells` service in
# docker-compose.yml), so a canopy redeploy, which recreates the canopy
# container, leaves every shell running. The final stage adds the built
# canopy on top. A change above the `shells` line changes that image too and
# its container is recreated, which drops the shells; a change to canopy
# alone does not.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun run build

FROM oven/bun:1 AS shells
# git for the scan and every mutation; tmux so a shell outlives a canopy
# restart; python3 for the bundled Library; openssh for ssh sources and for
# VS Code Remote-SSH from a client; curl to fetch the claude installer;
# nodejs because the codex npm wrapper's launcher runs on node (bun does not
# satisfy its `#!/usr/bin/env node` shebang).
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux python3 openssh-client ca-certificates curl nodejs \
    && rm -rf /var/lib/apt/lists/*

# The server, the shells and claude all run as the image's `bun` user, remapped
# to the host user's uid and gid (build args, 1000 by default) so the mounted
# tree, ~/.claude and ~/.codex are its own files. Root would be simpler but
# claude refuses to run with permissions bypassed as root, which is what
# every canopy run does.
ARG UID=1000
ARG GID=1000
RUN if [ "$(id -u bun)" != "$UID" ] || [ "$(id -g bun)" != "$GID" ]; then \
      groupmod -g "$GID" bun && usermod -u "$UID" -g "$GID" bun \
      && chown -R bun:bun /home/bun; fi

# a repo owned by another uid (a host user the build args did not name) would
# otherwise be "dubious ownership" and refuse every git command
RUN git config --system --add safe.directory '*'

# a login shell (the in-browser terminal) must find claude and codex too
RUN printf 'export PATH="$HOME/.local/bin:$HOME/.bun/bin:$PATH"\n' > /etc/profile.d/canopy-path.sh

# Durable config and the tmux socket live on a mounted volume so config
# survives a container rebuild; made here so the fresh volume takes this
# ownership.
RUN mkdir -p /config && chown bun:bun /config

USER bun
ENV HOME=/home/bun
# the shell the in-browser terminal runs: bash is what the image has, and a
# container sets no SHELL of its own
ENV SHELL=/bin/bash
ENV PATH="/home/bun/.local/bin:/home/bun/.bun/bin:${PATH}"
# the image points global installs at /usr/local/bin, which the bun user
# cannot write; keep them under its own home, where PATH already looks
ENV BUN_INSTALL_BIN=/home/bun/.bun/bin

# Claude Code, Anthropic's official native install (subscription login, no
# API key; the login itself is a mounted ~/.claude, see deploy.md).
RUN curl -fsSL https://claude.ai/install.sh | bash

# Codex CLI, run inside a shell on your Codex subscription. If this package
# name is wrong for your setup, install it your own way (see deploy.md); it
# is not required for canopy to start.
RUN bun add -g @openai/codex || echo "codex not installed at build; see docs/deploy.md"

# the tmux server's config, at the path canopy's own tmux client names;
# tmux-server.conf sources it and keeps the server up with no session
WORKDIR /app
COPY --chown=bun:bun lib/tmux.conf lib/tmux-server.conf /app/lib/
ENV CANOPY_CONFIG_DIR=/config

# the tmux server in the foreground on the config volume's socket; compose
# runs this as the `shells` service and canopy's tmux client, in the other
# container, joins it there
CMD ["tmux", "-S", "/config/tmux.sock", "-f", "/app/lib/tmux-server.conf", "-D"]

FROM shells
COPY --from=build --chown=bun:bun /app /app

ENV NODE_ENV=production
EXPOSE 7850

# compose overrides this with the real scan root; the path here is only a
# default for `docker run` without compose.
CMD ["bun", "bin/canopy.ts", "ui", "/work/dev", "--port", "7850", "--no-open"]
