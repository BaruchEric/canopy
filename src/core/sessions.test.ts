import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  claudeSessions,
  codexDayDirs,
  codexSessions,
  hasClaudeSession,
  hasCodexSession,
  isSessionId,
  parseCodexHead,
  parseCodexMeta,
  parseSessionHead,
  projectFolder,
  resumeLine,
} from "./sessions";
import { DEFAULT_AGENT } from "./types";

const A = "0f5e2c1a-1111-4222-8333-444455556666";
const B = "9a8b7c6d-aaaa-4bbb-8ccc-ddddeeeeffff";
const C = "12345678-0000-4000-8000-000000000000";

const line = (v: unknown) => JSON.stringify(v);

describe("which conversations a repo has", () => {
  test("a folder is filed under its path with every non-alphanumeric as a dash", () => {
    expect(projectFolder("/Users/eric/dev/my_app.v2")).toBe("-Users-eric-dev-my-app-v2");
  });

  test("a session id is a lowercase uuid, nothing else", () => {
    expect(isSessionId(A)).toBe(true);
    expect(isSessionId(A.toUpperCase())).toBe(false);
    expect(isSessionId("../etc/passwd")).toBe(false);
    expect(isSessionId(`${A} ; rm -rf /`)).toBe(false);
  });

  test("the head gives the first typed prompt, skipping commands, meta and tool results", () => {
    const text = [
      line({ type: "summary", summary: "Fix the flaky scan", leafUuid: "x" }),
      line({ type: "user", isMeta: true, message: { role: "user", content: "Caveat: the messages below…" } }),
      line({ type: "user", message: { role: "user", content: "<command-name>/clear</command-name>" } }),
      line({ type: "user", gitBranch: "main", message: { role: "user", content: [{ type: "text", text: "  why is the\n scan slow?  " }] } }),
      line({ type: "user", message: { role: "user", content: "second" } }),
      '{"type":"assistant","cut mid-rec',
    ].join("\n");
    expect(parseSessionHead(text)).toEqual({ prompt: "why is the scan slow?", summary: "Fix the flaky scan", branch: "main" });
  });

  test("a tool result is not a prompt, and a long prompt is clipped", () => {
    const long = "x".repeat(400);
    const text = [
      line({ type: "user", message: { role: "user", content: [{ type: "tool_result", content: "ok" }] } }),
      line({ type: "user", message: { role: "user", content: long } }),
    ].join("\n");
    const head = parseSessionHead(text);
    expect(head.prompt?.length).toBe(160);
    expect(head.prompt?.endsWith("…")).toBe(true);
    expect(head.summary).toBeNull();
  });

  test("the resume line carries the repo's flags and the id last", () => {
    expect(resumeLine(A, DEFAULT_AGENT)).toContain(`--resume ${A}`);
    expect(resumeLine(A, { ...DEFAULT_AGENT, model: "opus" })).toMatch(/^claude .*--model opus.*--resume /);
  });

  test("codex resumes through its subcommand, the id last", () => {
    expect(resumeLine(A, { ...DEFAULT_AGENT, harness: "codex", model: "gpt-5.5" })).toBe(
      `codex resume -m gpt-5.5 --dangerously-bypass-approvals-and-sandbox --no-daemon ${A}`,
    );
  });
});

