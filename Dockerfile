# canopy as a headless backend: the server, the git scan, the tmux shells,
# and the claude runner, with no desktop. The desktop openers and the
# launcher are macOS commands, so they are hidden here (the server refuses
# them and the UI drops them); the in-browser core is the whole point. See
# docs/prd-shared-backend.md and docs/deploy.md.

FROM oven/bun:1 AS build
WORKDIR /app
COPY package.json bun.lock* ./
RUN bun install --frozen-lockfile || bun install
COPY . .
RUN bun run build

FROM oven/bun:1
# git for the scan and every mutation; tmux so a shell outlives a canopy
# restart; python3 for the bundled Library; openssh for ssh sources and for
# VS Code Remote-SSH from a client; curl to fetch the claude installer.
RUN apt-get update && apt-get install -y --no-install-recommends \
      git tmux python3 openssh-client ca-certificates curl \
    && rm -rf /var/lib/apt/lists/*

# Claude Code, Anthropic's official native install (subscription login, no
# API key; the login itself is a mounted ~/.claude, see deploy.md).
RUN curl -fsSL https://claude.ai/install.sh | bash
ENV PATH="/root/.local/bin:/root/.bun/bin:${PATH}"

# Codex CLI, run inside a shell on your Codex subscription. If this package
# name is wrong for your setup, install it your own way (see deploy.md); it
# is not required for canopy to start.
RUN bun add -g @openai/codex || echo "codex not installed at build; see docs/deploy.md"

WORKDIR /app
COPY --from=build /app /app

# Durable config and the tmux socket live on a mounted volume so config
# survives a container rebuild.
ENV CANOPY_CONFIG_DIR=/config
ENV NODE_ENV=production
EXPOSE 7850

# compose overrides this with the real scan root; the path here is only a
# default for `docker run` without compose.
CMD ["bun", "bin/canopy.ts", "ui", "/work/dev", "--port", "7850", "--no-open"]
