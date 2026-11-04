# Worktree stacks, plan 3: a compose stack per worktree (FR-039)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Status:** implemented on branch `fr-039-plans-2-3`, not yet merged.

**Goal:** a repo whose dev task is `docker compose up` gets one stack per worktree, on ports of its own, torn down with the worktree. Two branches run side by side, and nothing canopy runs can reach a stack it did not make.

**Architecture:** a task is a compose task when `compose` says so or its `cmd` starts with `docker compose`. In a worktree, `core/compose.ts` derives the project name from the folder, and the task runs with `COMPOSE_PROJECT_NAME` set. `server/stacks.ts` tears a stack down through an injected exec: it checks what the project is, then runs `down`. The real exec exists only in `server/index.ts`; tests use a fake.

**Tech Stack:** Bun, TypeScript strict, bun:test. No new dependencies.

**Spec:** `docs/superpowers/specs/2026-10-25-worktree-stacks-design.md`, "A compose stack per worktree". Plan 2 is `2026-11-03-worktree-stacks-2.md`.

## Probe P3, run 2026-11-03

On the Mac: Docker Desktop server 29.9.2, compose 5.6.1, busybox:1.36, project names `fr039p3-*`, a throwaway compose file in a scratch folder. Everything it made is gone; nothing else was touched.

| Question | Answer |
| --- | --- |
| Do two stacks from one file coexist with `-p` and env ports? | Yes. Both answer on their own ports. |
| What does a port collision do? | `up -d` exits 1 with "Bind for 127.0.0.1:7944 failed: port is already allocated", and leaves a created container (`ls -a` says `created(1)`). Teardown has to run after a failed up too. |
| Does `down -v` need the file? | No. `docker compose -p X down -v` from `/` with no file and no env exits 0, working by labels, and leaves other stacks alone. A project with nothing left exits 0 with a warning. |
| What if the file is there and an env var is unset? | With `${PORT:?need}` the command exits 1 on interpolation. So teardown runs from `/`, by name alone. |
| Is a fixed-name volume safe? | No. `volumes: {x: {name: shared}}`: a volume that existed before, unlabelled, survives `down -v`. One the project created carries its label and is deleted, even when another stack's file names it too. The first teardown can delete another stack's data. |
| Which project name wins? | `-p`, then shell `COMPOSE_PROJECT_NAME`, then `.env`, then the file's `name:`. |
| How do I read a project and its volumes? | `docker compose ls -a --format json --filter name=X` gives `[{Name, Status, ConfigFiles}]`; the filter is a substring, so match exactly. `docker volume ls --filter label=com.docker.compose.project=X --format '{{.Name}}'` gives names. |

## What changed from the spec, and why

| Spec | This plan | Why |
| --- | --- | --- |
| canopy adds `-p <repo key>-<branch id>` to the command | the task runs with `COMPOSE_PROJECT_NAME` set; a `cmd` that names its own project is refused | A `cmd` is a shell line, so `-p` would need parsing it (`cd x && docker compose up`, a wrapper script). P3 shows the env var beats `.env` and `name:`. Teardown does use `-p`. |
| `<repo key>-<branch id>` | `cw-<repo key>-<id>` for a run's worktree, `ck-<repo key>-<slug>` for a kept one | A kept tree's slug can equal a run's id, and the two must not share a project. The prefix also means no name canopy makes can be a stack it did not. |
| `down -v` on land, drop and sweep | the same, after two checks; a stopped task gets `down` without `-v` | P3's fixed-name finding. A project whose files sit outside the worktree is refused, and a project holding a volume not prefixed `<name>_` keeps its volumes and says which. By-hand stop leaves data, since the branch is still going. |
| refused when `repoKey` equals the deploy's | refused when the repo's name or `package.json` name is `canopy`, or its key is this server's own checkout | Covers worktrees and kept trees of canopy on any machine, at start and at teardown. |
| `--port` per stack only | kept-tree cards too | FR-051 shipped after the spec. A kept tree's card holds its tree's port as `${PORT}`, as plan 2 did. |

## Global constraints

- Tests use a fake exec, never a real `docker compose`. A hub test's task sets `compose: true` on a harmless `cmd`, so tmux has no docker to run.
- The project name is derived from the folder at each use. It is never read from a record, a request or a file.
- `composeDownArgs` takes the folder, not a name, and answers null for a folder outside the two roots.
- Never `--rmi`. Teardown runs from `/` with `COMPOSE_DOWN_MS` (60 s).
- A main checkout's compose task keeps working as it does now: no project, no implicit port, never `down`.

## Tasks

- [ ] **Task 1: `core/compose.ts`.** `isComposeTask`, `composeCmdError`, `projectName`, `composeDownArgs`, `composeLsArgs`, `volumeLsArgs`, `parseComposeLs`, `configInside`, `foreignVolumes`. `TaskDef.compose`, normalized as a flag. Tests first.
- [ ] **Task 2: `server/stacks.ts`.** `tearDown` over an injected exec, `realCompose`, `isCanopyStack`. Tests with a fake exec: the order of calls, each refusal, `-v` dropped, failures reported.
- [ ] **Task 3: the hub.** `TaskRecord.stack`; `launch` sets `COMPOSE_PROJECT_NAME`, adds the implicit `PORT`, and refuses docker missing, a named project, and canopy's own stack; ports stay held while an `up -d` stack is up, which also reads as running; `stopTask` runs `down`; `endOne` runs `down -v`; `endGone` covers a kept tree's folder. Tests with a real tmux and a fake compose.
- [ ] **Task 4: wiring.** `server/index.ts` passes `realCompose` and `isCanopyStack`.
- [ ] **Task 5: docs.** architecture, README, the spec's Calls, the plans index.

## Live check, 2026-11-03

A scratch canopy on :7877 with its own config folder, a stand-in `claude`, and a throwaway repo whose compose file publishes `127.0.0.1:${PORT:?need}:8080` and has one named volume. Docker Desktop 29.9.2. The only project names it touched were the two canopy generated, `cw-app-dc75f523-*`.

- Two branches ran side by side on :7942 and :7929, and both answered.
- `/api/ports` showed both under their branches, from `com.docker.backend`.
- Dropping one took its stack and its volume, and left the other's alone.
- `canopy worktrees stop` on the other removed its containers and kept its volume. Starting again came back on the same port.
- Dropping that one took its stack and volume. `docker ps -a` and `docker volume ls` held nothing with the prefix afterwards.

Not tried live: the fixed-name volume path and the outside-files refusal. Fake-exec tests cover both, and P3 is the evidence for the first.

## Review focus

- Can anything reach `down` with a name canopy did not generate for that folder?
- A failed `up` leaves a container: does teardown still run?
- The mini: its containers have no docker CLI, so compose tasks are refused there.