describe("reading them off disk", () => {
  let home: string;
  const repo = "/srv/dev/app";

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "canopy-claude-"));
    const dir = join(home, "projects", projectFolder(repo));
    await mkdir(dir, { recursive: true });
    const user = (text: string) => line({ type: "user", message: { role: "user", content: text } });
    await writeFile(join(dir, `${A}.jsonl`), user("older one"));
    await writeFile(join(dir, `${B}.jsonl`), user("newer one"));
    // opened and quit: nothing typed, nothing to resume
    await writeFile(join(dir, `${C}.jsonl`), line({ type: "system" }));
    await writeFile(join(dir, "notes.jsonl"), user("not a session"));
    await utimes(join(dir, `${A}.jsonl`), new Date(1_000_000), new Date(1_000_000));
    await utimes(join(dir, `${B}.jsonl`), new Date(2_000_000), new Date(2_000_000));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("newest first, the empty and the misnamed left out", async () => {
    const list = await claudeSessions(repo, 20, home);
    expect(list.map((s) => [s.harness, s.id, s.prompt])).toEqual([
      ["claude", B, "newer one"],
      ["claude", A, "older one"],
    ]);
    expect(list[0]?.at).toBe(2_000_000);
  });

  test("the limit takes the newest", async () => {
    expect((await claudeSessions(repo, 1, home)).map((s) => s.id)).toEqual([B]);
  });

  test("a folder Claude never ran in has none", async () => {
    expect(await claudeSessions("/nowhere", 20, home)).toEqual([]);
  });

  test("a session belongs to the repo it was started in", async () => {
    expect(await hasClaudeSession(repo, A, home)).toBe(true);
    expect(await hasClaudeSession("/srv/dev/other", A, home)).toBe(false);
    expect(await hasClaudeSession(repo, "../../x", home)).toBe(false);
  });
});

/* ---------- codex ---------- */

const X = "01a0938a-afea-7710-9c30-f6d510a9d23e";
const Y = "01a0939c-5183-7e53-9449-e35b72645d29";
const Z = "01a0939c-5185-7dc0-aa1b-1e2472587235";
const SUB = "01a0939c-518a-79b0-a27d-f424b7577e49";
const OLD = "01a0939c-518f-7a83-ae7b-636505b61f4f";

/** a rollout's first line, the way codex 0.158 writes it (base
 *  instructions and all, which is what makes it long) */
const meta = (id: string, cwd: string, source: unknown = "cli", git?: unknown) =>
  line({
    timestamp: "2026-09-27T00:20:37.125Z",
    type: "session_meta",
    payload: { id, session_id: id, timestamp: "2026-09-27T00:20:04.910Z", cwd, originator: "codex-tui", cli_version: "0.158.0", source, base_instructions: { text: "x".repeat(20_000) }, ...(git ? { git } : {}) },
  });
const envItem = (cwd: string) =>
  line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text: `<environment_context>\n  <cwd>${cwd}</cwd>\n</environment_context>` }] } });
const typedItem = (text: string) => line({ type: "response_item", payload: { type: "message", role: "user", content: [{ type: "input_text", text }] } });
const userMsg = (text: string) => line({ type: "event_msg", payload: { type: "user_message", message: text } });

describe("a codex rollout's head", () => {
  test("the first line names the session, its folder and its branch; a subagent's is no session to offer", () => {
    expect(parseCodexMeta(meta(X, "/srv/dev/app", "cli", { branch: "main", commit_hash: "abc" }))).toEqual({
      id: X,
      cwd: "/srv/dev/app",
      source: "cli",
      branch: "main",
    });
    expect(parseCodexMeta(meta(X, "/srv/dev/app", "vscode"))?.source).toBe("vscode");
    expect(parseCodexMeta(meta(X, "/srv/dev/app", { subagent: { other: "guardian" } }))).toBeNull();
    expect(parseCodexMeta(line({ type: "event_msg", payload: {} }))).toBeNull();
    expect(parseCodexMeta(meta("not-a-uuid", "/srv/dev/app"))).toBeNull();
    expect(parseCodexMeta('{"type":"session_meta","payload":{"id":"cut mid')).toBeNull();
  });

  test("the first typed prompt: a user_message event or a user item, never the harness's own context block", () => {
    const text = [meta(X, "/a"), envItem("/a"), typedItem("  fix the\n flaky scan "), userMsg("later")].join("\n");
    expect(parseCodexHead(text)).toEqual({ prompt: "fix the flaky scan", turns: true });
    expect(parseCodexHead([meta(X, "/a"), envItem("/a"), userMsg("from the event")].join("\n")).prompt).toBe("from the event");
    // a session opened and quit: the meta alone
    expect(parseCodexHead(meta(X, "/a"))).toEqual({ prompt: null, turns: false });
    // turns but nothing typed within the head: still a session
    expect(parseCodexHead([meta(X, "/a"), envItem("/a")].join("\n"))).toEqual({ prompt: null, turns: true });
  });

  test("the day folders of the last days, newest first, by the local calendar", () => {
    expect(codexDayDirs(new Date(2026, 8, 30, 15), 3)).toEqual(["2026/09/30", "2026/09/29", "2026/09/28"]);
    expect(codexDayDirs(new Date(2026, 2, 1), 2)).toEqual(["2026/03/01", "2026/02/28"]);
  });
});

