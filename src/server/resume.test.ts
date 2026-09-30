/**
 * Picking an agent conversation back up in a shell: the routes that list a
 * repo's conversations off a scratch `CLAUDE_CONFIG_DIR` and `CODEX_HOME`
 * and start a shell with `claude --resume` or `codex resume` typed into it,
 * against a real server on a scratch root. `claude` and `codex` are stubs
 * that print their arguments, put first on the PATH by a `$SHELL` that is a
 * plain, non-login `sh`, so nothing here starts the real ones.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { selfName } from "../core/backends";
import { codexDayDirs, projectFolder } from "../core/sessions";
import { killServer, tmuxBase } from "../core/tmux";
import type { AgentSession, Repo, TermInfo } from "../core/types";
import { startServer } from "./index";

const SESSION = "0f5e2c1a-1111-4222-8333-444455556666";
const TERM = "fedcba9876543210fedcba9876543210";
const CODEX = "01a0938a-afea-7710-9c30-f6d510a9d23e";
const TERM2 = "fedcba9876543210fedcba9876543211";

let scratch: string;
let server: { port: number; stop: () => void };
const saved: Record<string, string | undefined> = {};
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-resume-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CLAUDE_CONFIG_DIR", "CODEX_HOME", "SHELL"]) saved[k] = process.env[k];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  process.env["CLAUDE_CONFIG_DIR"] = join(scratch, "claude");
  process.env["CODEX_HOME"] = join(scratch, "codex");
  const bin = join(scratch, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "claude"), '#!/bin/sh\necho "stub-claude $*"\n');
  await chmod(join(bin, "claude"), 0o755);
  await writeFile(join(bin, "codex"), '#!/bin/sh\necho "stub-codex $*"\n');
  await chmod(join(bin, "codex"), 0o755);
  // the shell canopy starts as `$SHELL -l -i`: this one drops the -l and
  // puts the stub first itself, since neither a tmux session nor a Bun
  // child sees what this process set in its environment after it started
  await writeFile(join(bin, "shell"), `#!/bin/sh\nPATH=${bin}:$PATH exec /bin/sh -i\n`);
  await chmod(join(bin, "shell"), 0o755);
  process.env["SHELL"] = join(bin, "shell");
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({ root, port: 0, harnesses: ["claude", "codex"] });
  const tree = (await (await fetch(url("/api/tree"))).json()) as { repos: Repo[] };
  const app = tree.repos.find((r) => r.id === "app")!;
  const dir = join(scratch, "claude", "projects", projectFolder(app.path));
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${SESSION}.jsonl`), JSON.stringify({ type: "user", message: { role: "user", content: "tidy the scan" } }));
  // a codex rollout filed under today, in the repo's folder
  const day = join(scratch, "codex", "sessions", codexDayDirs(new Date(), 1)[0]!);
  await mkdir(day, { recursive: true });
  await writeFile(
    join(day, `rollout-2026-09-30T10-00-00-${CODEX}.jsonl`),
    [
      JSON.stringify({ type: "session_meta", payload: { id: CODEX, cwd: app.path, source: "cli", cli_version: "0.158.0" } }),
      JSON.stringify({ type: "event_msg", payload: { type: "user_message", message: "review the diff" } }),
    ].join("\n") + "\n",
  );
});

afterAll(async () => {
  server.stop();
  const base = tmuxBase();
  if (base) await killServer(base);
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("resuming a conversation", () => {
  test("a repo lists the conversations started in it, both harnesses', newest first", async () => {
    const list = (await (await fetch(url("/api/repos/resumable?id=app"))).json()) as AgentSession[];
    expect(list.map((s) => [s.harness, s.id, s.prompt]).sort()).toEqual([
      ["claude", SESSION, "tidy the scan"],
      ["codex", CODEX, "review the diff"],
    ]);
  });

  test("a bad name or an unknown conversation is refused", async () => {
    const post = (body: unknown) => fetch(url("/api/repos/resume?id=app"), { method: "POST", body: JSON.stringify(body) });
    expect((await post({ term: "t1", session: SESSION })).status).toBe(400);
    expect((await post({ term: TERM, session: "x; rm -rf /" })).status).toBe(400);
    expect((await post({ term: TERM, session: "12345678-0000-4000-8000-000000000000" })).status).toBe(404);
    // a claude id is not a codex conversation, and the other way round
    expect((await post({ term: TERM, session: SESSION, harness: "codex" })).status).toBe(404);
    expect((await post({ term: TERM, session: CODEX })).status).toBe(404);
    expect((await post({ term: TERM, session: CODEX, harness: "gemini" })).status).toBe(400);
  });

  test("starts a held shell under the browser's name with claude --resume typed in", async () => {
    const res = await fetch(url("/api/repos/resume?id=app"), {
      method: "POST",
      body: JSON.stringify({ term: TERM, place: "strip", session: SESSION, cols: 100, rows: 30 }),
    });
    expect(res.status).toBe(201);
    const info = (await res.json()) as TermInfo;
    expect(info.id).toBe(TERM);
    const held = (await (await fetch(url("/api/terms"))).json()) as TermInfo[];
    expect(held.map((t) => t.id)).toContain(TERM);

    // the same name again is taken
    const again = await fetch(url("/api/repos/resume?id=app"), { method: "POST", body: JSON.stringify({ term: TERM, session: SESSION }) });
    expect(again.status).toBe(409);

    // a socket joining it sees the line that was typed
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?id=app&term=${TERM}&attach=1&cols=100&rows=30`);
    ws.binaryType = "arraybuffer";
    let out = "";
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== "string") out += new TextDecoder().decode(new Uint8Array(e.data));
    };
    // the stub's own line, not the echo of what was typed
    const typed = `stub-claude --dangerously-skip-permissions --resume ${SESSION}`;
    const start = Date.now();
    while (!out.includes(typed) && Date.now() - start < 15_000) await Bun.sleep(50);
    ws.close();
    expect(out).toContain(typed);
    await fetch(url(`/api/terms?term=${TERM}`), { method: "DELETE" });
  }, 20_000);

  test("a codex conversation resumes with codex resume, its flags and --no-daemon", async () => {
    const res = await fetch(url("/api/repos/resume?id=app"), {
      method: "POST",
      body: JSON.stringify({ term: TERM2, place: "strip", session: CODEX, harness: "codex", cols: 100, rows: 30 }),
    });
    expect(res.status).toBe(201);
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/term?id=app&term=${TERM2}&attach=1&cols=100&rows=30`);
    ws.binaryType = "arraybuffer";
    let out = "";
    ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
      if (typeof e.data !== "string") out += new TextDecoder().decode(new Uint8Array(e.data));
    };
    // codex keeps its commands' environment to what policy sets, so where
    // the shell runs rides as its -c flags
    const env = Object.entries({
      CANOPY_TERM: TERM2,
      CANOPY_BACKEND: selfName(null, hostname()),
      CANOPY_REPO: "app",
      CANOPY_API: `http://127.0.0.1:${server.port}`,
    })
      .map(([k, v]) => `-c shell_environment_policy.set.${k}="${v}"`)
      .join(" ");
    const typed = `stub-codex resume --dangerously-bypass-approvals-and-sandbox --no-daemon ${env} ${CODEX}`;
    const start = Date.now();
    while (!out.includes(typed) && Date.now() - start < 15_000) await Bun.sleep(50);
    ws.close();
    expect(out).toContain(typed);
    await fetch(url(`/api/terms?term=${TERM2}`), { method: "DELETE" });
  }, 20_000);
});
