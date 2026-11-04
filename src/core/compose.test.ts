import { describe, expect, test } from "bun:test";
import { composeCmdError, composeDownArgs, composeLsArgs, configInside, foreignVolumes, isComposeTask, parseComposeLs, projectName, volumeLsArgs } from "./compose";
import { normalizeTaskPatch } from "./tasks";

const ROOTS = { runs: "/c/worktrees", kept: "/c/trees" };

describe("a compose task", () => {
  test("is one by its flag, or by a cmd that starts with docker compose", () => {
    expect(isComposeTask({ cmd: "docker compose up" })).toBe(true);
    expect(isComposeTask({ cmd: "docker  compose up -d" })).toBe(true);
    expect(isComposeTask({ cmd: "docker compose" })).toBe(true);
    expect(isComposeTask({ cmd: "bun run dev" })).toBe(false);
    expect(isComposeTask({ cmd: "docker-compose up" })).toBe(false);
    expect(isComposeTask({ cmd: "docker composer" })).toBe(false);
    expect(isComposeTask({ cmd: "./up.sh", compose: true })).toBe(true);
    expect(isComposeTask({ cmd: "docker compose up", compose: false })).toBe(false);
  });

  test("the flag is read from a task file as true or false", () => {
    expect(normalizeTaskPatch({ name: "dev", compose: true })).toEqual({ name: "dev", compose: true });
    expect(normalizeTaskPatch({ name: "dev", compose: "yes" })).toBe("dev: compose is true or false");
  });

  test("a cmd that names its own project is refused, since the name is canopy's", () => {
    expect(composeCmdError("docker compose up -d")).toBeNull();
    expect(composeCmdError("docker compose --pull always up")).toBeNull();
    expect(composeCmdError("docker compose -f a.yml up")).toBeNull();
    for (const cmd of ["docker compose -p x up", "docker compose -px up", "docker compose --project-name x up", "docker compose --project-name=x up", "COMPOSE_PROJECT_NAME=x docker compose up"]) {
      expect(composeCmdError(cmd)).toContain("names its own compose project");
    }
  });
});

describe("a project name", () => {
  test("comes from the folder, and differs between a run's worktree and a kept one", () => {
    expect(projectName("/c/worktrees/app-1a2b3c4d/ab12cd34", ROOTS)).toBe("cw-app-1a2b3c4d-ab12cd34");
    expect(projectName("/c/trees/app-1a2b3c4d/ab12cd34", ROOTS)).toBe("ck-app-1a2b3c4d-ab12cd34");
  });

  test("uses only what compose allows, and two slugs stay two names", () => {
    expect(projectName("/c/trees/My.App-1a2b3c4d/feat-x", ROOTS)).toBe("ck-my--app-1a2b3c4d-feat-x");
    expect(projectName("/c/trees/app-1/a.b", ROOTS)).not.toBe(projectName("/c/trees/app-1/a-b", ROOTS));
  });

  test("is null anywhere else: a main checkout, the root, deeper, or a look-alike root", () => {
    for (const dir of ["/opt/stacks/canopy", "/dev/app", "/c/worktrees", "/c/worktrees/app-1", "/c/worktrees/app-1/ab/cd", "/c/worktrees-x/app-1/ab", "/c/worktrees/app-1/..", "/c/worktrees/../trees"]) {
      expect(projectName(dir, ROOTS)).toBeNull();
    }
  });
});

describe("the down command", () => {
  test("names only the folder's own project, keeps images, and takes volumes only when asked", () => {
    const dir = "/c/worktrees/app-1a2b3c4d/ab12cd34";
    expect(composeDownArgs(dir, ROOTS, true)).toEqual(["compose", "-p", "cw-app-1a2b3c4d-ab12cd34", "down", "-v"]);
    expect(composeDownArgs(dir, ROOTS, false)).toEqual(["compose", "-p", "cw-app-1a2b3c4d-ab12cd34", "down"]);
    expect(composeDownArgs(dir, ROOTS, true)?.join(" ")).not.toContain("--rmi");
  });

  test("refuses canopy's own stack and every folder canopy did not make", () => {
    for (const dir of ["/opt/stacks/canopy", "/home/eric/canopy", "canopy", "", "/"]) {
      expect(composeDownArgs(dir, ROOTS, true)).toBeNull();
      expect(composeDownArgs(dir, ROOTS, false)).toBeNull();
    }
  });
});

describe("reading docker's answers", () => {
  test("the project list matches exactly, since the filter is a substring", () => {
    const out = JSON.stringify([
      { Name: "cw-app-1-ab", Status: "running(1)", ConfigFiles: "/w/a.yml,/w/b.yml" },
      { Name: "cw-app-1-abc", Status: "running(1)", ConfigFiles: "/x/a.yml" },
    ]);
    expect(parseComposeLs(out, "cw-app-1-ab")).toEqual({ files: ["/w/a.yml", "/w/b.yml"] });
    expect(parseComposeLs(out, "cw-app-1")).toBeNull();
    expect(parseComposeLs("[]", "x")).toBeNull();
    expect(parseComposeLs("", "x")).toBeNull();
    expect(parseComposeLs("not json", "x")).toBe("unreadable");
  });

  test("a project's files are inside when each sits under the folder, by any of its names", () => {
    expect(configInside(["/private/w/a/x.yml"], ["/w/a", "/private/w/a"])).toBe(true);
    expect(configInside(["/w/a/x.yml", "/w/a/sub/y.yml"], ["/w/a"])).toBe(true);
    expect(configInside(["/w/a/x.yml", "/opt/stacks/canopy/docker-compose.yml"], ["/w/a"])).toBe(false);
    expect(configInside(["/w/ab/x.yml"], ["/w/a"])).toBe(false);
    expect(configInside([], ["/w/a"])).toBe(false);
  });

  test("a volume not named after the project is one a file named outright", () => {
    expect(foreignVolumes("cw-a_data\ncw-a_cache\n", "cw-a")).toEqual([]);
    expect(foreignVolumes("cw-a_data\nshared\n\n", "cw-a")).toEqual(["shared"]);
  });

  test("the reads ask for the project by name", () => {
    expect(composeLsArgs("cw-a")).toEqual(["compose", "ls", "-a", "--format", "json", "--filter", "name=cw-a"]);
    expect(volumeLsArgs("cw-a")).toEqual(["volume", "ls", "--filter", "label=com.docker.compose.project=cw-a", "--format", "{{.Name}}"]);
  });
});
