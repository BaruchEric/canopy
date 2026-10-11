/**
 * Moving a shell's agent session. The source half: the plan, stopping a
 * stub agent in a real tmux shell, the snapshot, the transcript, the
 * clean-up and the undo. The target half: the check and the load, with a
 * clone standing in for the source machine. A perl `claude` stub reads lines until /exit, so
 * tmux sees an agent the way it sees the real one (by its script name).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { projectFolder } from "../core/sessions";
import { killServer, tmuxBase } from "../core/tmux";
import type { MoveCheck, MoveOut, MovePlan } from "../core/types";
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
/** a move's id, as the page mints one per try */
const mid = () => crypto.randomUUID().replaceAll("-", "");
const moveOut = (term: string, move: string) => post(`/api/terms/move/out?term=${term}&move=${move}`, { session: S, harness: "claude" });
const transcript = (term: string, move: string) => fetch(url(`/api/terms/move/transcript?term=${term}&session=${S}&move=${move}`));
const finish = (term: string, move?: string) => post(`/api/terms/move/finish?term=${term}${move ? `&move=${move}` : ""}`);
const undo = (term: string, move?: string) => post(`/api/terms/move/undo?term=${term}${move ? `&move=${move}` : ""}`);
/** waits for tmux to see `want` in a shell, and answers what it saw last */
const agentBecomes = async (term: string, want: string | null): Promise<string | null> => {
  let now = await agentIn(term);
  for (let i = 0; i < 50 && now !== want; i++) {
    await Bun.sleep(100);
    now = await agentIn(term);
  }
  return now;
};

/** which agent tmux sees in a shell */
const agentIn = async (term: string): Promise<string | null> =>
  ((await (await fetch(url(`/api/terms/agent?term=${term}`))).json()) as { agent: string | null }).agent;

/** a shell at the repo with the stub agent typed into it, once tmux shows
 *  it; `attach` joins a shell the server already holds */