describe("codex sessions off disk", () => {
  let home: string;
  const repo = "/srv/dev/app";
  const now = new Date(2026, 8, 30, 12);

  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), "canopy-codex-"));
    const day = (d: string) => join(home, "sessions", d);
    await mkdir(day("2026/09/30"), { recursive: true });
    await mkdir(day("2026/09/12"), { recursive: true });
    await mkdir(day("2026/07/01"), { recursive: true });
    const put = async (d: string, id: string, lines: string[], at: number) => {
      const f = join(day(d), `rollout-2026-09-30T10-00-00-${id}.jsonl`);
      await writeFile(f, lines.join("\n") + "\n");
      await utimes(f, new Date(at), new Date(at));
    };
    await put("2026/09/12", X, [meta(X, repo), envItem(repo), typedItem("older one")], 1_000_000);
    await put("2026/09/30", Y, [meta(Y, repo, "vscode", { branch: "dev" }), envItem(repo), userMsg("newer one")], 3_000_000);
    await put("2026/09/30", Z, [meta(Z, "/srv/dev/other"), typedItem("elsewhere")], 4_000_000);
    await put("2026/09/30", SUB, [meta(SUB, repo, { subagent: { other: "guardian" } }), typedItem("review")], 5_000_000);
    // opened and quit: nothing to resume
    await put("2026/09/30", "01a0939c-51bd-7522-9511-0346d9bb8e98", [meta("01a0939c-51bd-7522-9511-0346d9bb8e98", repo)], 6_000_000);
    // past the thirty days looked at
    await put("2026/07/01", OLD, [meta(OLD, repo), typedItem("too old")], 500_000);
    await writeFile(join(day("2026/09/30"), "notes.jsonl"), meta(X, repo));
  });

  afterAll(async () => {
    await rm(home, { recursive: true, force: true });
  });

  test("the repo's own, newest first; another folder's, a subagent's, an empty one and an old one left out", async () => {
    const list = await codexSessions(repo, 20, home, now);
    expect(list.map((s) => [s.harness, s.id, s.prompt, s.branch])).toEqual([
      ["codex", Y, "newer one", "dev"],
      ["codex", X, "older one", null],
    ]);
    expect(list[0]?.at).toBe(3_000_000);
    expect(list[0]?.summary).toBeNull();
  });

  test("the limit takes the newest, and a second read answers the same off the memo", async () => {
    expect((await codexSessions(repo, 1, home, now)).map((s) => s.id)).toEqual([Y]);
    expect((await codexSessions(repo, 20, home, now)).map((s) => s.id)).toEqual([Y, X]);
  });

  test("a folder codex never ran in has none, and a missing home is no error", async () => {
    expect(await codexSessions("/nowhere", 20, home, now)).toEqual([]);
    expect(await codexSessions(repo, 20, join(home, "missing"), now)).toEqual([]);
  });

  test("a session belongs to the repo it was started in", async () => {
    expect(await hasCodexSession(repo, X, home, now)).toBe(true);
    expect(await hasCodexSession(repo, OLD, home, now)).toBe(false);
    expect(await hasCodexSession("/srv/dev/other", Y, home, now)).toBe(false);
    expect(await hasCodexSession(repo, "../../x", home, now)).toBe(false);
  });
});
