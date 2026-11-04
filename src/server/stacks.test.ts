/**
 * Tearing down a worktree's stack. Everything here runs against a fake exec:
 * no test may reach a real `docker compose`, because `down -v` deletes
 * volumes.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OWN_STACK } from "../core/compose";
import type { ComposeExec } from "./stacks";
import { isCanopyStack, tearDown } from "./stacks";

const ROOTS = { runs: "/c/worktrees", kept: "/c/trees" };
const DIR = "/c/worktrees/app-1a2b3c4d/ab12cd34";
const NAME = "cw-app-1a2b3c4d-ab12cd34";

/** docker's answers by the command's front; records every call */
function fake(answers: { ls?: string; lsCode?: number; volumes?: string; volumesCode?: number; down?: { code: number; out: string } } = {}) {
  const calls: string[][] = [];
  const cwds: string[] = [];
  const exec: ComposeExec = {
    run: async (args, opts) => {
      calls.push(args);
      cwds.push(opts.cwd);
      if (args[0] === "volume") return { code: answers.volumesCode ?? 0, out: answers.volumes ?? "" };
      if (args[1] === "ls") return { code: answers.lsCode ?? 0, out: answers.ls ?? "[]" };
      return answers.down ?? { code: 0, out: "" };
    },
  };
  return { exec, calls, cwds, downs: () => calls.filter((c) => c.includes("down")) };
}

const listed = (files: string) => JSON.stringify([{ Name: NAME, Status: "running(1)", ConfigFiles: files }]);

describe("tearing a stack down", () => {
  test("looks at the project and its volumes, then downs it with its volumes, from the root folder", async () => {
    const f = fake({ ls: listed(`${DIR}/compose.yml`), volumes: `${NAME}_data\n` });
    const lines = await tearDown(f.exec, DIR, ROOTS, { volumes: true, folders: [DIR] });
    expect(f.calls.map((c) => c.slice(0, 2).join(" "))).toEqual(["compose ls", "volume ls", `compose -p`]);
    expect(f.downs()).toEqual([["compose", "-p", NAME, "down", "-v"]]);
    expect(new Set(f.cwds)).toEqual(new Set(["/"]));
    expect(lines).toEqual([`removed compose stack ${NAME} and its volumes`]);
  });

  test("a stop by hand leaves the volumes and asks about none", async () => {
    const f = fake({ ls: listed(`${DIR}/compose.yml`) });
    expect(await tearDown(f.exec, DIR, ROOTS, { volumes: false, folders: [DIR] })).toEqual([`stopped compose stack ${NAME}`]);
    expect(f.downs()).toEqual([["compose", "-p", NAME, "down"]]);
    expect(f.calls.some((c) => c[0] === "volume")).toBe(false);
  });

  test("never touches a folder canopy did not make, canopy's own stack among them", async () => {
    for (const dir of ["/opt/stacks/canopy", "/dev/dev-tools/canopy", "canopy", "/"]) {
      const f = fake();
      const lines = await tearDown(f.exec, dir, ROOTS, { volumes: true, folders: [dir] });
      expect(f.calls).toEqual([]);
      expect(lines[0]).toContain("refused");
    }
  });

  test("refuses a project whose files sit outside the worktree, and runs no down", async () => {
    const f = fake({ ls: listed("/opt/stacks/canopy/docker-compose.yml") });
    const lines = await tearDown(f.exec, DIR, ROOTS, { volumes: true, folders: [DIR] });
    expect(f.downs()).toEqual([]);
    expect(lines.join(" ")).toContain("/opt/stacks/canopy/docker-compose.yml");
    expect(lines.join(" ")).toContain("refused");
  });

  test("a project with no containers left still goes, for what a failed up left in volumes", async () => {
    const f = fake({ ls: "[]", volumes: `${NAME}_data\n` });
    await tearDown(f.exec, DIR, ROOTS, { volumes: true, folders: [DIR] });
    expect(f.downs()).toEqual([["compose", "-p", NAME, "down", "-v"]]);
  });

  test("keeps every volume when one has a fixed name, and says which", async () => {
    const f = fake({ ls: listed(`${DIR}/compose.yml`), volumes: `${NAME}_data\nshared-db\n` });
    const lines = await tearDown(f.exec, DIR, ROOTS, { volumes: true, folders: [DIR] });
    expect(f.downs()).toEqual([["compose", "-p", NAME, "down"]]);
    expect(lines.join(" ")).toContain("shared-db");
    expect(lines.join(" ")).toContain("kept");
  });

  test("keeps the volumes when they cannot be read", async () => {
    const f = fake({ ls: listed(`${DIR}/compose.yml`), volumesCode: 1 });
    await tearDown(f.exec, DIR, ROOTS, { volumes: true, folders: [DIR] });
    expect(f.downs()).toEqual([["compose", "-p", NAME, "down"]]);
  });

  test("runs no down when the project cannot be read", async () => {
    for (const a of [{ lsCode: 1 }, { ls: "not json" }]) {
      const f = fake(a);
      const lines = await tearDown(f.exec, DIR, ROOTS, { volumes: true, folders: [DIR] });
      expect(f.downs()).toEqual([]);
      expect(lines.join(" ")).toContain(`docker compose -p ${NAME} down`);
    }
  });

  test("reports a failed down with the command to finish it", async () => {
    const f = fake({ ls: listed(`${DIR}/compose.yml`), down: { code: 1, out: "Resource is still in use" } });
    const lines = await tearDown(f.exec, DIR, ROOTS, { volumes: true, folders: [DIR] });
    expect(lines.join(" ")).toContain("Resource is still in use");
    expect(lines.join(" ")).toContain(`docker compose -p ${NAME} down`);
  });

  test("a thrown exec is a report too, never an error for the caller", async () => {
    const exec: ComposeExec = { run: async () => { throw new Error("spawn failed"); } };
    expect((await tearDown(exec, DIR, ROOTS, { volumes: true, folders: [DIR] })).join(" ")).toContain("spawn failed");
  });
});