async function shellWithAgent(term: string, attach = false): Promise<void> {
  const ws = new WebSocket(url(`/api/term?id=app&term=${term}&place=panel${attach ? "&attach=1" : ""}`).replace("http", "ws"));
  await new Promise((r) => ws.addEventListener("open", r));
  ws.send(new TextEncoder().encode("claude\n"));
  for (let i = 0; i < 100; i++) {
    if ((await agentIn(term)) === "claude") return ws.close();
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
  // a second repo, whose shells a load into app must not take the name of
  await mkdir(join(root, "lib"));
  await git(join(root, "lib"), "init", "-q", "-b", "main");
  await git(join(root, "lib"), "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "one");
  const dir = join(scratch, "claude", "projects", projectFolder(join(root, "app")));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${S}.jsonl`), `${JSON.stringify({ type: "user", cwd: join(root, "app"), message: { content: "fix the login" } })}\n`);
  process.env["CANOPY_PEERS_JSON"] = JSON.stringify({ self: "mac", peerSync: "on", seed: [], peers: [{ name: "mini", alias: null, root: join(scratch, "other"), role: "git" }] });
  // codex left out, so a target without the harness can be tested
  server = await startServer({ root, port: 0, harnesses: ["claude"] });
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

    const m = mid();
    const early = await transcript(TERM, m);
    expect(early.status).toBe(409);

    expect((await post(`/api/terms/move/out?term=${TERM}`, { session: S, harness: "claude" })).status).toBe(400);
    const out = (await (await moveOut(TERM, m)).json()) as MoveOut;
    expect(out.wip).toMatch(/^[0-9a-f]{40}$/);
    expect(out.move).toBe(m);
    const again = await moveOut(TERM, m);
    expect(again.status).toBe(409);

    const t = await transcript(TERM, m);
    expect(t.status).toBe(200);
    expect(await t.text()).toContain("fix the login");

    const fin = (await (await finish(TERM, m)).json()) as { reset: string };
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
    const m = mid();
    await moveOut(term, m);
    const back = await undo(term, m);
    expect(back.status).toBe(200);
    expect(await back.json()).toEqual({ ok: true, resumed: true });
    expect(await readFile(join(root, "app", "README.md"), "utf8")).toBe("three\n");
    // the resume line brought the agent back in that shell
    expect(await agentBecomes(term, "claude")).toBe("claude");
    // the move is forgotten: a new out is accepted again
    expect((await moveOut(term, mid())).status).toBe(200);
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

  test.if(tmux)("a second out while the first waits on the agent is refused", async () => {
    const term = TERM.replace("ab", "a1");
    await shellWithAgent(term);
    const a = mid();
    const b = mid();
    const first = moveOut(term, a);
    // the first is in hand once the stop has begun; the stop itself takes beats
    await Bun.sleep(100);
    const second = await moveOut(term, b);
    expect(second.status).toBe(409);
    expect(((await second.json()) as { error: string }).error).toMatch(/already moving/);
    // the second window's undo names its own move, not the first's
    expect((await undo(term, b)).status).toBe(409);
    // the first's undo while it still waits on the agent types nothing
    expect(await (await undo(term, a)).json()).toEqual({ ok: true, resumed: false });
    expect((await first).status).toBe(200);
    // only the move's own id reaches its transcript, finish and undo
    expect((await transcript(term, b)).status).toBe(409);
    expect((await finish(term, b)).status).toBe(409);
    expect((await undo(term, b)).status).toBe(409);
    expect((await undo(term)).status).toBe(409);
    expect(await (await undo(term, a)).json()).toEqual({ ok: true, resumed: true });
  });

  test.if(tmux)("a snapshot that fails holds transcript and finish, and undo still resumes", async () => {
    const term = TERM.replace("ab", "a2");
    const app = join(root, "app");
    await shellWithAgent(term);
    // a ref from an earlier snapshot is there, so a failed write would leave a stale one in place
    await writeFile(join(app, "README.md"), "stale\n");
    const early = mid();
    expect((await moveOut(term, early)).status).toBe(200);
    expect((await undo(term, early)).status).toBe(200);
    await agentBecomes(term, "claude");
    expect((await git(app, "rev-parse", "-q", "--verify", "refs/wip/main")).trim()).toMatch(/^[0-9a-f]{40}$/);
    await writeFile(join(app, "README.md"), `unsaved ${Date.now()}\n`);
    // git cannot write the new blob, so the snapshot fails
    const objects = join(app, ".git", "objects");
    await Bun.$`chmod -R a-w ${objects}`.quiet();
    const m = mid();
    let res: Response;
    try {
      res = await moveOut(term, m);
    } finally {
      await Bun.$`chmod -R u+w ${objects}`.quiet();
    }
    expect(res.status).toBe(500);
    expect(((await res.json()) as { error: string }).error).toMatch(/snapshot was not written/);
    const t = await transcript(term, m);
    expect(t.status).toBe(409);
    expect(((await t.json()) as { error: string }).error).toMatch(/not saved/);
    const fin = await finish(term, m);
    expect(fin.status).toBe(409);
    expect(((await fin.json()) as { error: string }).error).toMatch(/not saved/);
    const terms = (await (await fetch(url("/api/terms"))).json()) as { id: string }[];
    expect(terms.some((x) => x.id === term)).toBe(true);
    expect(await (await undo(term, m)).json()).toEqual({ ok: true, resumed: true });
    expect(await agentBecomes(term, "claude")).toBe("claude");
  });

  test.if(tmux)("an agent started again by hand holds finish; undo then types nothing and forgets the move", async () => {
    const term = TERM.replace("ab", "a3");
    await shellWithAgent(term);
    await writeFile(join(root, "app", "README.md"), "by hand\n");
    const m = mid();
    expect((await moveOut(term, m)).status).toBe(200);
    // someone starts the agent again by hand
    await shellWithAgent(term, true);
    const held = await finish(term, m);
    expect(held.status).toBe(409);
    expect(((await held.json()) as { error: string }).error).toMatch(/agent runs in that shell/);
    expect(await readFile(join(root, "app", "README.md"), "utf8")).toBe("by hand\n");
    expect(await agentIn(term)).toBe("claude");
    expect(await (await undo(term, m)).json()).toEqual({ ok: true, resumed: false });
    await Bun.sleep(400);
    const text = (await (await fetch(url(`/api/terms/text?term=${term}`))).json()) as { text: string | null };
    expect(text.text).not.toContain(S);
    // forgotten: finish has nothing to do
    expect((await finish(term, m)).status).toBe(409);
  });

  test.if(tmux)("ending the shell drops its move: the undo after finds nothing to resume", async () => {
    const term = TERM.replace("ab", "a4");
    await shellWithAgent(term);
    const m = mid();
    expect((await moveOut(term, m)).status).toBe(200);
    expect((await fetch(url(`/api/terms?term=${term}`), { method: "DELETE" })).status).toBe(200);
    // a record left behind would look the gone shell up, a 404
    const r = await undo(term, m);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resumed: false });
  });

  test.if(tmux)("a shell ended while out waits on the agent calls the move off", async () => {
    const term = TERM.replace("ab", "a5");
    await shellWithAgent(term);
    const pending = moveOut(term, mid());
    // inside the stop's first beat, before the agent has been asked to quit
    await Bun.sleep(100);
    expect((await fetch(url(`/api/terms?term=${term}`), { method: "DELETE" })).status).toBe(200);
    const r = await pending;
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/called off/);
  });

  test("undo with no move on record has nothing to resume", async () => {
    const r = await undo("9".repeat(32), mid());
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true, resumed: false });
  });

  test("an unknown shell is a 404", async () => {
    const r = await fetch(url("/api/terms/move/plan?term=00000000000000000000000000000000"));
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/no such shell/);
  });
});

describe("the target half of a move", () => {
  const SRC = "src";
  // not S: the source half left a different conversation under S at root/app
  const T = "0f5e2c1a-2222-4222-8333-444455556666";
  let other = "";
  let before: string | undefined;
  beforeAll(async () => {
    other = join(scratch, "other");
    await mkdir(other, { recursive: true });
    await Bun.$`git clone -q ${join(root, "app")} ${join(other, "app")}`.quiet();
    await git(join(other, "app"), "config", "user.email", "t@t");
    await git(join(other, "app"), "config", "user.name", "t");
    before = process.env["CANOPY_PEERS_JSON"];
    process.env["CANOPY_PEERS_JSON"] = JSON.stringify({ self: "mini", peerSync: "on", seed: [], peers: [{ name: SRC, alias: null, root: other, role: "git" }] });
  });
  afterAll(() => {
    if (before === undefined) delete process.env["CANOPY_PEERS_JSON"];
    else process.env["CANOPY_PEERS_JSON"] = before;
  });

  /** the source's half done by hand: a change, its snapshot, and its transcript */
  async function sourceOut(dirty: boolean): Promise<{ out: Omit<MoveOut, "move">; text: string }> {
    const src = join(other, "app");
    if (dirty) await writeFile(join(src, "moved.txt"), "carried\n");
    const { snapshotWip } = await import("../core/peersync");
    await snapshotWip(src, SRC, false);
    const wip = dirty ? (await git(src, "rev-parse", "refs/wip/main")).trim() : null;
    const head = (await git(src, "rev-parse", "HEAD")).trim();
    const text = `${JSON.stringify({ type: "user", cwd: src, message: { content: "carry on" } })}\n`;
    return { out: { session: T, harness: "claude", path: src, branch: "main", head, name: `${T}.jsonl`, wip }, text };
  }
  const check = (body: Record<string, unknown>) => post("/api/repos/movecheck?id=app", body);
  const load = (out: Omit<MoveOut, "move">, text: string, term: string) => {
    const form = new FormData();
    form.set("meta", JSON.stringify({ ...out, from: SRC, term, place: "panel", cols: 80, rows: 24 }));
    form.set("transcript", new Blob([text]), "t.jsonl");
    return fetch(url("/api/repos/movein?id=app"), { method: "POST", body: form });
  };

  test("check passes on a clean target at the same commit", async () => {
    await git(join(root, "app"), "checkout", "-q", "--", ".");
    await git(join(root, "app"), "clean", "-fdq");
    const { out } = await sourceOut(true);
    const r = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: T, harness: "claude" })).json()) as MoveCheck;
    expect(r).toMatchObject({ ok: true, path: join(root, "app"), existing: false });
  });

  test("check refuses a dirty target and another branch, by reason, changing nothing", async () => {
    const { out } = await sourceOut(true);
    await writeFile(join(root, "app", "local.txt"), "mine\n");
    const dirty = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: T, harness: "claude" })).json()) as MoveCheck;
    expect(dirty.ok).toBe(false);
    expect(dirty.reason).toMatch(/uncommitted/);
    await rm(join(root, "app", "local.txt"));
    await git(join(root, "app"), "checkout", "-qb", "side");
    try {
      const side = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: T, harness: "claude" })).json()) as MoveCheck;
      expect(side.ok).toBe(false);
      expect(side.reason).toMatch(/side.*main|main.*side/);
      expect((await git(join(root, "app"), "branch", "--show-current")).trim()).toBe("side");
    } finally {
      await git(join(root, "app"), "checkout", "-q", "main");
    }
  });

  test("check refuses when the peer's copy cannot be fetched (filed elsewhere, or offline)", async () => {
    const { out } = await sourceOut(true);
    const kept = process.env["CANOPY_PEERS_JSON"]!;
    process.env["CANOPY_PEERS_JSON"] = JSON.stringify({ self: "mini", peerSync: "on", seed: [], peers: [{ name: SRC, alias: null, root: join(scratch, "nowhere"), role: "git" }] });
    try {
      const r = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: T, harness: "claude" })).json()) as MoveCheck;
      expect(r.ok).toBe(false);
      expect(r.reason).toMatch(/could not be reached.*same folder on both machines/);
    } finally {
      process.env["CANOPY_PEERS_JSON"] = kept;
    }
  });

  test("check refuses a transcript over the cap", async () => {
    const r = await check({ from: SRC, branch: "main", head: "x", transcriptBytes: 64 * 1024 * 1024 + 1, session: T, harness: "claude" });
    expect(r.status).toBe(413);
  });

  test("check names an unknown peer", async () => {
    const r = await check({ from: "nobody", branch: "main", head: "x", transcriptBytes: 10, session: T, harness: "claude" });
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/no git peer named nobody/);
  });

  test.if(tmux)("load lands the work, writes the transcript under this repo's folder, and resumes", async () => {
    const { out, text } = await sourceOut(true);
    const term = "1234567890abcdef1234567890abcdef";
    const r = await load(out, text, term);
    expect(r.status).toBe(201);
    expect(await readFile(join(root, "app", "moved.txt"), "utf8")).toBe("carried\n");
    const file = join(scratch, "claude", "projects", projectFolder(join(root, "app")), `${T}.jsonl`);
    expect(JSON.parse((await readFile(file, "utf8")).trim()).cwd).toBe(join(root, "app"));
    // a retry after a lost answer finds the shell the first one started
    const again = await load(out, text, term);
    expect(again.status).toBe(201);
    expect(((await again.json()) as { id: string }).id).toBe(term);
    const terms = (await (await fetch(url("/api/terms"))).json()) as { id: string }[];
    expect(terms.filter((x) => x.id === term)).toHaveLength(1);
    const c = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: T, harness: "claude" })).json()) as MoveCheck;
    expect(c.existing).toBe(true);
    await git(join(root, "app"), "checkout", "-q", "--", ".");
    await git(join(root, "app"), "clean", "-fdq");
  });

  test.if(tmux)("a retry whose first try landed the work but started no shell skips the take", async () => {
    const { out, text } = await sourceOut(true);
    // the first try's take, by hand: the snapshot's tree is here exactly
    await writeFile(join(root, "app", "moved.txt"), "carried\n");
    // gone from the peer, so a take would fail: only the landed path answers 201
    await git(join(other, "app"), "update-ref", "-d", "refs/wip/main");
    try {
      const r = await load(out, text, "abab1234abab1234abab1234abab1234");
      expect(r.status).toBe(201);
    } finally {
      await git(join(root, "app"), "clean", "-fdq");
    }
  });

  test.if(tmux)("a clean source moves only the conversation", async () => {
    await rm(join(other, "app", "moved.txt"), { force: true });
    const { out, text } = await sourceOut(false);
    expect(out.wip).toBeNull();
    const r = await load(out, text, "5678567856785678567856785678abcd");
    expect(r.status).toBe(201);
    expect(await git(join(root, "app"), "status", "--porcelain")).toBe("");
  });

  test("load refuses a snapshot that is not the one the source named", async () => {
    const { out, text } = await sourceOut(true);
    const r = await load({ ...out, wip: "0".repeat(40) }, text, "9999999999999999999999999999abcd");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/snapshot is not the one/);
    expect(existsSync(join(root, "app", "moved.txt"))).toBe(false);
  });

  /** the target as it was: no work landed, nothing uncommitted */
  async function untouched(): Promise<void> {
    expect(existsSync(join(root, "app", "moved.txt"))).toBe(false);
    expect(await git(join(root, "app"), "status", "--porcelain")).toBe("");
  }

  test.if(tmux)("load refuses a shell name another repo's shell holds, before the work lands", async () => {
    const { out, text } = await sourceOut(true);
    const term = "4444444444444444444444444444abcd";
    const ws = new WebSocket(url(`/api/term?id=lib&term=${term}&place=panel`).replace("http", "ws"));
    await new Promise((r) => ws.addEventListener("open", r));
    for (let i = 0; i < 50; i++) {
      const terms = (await (await fetch(url("/api/terms"))).json()) as { id: string }[];
      if (terms.some((x) => x.id === term)) break;
      await Bun.sleep(100);
    }
    ws.close();
    const r = await load(out, text, term);
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/name is taken/);
    await untouched();
  });

  test.if(tmux)("two loads of one shell at once start it once and both answer with it", async () => {
    const { out, text } = await sourceOut(true);
    const term = "3333333333333333333333333333abcd";
    const [a, b] = await Promise.all([load(out, text, term), load(out, text, term)]);
    expect([a.status, b.status]).toEqual([201, 201]);
    expect(((await a.json()) as { id: string }).id).toBe(term);
    expect(((await b.json()) as { id: string }).id).toBe(term);
    const terms = (await (await fetch(url("/api/terms"))).json()) as { id: string }[];
    expect(terms.filter((x) => x.id === term)).toHaveLength(1);
    await git(join(root, "app"), "checkout", "-q", "--", ".");
    await git(join(root, "app"), "clean", "-fdq");
  });

  test("load refuses a cut-off transcript before the work lands", async () => {
    const { out } = await sourceOut(true);
    const r = await load(out, '{"type":"user","cwd":', "8888888888888888888888888888abcd");
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/not JSON/);
    await untouched();
  });

  test("load refuses a conversation this machine has a different copy of, before the work lands", async () => {
    const U = "0f5e2c1a-3333-4222-8333-444455556666";
    const dir = join(scratch, "claude", "projects", projectFolder(join(root, "app")));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${U}.jsonl`), `${JSON.stringify({ type: "user", cwd: join(root, "app"), message: { content: "split" } })}\n`);
    const { out, text } = await sourceOut(true);
    const r = await load({ ...out, session: U, name: `${U}.jsonl` }, text, "7777777777777777777777777777abcd");
    expect(r.status).toBe(409);
    expect(((await r.json()) as { error: string }).error).toMatch(/different copy/);
    await untouched();
  });

  test("a target without the harness: check says so, load refuses before the work lands", async () => {
    const { out, text } = await sourceOut(true);
    const c = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: T, harness: "codex" })).json()) as MoveCheck;
    expect(c.ok).toBe(false);
    expect(c.reason).toMatch(/codex/i);
    const r = await load({ ...out, harness: "codex" }, text, "6666666666666666666666666666abcd");
    expect(r.status).toBe(400);
    await untouched();
  });

  test("peer sync in dry mode: check says so, load refuses", async () => {
    const { out, text } = await sourceOut(true);
    const kept = process.env["CANOPY_PEERS_JSON"]!;
    process.env["CANOPY_PEERS_JSON"] = JSON.stringify({ self: "mini", peerSync: "dry", seed: [], peers: [{ name: SRC, alias: null, root: other, role: "git" }] });
    try {
      const c = (await (await check({ from: SRC, branch: "main", head: out.head, transcriptBytes: 10, session: T, harness: "claude" })).json()) as MoveCheck;
      expect(c).toMatchObject({ ok: false, reason: "peer sync is in dry mode; a move needs it on" });
      const r = await load(out, text, "5555555555555555555555555555abcd");
      expect(r.status).toBe(409);
      expect(((await r.json()) as { error: string }).error).toBe("peer sync is in dry mode; a move needs it on");
    } finally {
      process.env["CANOPY_PEERS_JSON"] = kept;
    }
    await untouched();
  });

  test("load refuses malformed meta", async () => {
    const form = new FormData();
    form.set("meta", "{not json");
    form.set("transcript", new Blob(["x"]), "t.jsonl");
    const r = await fetch(url("/api/repos/movein?id=app"), { method: "POST", body: form });
    expect(r.status).toBe(400);
  });
});
