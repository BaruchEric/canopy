/**
 * Moving a shell's agent session, the source half: the plan, stopping a
 * stub agent in a real tmux shell, the snapshot, the transcript, the
 * clean-up and the undo. A perl `claude` stub reads lines until /exit, so
 * tmux sees an agent the way it sees the real one (by its script name).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFolder } from "../core/sessions";
import { killServer, tmuxBase } from "../core/tmux";
import type { MoveOut, MovePlan } from "../core/types";
import { startServer } from "./index";

const S = "0f5e2c1a-1111-4222-8333-444455556666";
const TERM = "abcdef0123456789abcdef0123456789";
const tmux = Bun.which("tmux") !== null;
let scratch = "";
let root = "";
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const git = (cwd: string, ...args: string[]) => Bun.$`git -C ${cwd} ${args}`.quiet().text();
const post = (p: string, body: unknown = {}) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });

/** a shell at the repo with the stub agent typed into it, once tmux shows it */
async function shellWithAgent(term: string): Promise<void> {
  const ws = new WebSocket(url(`/api/term?id=app&term=${term}&place=panel`).replace("http", "ws"));
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(new TextEncoder().encode("claude\n"));
  for (let i = 0; i < 100; i++) {
    const r = (await (await fetch(url(`/api/terms/agent?term=${term}`))).json()) as { agent: string | null };
    if (r.agent === "claude") return ws.close();
    await Bun.sleep(100);
  }
  throw new Error("the stub agent never showed");
}

beforeAll(async () => {
  // real, since the server files a repo under its real path (/private/var on macOS)
  scratch = await realpath(await mkdtemp(join(tmpdir(), "canopy-move-srv-")));
  for (const k of ["CANOPY_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "SHELL"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CLAUDE_CONFIG_DIR"] = join(scratch, "claude");
  process.env["CODEX_HOME"] = join(scratch, "codex");
  const bin = join(scratch, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), "#!/usr/bin/env perl\nwhile (my $l = <STDIN>) { exit 0 if $l =~ m{/exit\\s*$}; }\n");
  await chmod(join(bin, "claude"), 0o755);
  // the shell canopy starts as `$SHELL -l -i`: this one drops the -l and
  // puts the stub first itself, since neither a tmux session nor a Bun
  // child sees what this process set in its environment after it started
  await writeFile(join(bin, "shell"), `#!/bin/sh\nPATH=${bin}:$PATH exec /bin/sh -i\n`);
  await chmod(join(bin, "shell"), 0o755);
  process.env["SHELL"] = join(bin, "shell");
  root = join(scratch, "root");
  await mkdir(join(root, "app"), { recursive: true });
  await git(join(root, "app"), "init", "-q", "-b", "main");
  await writeFile(join(root, "app", "README.md"), "one\n");
  await git(join(root, "app"), "add", "-A");
  await git(join(root, "app"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "one");
  const dir = join(scratch, "claude", "projects", projectFolder(join(root, "app")));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${S}.jsonl`), `${JSON.stringify({ type: "user", cwd: join(root, "app"), message: { content: "fix the login" } })}\n`);
  process.env["CANOPY_PEERS_JSON"] = JSON.stringify({ self: "mac", peerSync: "on", seed: [], peers: [{ name: "mini", alias: null, root: join(scratch, "other"), role: "git" }] });
  server = await startServer({ root, port: 0 });
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  delete process.env["CANOPY_PEERS_JSON"];
  for (const [k, v] of Object.entries(saved)) if (v === undefined) delete process.env[k]; else process.env[k] = v;
  await rm(scratch, { recursive: true, force: true });
});

describe("the source half of a move", () => {
  test.if(tmux)("plan, out, transcript, finish", async () => {
    await shellWithAgent(TERM);
    await writeFile(join(root, "app", "README.md"), "two\n");
    await writeFile(join(root, "app", "new.txt"), "new\n");
    const plan = (await (await fetch(url(`/api/terms/move/plan?term=${TERM}&session=${S}&harness=claude`))).json()) as MovePlan;
    expect(plan).toMatchObject({ session: S, harness: "claude", branch: "main", changed: 2, prompt: "fix the login" });
    expect(plan.files.sort()).toEqual(["README.md", "new.txt"]);

    const early = await fetch(url(`/api/terms/move/transcript?term=${TERM}&session=${S}`));
    expect(early.status).toBe(409);

    const out = (await (await post(`/api/terms/move/out?term=${TERM}`, { session: S, harness: "claude" })).json()) as MoveOut;
    expect(out.wip).toMatch(/^[0-9a-f]{40}$/);
    const again = await post(`/api/terms/move/out?term=${TERM}`, { session: S, harness: "claude" });
    expect(again.status).toBe(409);

    const t = await fetch(url(`/api/terms/move/transcript?term=${TERM}&session=${S}`));
    expect(t.status).toBe(200);
    expect(await t.text()).toContain("fix the login");

    const fin = (await (await post(`/api/terms/move/finish?term=${TERM}`)).json()) as { reset: string };
    expect(fin.reset).toBe("reset");
    expect(await git(join(root, "app"), "status", "--porcelain")).toBe("");
    expect((await git(join(root, "app"), "rev-parse", `refs/canopy-moved/${S}`)).trim()).toBe(out.wip!);
    const terms = (await (await fetch(url("/api/terms"))).json()) as { id: string }[];
    expect(terms.some((x) => x.id === TERM)).toBe(false);
  });

  test.if(tmux)("undo types the resume line back into the same shell and keeps the tree", async () => {
    const term = TERM.replace("ab", "cd");
    await shellWithAgent(term);
    await writeFile(join(root, "app", "README.md"), "three\n");
    await post(`/api/terms/move/out?term=${term}`, { session: S, harness: "claude" });
    const undo = await post(`/api/terms/move/undo?term=${term}`);
    expect(undo.status).toBe(200);
    expect(await undo.json()).toEqual({ ok: true, resumed: true });
    expect(await readFile(join(root, "app", "README.md"), "utf8")).toBe("three\n");
    // the resume line brought the agent back in that shell
    let back: string | null = null;
    for (let i = 0; i < 50 && back !== "claude"; i++) {
      await Bun.sleep(100);
      back = ((await (await fetch(url(`/api/terms/agent?term=${term}`))).json()) as { agent: string | null }).agent;
    }
    expect(back).toBe("claude");
    // the move is forgotten: a new out is accepted again
    expect((await post(`/api/terms/move/out?term=${term}`, { session: S, harness: "claude" })).status).toBe(200);
  });

  test.if(tmux)("a detached HEAD is refused at plan, before anything stops", async () => {
    const term = TERM.replace("ab", "ef");
    await shellWithAgent(term);
    const head = (await git(join(root, "app"), "rev-parse", "HEAD")).trim();
    await git(join(root, "app"), "checkout", "-q", "--detach", head);
    try {
      const r = await fetch(url(`/api/terms/move/plan?term=${term}&session=${S}&harness=claude`));
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toMatch(/branch/);
      const agent = (await (await fetch(url(`/api/terms/agent?term=${term}`))).json()) as { agent: string };
      expect(agent.agent).toBe("claude");
    } finally {
      await git(join(root, "app"), "checkout", "-q", "main");
    }
  });

  test("undo with no move on record has nothing to resume", async () => {
    const r = await post(`/api/terms/move/undo?term=${"9".repeat(32)}`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resumed: false });
  });

  test("an unknown shell is a 404", async () => {
    expect((await fetch(url("/api/terms/move/plan?term=00000000000000000000000000000000"))).status).toBe(404);
  });
});