describe("canopy's own stack", () => {
  let scratch = "";
  beforeAll(async () => {
    scratch = await mkdtemp(join(tmpdir(), "canopy-compose-"));
    await mkdir(join(scratch, "mine"));
    await writeFile(join(scratch, "mine", "package.json"), JSON.stringify({ name: "canopy" }));
    await mkdir(join(scratch, "other"));
    await writeFile(join(scratch, "other", "package.json"), JSON.stringify({ name: "app" }));
    await mkdir(join(scratch, "bare"));
  });
  afterAll(() => rm(scratch, { recursive: true, force: true }));

  test("is known by its repo's name, its package name, or this server's own checkout", async () => {
    const self = "/srv/checkout";
    expect(await isCanopyStack({ name: "canopy", path: join(scratch, "bare") }, self)).toBe(true);
    expect(await isCanopyStack({ name: "fr-039", path: join(scratch, "mine") }, self)).toBe(true);
    expect(await isCanopyStack({ name: "checkout", path: self }, self)).toBe(true);
    expect(await isCanopyStack({ name: "app", path: join(scratch, "other") }, self)).toBe(false);
    expect(await isCanopyStack({ name: "bare", path: join(scratch, "bare") }, self)).toBe(false);
  });

  test("a repo beside the checkout is not canopy, whatever folder they share", async () => {
    const self = join(scratch, "mine");
    expect(await isCanopyStack({ name: "other", path: join(scratch, "other") }, self)).toBe(false);
    expect(await isCanopyStack({ name: "bare", path: join(scratch, "bare") }, join(scratch, "dev-tools", "canopy"))).toBe(false);
  });

  test("the refusal says redeploy is the way", () => {
    expect(OWN_STACK).toBe("canopy's own stack is deployed by redeploy, not run as a task");
  });
});
