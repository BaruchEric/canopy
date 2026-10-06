/**
 * The agent routing routes: the whole routing on GET, profiles, roles and a
 * repo's override written through their own routes (normalized, and
 * refused where a role cannot run a harness), each change broadcast as
 * an `agents` event, and one repo's effective table. A body of plain
 * settings, what a page from before roles sends, still lands as the repo's
 * whole-repo pick, and leaves its per-role picks alone.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/store";
import { DEFAULT_AGENT, type AgentActivity, type AgentRoutes, type AgentTable, type Repo, type ServerEvent } from "../core/types";
import { startServer } from "./index";

let scratch: string;
let server: { port: number; stop: () => void };
let saved: string | undefined;
let appPath = "";
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;
const post = (p: string, body: unknown) => fetch(url(p), { method: "POST", body: JSON.stringify(body) });
const routes = async () => (await (await fetch(url("/api/agents"))).json()) as AgentRoutes;

const deep = { harness: "claude", model: "opus", effort: "max", yolo: true, extra: "" } as const;
const review = { harness: "codex", model: "gpt-5.5", effort: "high", yolo: false, extra: "" } as const;

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-agents-"));
  saved = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  const root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  server = await startServer({ root, port: 0, harnesses: ["claude"] });
  const tree = (await (await fetch(url("/api/tree"))).json()) as { repos: Repo[]; backend: { harnesses?: string[] } };
  appPath = tree.repos.find((r) => r.id === "app")!.path;
});

afterAll(async () => {
  server.stop();
  if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = saved;
  await rm(scratch, { recursive: true, force: true });
});

/** the next `agents` event on a fresh event stream, once `act` has run */
async function agentsEvent(act: () => Promise<unknown>): Promise<AgentRoutes> {
  const ctl = new AbortController();
  const res = await fetch(url("/api/events"), { signal: ctl.signal });
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  // the stream is open once its first bytes arrive
  let buf = dec.decode((await reader.read()).value);
  await act();
  try {
    for (;;) {
      for (const chunk of buf.split("\n\n")) {
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const ev = JSON.parse(data.slice(6)) as ServerEvent;
        if (ev.type === "agents") return ev.agents;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the stream ended");
      buf += dec.decode(value);
    }
  } finally {
    ctl.abort();
  }
}

describe("the agent routes", () => {
  test("a fresh backend: the default profile, no roles, no overrides; the caps name its harnesses", async () => {
    expect(await routes()).toEqual({ profiles: { default: DEFAULT_AGENT }, roles: {}, repos: {} });
    const tree = (await (await fetch(url("/api/tree"))).json()) as { backend: { harnesses?: string[] } };
    expect(tree.backend.harnesses).toEqual(["claude"]);
  });

  test("a profile is written normalized, broadcast whole, and deleted with null", async () => {
    expect((await post("/api/agents/profile", { name: "Deep One", settings: deep })).status).toBe(400);
    expect((await post("/api/agents/profile", { name: "deep", settings: "opus" })).status).toBe(400);
    const heard = await agentsEvent(() => post("/api/agents/profile", { name: "deep", settings: { ...deep, extra: "  " } }));
    expect(heard.profiles["deep"]).toEqual(deep);
    const res = await post("/api/agents/profile", { name: "review", settings: { ...review, model: "--evil" } });
    expect(((await res.json()) as AgentRoutes).profiles["review"]).toEqual({ ...review, model: "default" });
    await post("/api/agents/profile", { name: "review", settings: review });
    expect(Object.keys((await routes()).profiles).sort()).toEqual(["deep", "default", "review"]);
  });

  test("a role points at a profile or settings, codex among them", async () => {
    expect((await post("/api/agents/role", { role: "nope", pick: { profile: "deep" } })).status).toBe(400);
    expect((await post("/api/agents/role", { role: "chat", pick: { profile: "Bad!" } })).status).toBe(400);
    expect((await post("/api/agents/role", { role: "chat", pick: review })).status).toBe(200);
    expect((await routes()).roles).toEqual({ chat: review });
    expect((await post("/api/agents/role", { role: "chat", pick: { profile: "deep" } })).status).toBe(200);
    expect((await post("/api/agents/role", { role: "shell", pick: review })).status).toBe(200);
    expect((await routes()).roles).toEqual({ chat: { profile: "deep" }, shell: review });
    await post("/api/agents/role", { role: "shell", pick: null });
    expect((await routes()).roles).toEqual({ chat: { profile: "deep" } });
  });

  test("a repo's override: the new shape, a legacy body, and its reset", async () => {
    const job = await post("/api/repos/agent?id=app", { roles: { job: review } });
    expect(job.status).toBe(200);
    expect(((await job.json()) as AgentRoutes).repos[appPath]).toEqual({ roles: { job: review } });
    let r = (await (await post("/api/repos/agent?id=app", { all: { profile: "review" }, roles: { job: { profile: "deep" } } })).json()) as AgentRoutes;
    expect(r.repos[appPath]).toEqual({ all: { profile: "review" }, roles: { job: { profile: "deep" } } });
    // a page from before roles sends plain settings: the whole-repo pick,
    // with the per-role picks it knows nothing of kept
    r = (await (await post("/api/repos/agent?id=app", { model: "sonnet", effort: "low", yolo: false, extra: "" })).json()) as AgentRoutes;
    expect(r.repos[appPath]).toEqual({ all: { ...DEFAULT_AGENT, model: "sonnet", effort: "low", yolo: false }, roles: { job: { profile: "deep" } } });
    // and the builtin defaults were its reset of that pick alone
    r = (await (await post("/api/repos/agent?id=app", DEFAULT_AGENT)).json()) as AgentRoutes;
    expect(r.repos[appPath]).toEqual({ roles: { job: { profile: "deep" } } });
    // with nothing else there, the reset takes the entry with it
    await post("/api/repos/agent?id=app", {});
    await post("/api/repos/agent?id=app", { model: "sonnet", effort: "low", yolo: false, extra: "" });
    r = (await (await post("/api/repos/agent?id=app", DEFAULT_AGENT)).json()) as AgentRoutes;
    expect(r.repos[appPath]).toBeUndefined();
    expect((await loadConfig()).agents[appPath]).toBeUndefined();
    expect((await post("/api/repos/agent?id=nope", {})).status).toBe(404);
  });

  test("the effective table says each role's settings and where they came from", async () => {
    await post("/api/repos/agent?id=app", { all: { profile: "review" } });
    const t = (await (await fetch(url("/api/agents/resolve?id=app"))).json()) as AgentTable;
    expect(t.harnesses).toEqual(["claude"]);
    expect(t.roles.shell).toEqual({ settings: review, from: "repo", profile: "review" });
    // the repo beats the role, codex or not
    expect(t.roles.chat).toEqual({ settings: review, from: "repo", profile: "review" });
    expect(t.roles.job).toEqual({ settings: review, from: "repo", profile: "review" });
    await post("/api/repos/agent?id=app", { roles: { job: { profile: "deep" } } });
    const u = (await (await fetch(url("/api/agents/resolve?id=app"))).json()) as AgentTable;
    expect(u.roles.job).toEqual({ settings: deep, from: "repo-role", profile: "deep" });
    expect(u.roles.flow).toMatchObject({ settings: DEFAULT_AGENT, from: "default" });
    expect((await fetch(url("/api/agents/resolve?id=nope"))).status).toBe(404);
    await post("/api/repos/agent?id=app", {});
  });
});

describe("a registry card's activity", () => {
  test("is read from its transcript on this machine by harness and session id", async () => {
    const session = "0d0d0d0d-1111-4222-8333-444444444444";
    const home = join(scratch, "claude-home");
    const dir = join(home, "projects", "-dev-app");
    await Bun.$`mkdir -p ${dir}`.quiet();
    const rec = (content: string) => JSON.stringify({ type: "user", timestamp: "2026-10-06T10:00:00.000Z", message: { role: "user", content } });
    await Bun.write(join(dir, `${session}.jsonl`), `${rec("tidy the readme")}\n`);
    const was = process.env["CLAUDE_CONFIG_DIR"];
    process.env["CLAUDE_CONFIG_DIR"] = home;
    try {
      const res = await fetch(url(`/api/agents/activity?harness=claude&session=${session}&cwd=/dev/app`));
      expect(res.status).toBe(200);
      const a = (await res.json()) as AgentActivity;
      expect(a).toMatchObject({ harness: "claude", session, prompts: 1, firstPrompt: "tidy the readme" });
      expect((await fetch(url("/api/agents/activity?harness=claude&session=0d0d0d0d-1111-4222-8333-555555555555"))).status).toBe(404);
      expect((await fetch(url(`/api/agents/activity?harness=gemini&session=${session}`))).status).toBe(400);
      expect((await fetch(url("/api/agents/activity?harness=claude&session=../../etc/passwd"))).status).toBe(400);
    } finally {
      if (was === undefined) delete process.env["CLAUDE_CONFIG_DIR"];
      else process.env["CLAUDE_CONFIG_DIR"] = was;
    }
  });
});
