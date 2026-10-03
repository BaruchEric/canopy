# canopy as a headless backend: the server, the git scan, the tmux shells,
# and the claude runner, with no desktop. The desktop openers and the
# launcher are macOS commands, so they are hidden here (the server refuses
# them and the UI drops them); the in-browser core is the whole point. See
# docs/prd-shared-backend.md and docs/deploy.md.
#
# Three images come out of this file. `shells` is everything a shell needs
# (git, tmux, claude, codex, the user, the PATH) and no canopy code: the
# tmux server runs in a container of its own off it (the `shells` service in
# docker-compose.yml), so a canopy redeploy, which recreates the canopy
# container, leaves every shell running. The final stage adds the built
# canopy on top. A change above the `shells` line changes that image too and
# its container is recreated, which drops the shells; a change to canopy
# alone does not. `stages` is the shells image without gh or the Vercel CLI,
# plus the bundled stage runner: where the incubator's agents run, with no
# token (the `stages` service).

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
# the incubator's stage runner as one file, the only canopy code the stages
# image carries
RUN bun build src/stage/main.ts --target=bun --outfile /app/dist/stage-runner.js
# the fence check (docs/deploy.md, "Stages"), run inside the stages container
RUN bun build src/stage/fencecheck.ts --target=bun --outfile /app/dist/fence-check.js

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

# gh for the pull request counts and the release and pull listings, which the
# server reads through `gh api`, and for the shells, where it is git's
# credential helper for github.com (GH_TOKEN and GIT_CONFIG_* in
# docker-compose.yml, on both services) so a push works from the panel and
# from a shell alike. GitHub's own apt repo, since Debian's gh predates
# `gh api --slurp`.
RUN mkdir -p -m 755 /etc/apt/keyrings \
    && curl -fsSL https://cli.github.com/packages/githubcli-archive-keyring.gpg \
       -o /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && chmod go+r /etc/apt/keyrings/githubcli-archive-keyring.gpg \
    && echo "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" \
       > /etc/apt/sources.list.d/github-cli.list \
    && apt-get update && apt-get install -y --no-install-recommends gh \
    && rm -rf /var/lib/apt/lists/*

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

# The Vercel CLI, for the incubator's deploy. canopy runs it itself, with
# VERCEL_TOKEN in that one process's env; no agent's allowlist names it.
# Pinned, so a CLI release cannot change what a deploy does unseen.
RUN bun add -g vercel@61.1.0 || echo "vercel not installed at build; the incubator parks before a deploy"

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

# The incubator's stages: the shells' runtime, user, claude, codex, bun and
# git, without gh or the Vercel CLI, and the stage runner. No canopy server
# code, no token. compose runs this as the `stages` service, and canopy
# reaches it only through the runner's socket on the stage-sock volume.
#
# Every stage runs as the same user, so nothing a later stage runs may be a
# file that user can write: claude and codex move out of its home into
# root-owned /opt/stage-tools, the PATH names root-owned folders only, the
# runner and its bundle are root's, and the build fails below if any of that
# is not so. The stage runner checks it again at every spawn.
FROM shells AS stages
USER root
# gh is GitHub's apt package (above); the binary is all a stage could use
RUN rm -f /usr/bin/gh
# the socket's folder, made here so the fresh named volume copies up owned by
# the runner's user and it can bind the socket
RUN mkdir -p /run/canopy-stage && chown bun:bun /run/canopy-stage
# a login shell (claude's Bash tool starts one) would put the home's own,
# writable bin folders back on the PATH
RUN rm -f /etc/profile.d/canopy-path.sh
USER bun
# the Vercel CLI went in with `bun add -g` (above), which links `vercel` and
# `vc`; it may be missing if that install failed, so nothing here insists
RUN (bun remove -g vercel || true) \
    && rm -f /home/bun/.bun/bin/vercel /home/bun/.bun/bin/vc \
    && rm -rf /home/bun/.bun/install/global/node_modules/vercel
USER root
# claude is one native file, copied off its version link; codex is its npm
# package with the platform binary beside it, so the global node_modules
# moves whole and the link points at the same file inside it. codex may be
# missing if its install failed (above); claude may not.
RUN set -e; \
    mkdir -p /opt/stage-tools/bin; \
    cp -L /home/bun/.local/bin/claude /opt/stage-tools/bin/claude; \
    if [ -e /home/bun/.bun/bin/codex ]; then \
      js=$(readlink -f /home/bun/.bun/bin/codex); \
      cp -a /home/bun/.bun/install/global/node_modules /opt/stage-tools/node_modules; \
      ln -s "/opt/stage-tools/node_modules/${js#/home/bun/.bun/install/global/node_modules/}" /opt/stage-tools/bin/codex; \
    fi; \
    rm -rf /home/bun/.local/bin/claude /home/bun/.local/share/claude /home/bun/.bun/bin /home/bun/.bun/install/global; \
    chown -R root:root /opt/stage-tools; \
    chmod -R u+rwX,go+rX,go-w /opt/stage-tools
COPY --from=build /app/dist/stage-runner.js /app/stage-runner.js
COPY --from=build /app/dist/fence-check.js /app/fence-check.js
RUN chown -R root:root /app && chmod -R go-w /app
USER bun
ENV PATH=/opt/stage-tools/bin:/usr/local/bin:/usr/bin:/bin
# claude's own updater would write a new claude somewhere the user can
ENV DISABLE_AUTOUPDATER=1
ENV CLAUDE_CONFIG_DIR=/home/bun/.stage-claude CODEX_HOME=/home/bun/.stage-codex
# the build fails here rather than ship a stage image that has gh or the
# Vercel CLI, a PATH folder (or one above it) the runner's user can write,
# or a stage tool or runner file it can change
RUN ! command -v gh && ! command -v vercel && ! command -v vc
RUN set -e; \
    for d in $(echo "$PATH" | tr : ' '); do \
      p="$d"; \
      while :; do \
        if [ -w "$p" ]; then echo "$p is writable by $(id -un), and the PATH reaches it"; exit 1; fi; \
        [ "$p" = / ] && break; \
        p=$(dirname "$p"); \
      done; \
    done; \
    w=$(find /opt/stage-tools /app -writable -print -quit); \
    if [ -n "$w" ]; then echo "$w is writable by $(id -un)"; exit 1; fi; \
    test "$(command -v claude)" = /opt/stage-tools/bin/claude; \
    if command -v codex; then test "$(command -v codex)" = /opt/stage-tools/bin/codex; fi
# CMD, not ENTRYPOINT: the shells stage's tmux CMD would otherwise be appended
# to the runner's argv
CMD ["bun", "/app/stage-runner.js"]

FROM shells
# gh comes from the shells stage above, so the server and the shells run the
# same one
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
