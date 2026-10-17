/**
 * The changes section's drill route: a branch or worktree the repo's own
 * status named, and nothing a page makes up.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ElsewhereDetail } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
let saved: string | undefined;
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const drill = (q: Record<string, string>) => fetch(url(`/api/repos/elsewhere?${new URLSearchParams({ id: "app", ...q }).toString()}`));

beforeAll(async () => {
  // real, since git names a worktree by its resolved path (/private/var on a Mac)
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canopy-elsewhere-srv-")));
  saved = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const app = join(scratch, "root", "app");
  const git = (...args: string[]) => Bun.$`git -C ${app} -c user.name=t -c user.email=t@t ${args}`.quiet();
  await Bun.$`mkdir -p ${app} && git -C ${app} init -q -b main`.quiet();
  await writeFile(join(app, "f.txt"), "one\n");
  await git("add", "f.txt");
  await git("commit", "-q", "-m", "one");
  await git("checkout", "-q", "-b", "idea");
  await writeFile(join(app, "g.txt"), "idea\n");
  await git("add", "g.txt");
  await git("commit", "-q", "-m", "an idea");
  await git("checkout", "-q", "main");
  // a linked worktree with an edit to a tracked file
  await git("worktree", "add", "-q", "-b", "agent", join(scratch, "wt"));
  await writeFile(join(scratch, "wt", "f.txt"), "one\ntwo\n");
  server = await startServer({ root: join(scratch, "root"), port: 0 });
});

afterAll(async () => {
  server.stop();
  if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = saved;
  await rm(scratch, { recursive: true, force: true });
});

describe("the elsewhere drill", () => {
  test("a branch the status names gives its commits HEAD lacks", async () => {
    const res = await drill({ branch: "idea" });
    expect(res.status).toBe(200);
    const d = (await res.json()) as ElsewhereDetail;
    expect(d.commits.map((c) => c.subject)).toEqual(["an idea"]);
    expect(d).toMatchObject({ more: 0, files: [] });
  });

  test("a worktree the status names gives its entries, and a diff of each", async () => {
    const d = (await (await drill({ worktree: join(scratch, "wt") })).json()) as ElsewhereDetail;
    expect(d.files.map((f) => f.path)).toEqual(["f.txt"]);
    const res = await fetch(url(`/api/repos/diff?${new URLSearchParams({ id: "app", file: "f.txt", staged: "0", untracked: "0", worktree: join(scratch, "wt") }).toString()}`));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { diff: string }).diff).toContain("+two");
    const stray = await fetch(url(`/api/repos/diff?${new URLSearchParams({ id: "app", file: "f.txt", worktree: "/etc" }).toString()}`));
    expect(stray.status).toBe(404);
  });

  test("refuses a branch, worktree or option the status never named", async () => {
    expect((await drill({ branch: "main" })).status).toBe(404);
    expect((await drill({ branch: "--output=/tmp/x" })).status).toBe(404);
    expect((await drill({ worktree: "/etc" })).status).toBe(404);
    expect((await drill({})).status).toBe(400);
  });
});
