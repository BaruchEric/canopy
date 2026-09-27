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
# the commit the image is built from, which .dockerignore keeps .git out of;
# scripts/redeploy.sh passes it through compose. Here it stamps the UI bundle.
ARG CANOPY_COMMIT=""
ARG CANOPY_COMMITTED=""
RUN CANOPY_COMMIT="$CANOPY_COMMIT" CANOPY_COMMITTED="$CANOPY_COMMITTED" bun run build

FROM oven/bun:1 AS shells
# git for the scan and every mutation; tmux so a shell outlives a canopy
# restart; python3 for the bundled Library; openssh for ssh sources and for
# VS Code Remote-SSH from a client; curl to fetch the claude installer;
# nodejs because the codex npm wrapper's launcher runs on node (bun does not
# satisfy its `#!/usr/bin/env node` shebang). The rest is for the shell a
# person types in: bash-completion; gawk, procps and xz-utils for ble.sh
# (inline suggestions and highlighting, which refuses to load without `ps`);
# jq for the Claude Code status line script.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux python3 openssh-client ca-certificates curl nodejs \
      bash-completion gawk procps xz-utils jq \
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
# ble.sh warns on every shell without a UTF-8 locale; C.UTF-8 needs no package
ENV LANG=C.UTF-8

# Claude Code, Anthropic's official native install (subscription login, no
# API key; the login itself is a mounted ~/.claude, see deploy.md).
RUN curl -fsSL https://claude.ai/install.sh | bash

# Codex CLI, run inside a shell on your Codex subscription. If this package
# name is wrong for your setup, install it your own way (see deploy.md); it
# is not required for canopy to start.
RUN bun add -g @openai/codex || echo "codex not installed at build; see docs/deploy.md"

# ble.sh from its nightly tarball, which runs in place (its --install step
# fails under Debian's bash 5.2). ~/.bashrc then sources shell/bashrc off the
# mounted ~/.claude when the host keeps one there (the dotclaude layout: the
# prompt, aliases and completion the host's own shells use), and changes
# nothing when it does not.
RUN mkdir -p /home/bun/.local/share \
    && curl -fsSL https://github.com/akinomyoga/ble.sh/releases/download/nightly/ble-nightly.tar.xz \
       | tar xJf - -C /home/bun/.local/share \
    && mv /home/bun/.local/share/ble-nightly /home/bun/.local/share/blesh \
    && printf '\n[ -r ~/.claude/shell/bashrc ] && . ~/.claude/shell/bashrc\n' >> /home/bun/.bashrc

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
# gh for the pull request counts and the release and pull listings, which the
# server reads through `gh api`. It goes in this stage, not `shells`, so adding
# it does not recreate the shells container. GitHub's own apt repo, since
# Debian's gh predates `gh api --slurp`. The login is GH_TOKEN from compose,
# which also makes gh git's credential helper for github.com (GIT_CONFIG_* in
# docker-compose.yml), so a push from the panel works here.
USER root
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*
USER bun

COPY --from=build --chown=bun:bun /app /app

# and here the server's /api/about; declared after everything slow, since a
# new value misses the cache from this line on
ARG CANOPY_COMMIT=""
ARG CANOPY_COMMITTED=""
ENV CANOPY_COMMIT=$CANOPY_COMMIT CANOPY_COMMITTED=$CANOPY_COMMITTED

ENV NODE_ENV=production
EXPOSE 7850

# compose overrides this with the real scan root; the path here is only a
# default for `docker run` without compose.
CMD ["bun", "bin/canopy.ts", "ui", "/work/dev", "--port", "7850", "--no-open"]
