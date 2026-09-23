import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { claudeSessions, hasClaudeSession, isSessionId, parseSessionHead, projectFolder, resumeLine } from "./sessions";
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
    expect(list.map((s) => [s.id, s.prompt])).toEqual([
      [B, "newer one"],
      [A, "older one"],
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
