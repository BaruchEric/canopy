import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIONS } from "./actions";
import { cliArgs } from "./runner";
import { DEFAULT_AGENT } from "./types";

describe("the print-mode command line", () => {
  test("the default is the bypass mode; ask goes through the prompt tool", () => {
    expect(cliArgs(ACTIONS.ask, DEFAULT_AGENT)).toContain("bypassPermissions");
    const args = cliArgs(ACTIONS.ask, { ...DEFAULT_AGENT, yolo: false });
    expect(args.slice(0, 2)).toEqual(["-p", "--output-format"]);
    expect(args).toContain("--permission-prompt-tool");
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2)).toEqual([
      "--permission-mode",
      "default",
    ]);
    expect(args).not.toContain("--model");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  test("the repo's settings ride along; yolo becomes the bypass mode", () => {
    const args = cliArgs(ACTIONS.chat, { model: "opus", effort: "high", yolo: true, extra: "--name x" });
    expect(args.slice(-6)).toEqual(["--model", "opus", "--effort", "high", "--name", "x"]);
    expect(args).toContain("bypassPermissions");
    // print mode takes the mode, not the interactive flag
    expect(args).not.toContain("--dangerously-skip-permissions");
    // the prompt tool stays: questions still come to the browser
    expect(args).toContain("--permission-prompt-tool");
  });
});

/* A stand-in for the claude CLI that never calls anything: it asks for two
 * tools at once, the way Claude Code does for parallel reads, and finishes
 * only when both requests got an answer. */
const FAKE_CLAUDE = `
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const dec = new TextDecoder();
let buf = "";
const answered = new Set();
let asked = false;
const ask = (id, path) => out({ type: "control_request", request_id: id, request: { subtype: "can_use_tool", tool_name: "Read", input: { file_path: path }, tool_use_id: "tu-" + id } });
setTimeout(() => process.exit(3), 8000);
for await (const chunk of Bun.stdin.stream()) {
  buf += dec.decode(chunk, { stream: true });
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const m = JSON.parse(line);
    if (!asked && m.type === "user") {
      asked = true;
      ask("req-A", "/nowhere/a");
      ask("req-B", "/nowhere/b");
    } else if (m.type === "control_response") {
      answered.add(m.response.request_id);
      if (answered.size === 2) out({ type: "result", subtype: "success", is_error: false, result: "both answered", num_turns: 1, total_cost_usd: 0, duration_ms: 1 });
    }
  }
}
process.exit(0);
`;

/* Drives a Runner in a process whose PATH finds the stand-in first:
 * Bun.which does not see a PATH changed at runtime. */
const HARNESS = (root: string) => `
import { Runner, claudeBinary } from ${JSON.stringify(join(root, "src/core/runner.ts"))};
import { ACTIONS } from ${JSON.stringify(join(root, "src/core/actions.ts"))};
import { DEFAULT_AGENT } from ${JSON.stringify(join(root, "src/core/types.ts"))};
if (claudeBinary() !== process.env.FAKE_CLAUDE) {
  console.log(JSON.stringify({ abort: claudeBinary() }));
  process.exit(1);
}
const runner = new Runner({ onChange: () => {}, onGone: () => {} });
const repo = { id: "fx", name: "fx", path: process.env.FAKE_REPO, status: null };
const run = runner.start(repo, "ask", ACTIONS.ask, "read two files", { ...DEFAULT_AGENT, yolo: false });
const until = async (pred) => {
  for (let i = 0; i < 100; i++) {
    const r = runner.get(run.id);
    if (pred(r)) return r;
    await Bun.sleep(50);
  }
  return runner.get(run.id);
};
const ids = [];
for (let n = 0; n < 2; n++) {
  const r = await until((r) => r.prompt && !ids.includes(r.prompt.id));
  if (!r.prompt || ids.includes(r.prompt.id)) break;
  ids.push(r.prompt.id);
  runner.answer(run.id, r.prompt.id, { kind: "allow" });
}
const end = await until((r) => r.status !== "working" && r.status !== "waiting");
if (end.status === "working" || end.status === "waiting") runner.stop(run.id);
console.log(JSON.stringify({ ids, status: end.status }));
process.exit(0);
`;

describe("a run asked two things at once", () => {
  test("shows each prompt under its own id and answers both requests", async () => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-runner-"));
    try {
      const bin = join(dir, "bin");
      await Bun.$`mkdir -p ${bin} ${join(dir, "repo")}`.quiet();
      const fake = join(bin, "claude");
      await writeFile(fake, `#!${process.execPath}\n${FAKE_CLAUDE}`);
      await chmod(fake, 0o755);
      await writeFile(join(dir, "harness.ts"), HARNESS(join(import.meta.dir, "../..")));
      const proc = Bun.spawn([process.execPath, join(dir, "harness.ts")], {
        env: { ...process.env, PATH: `${bin}:${process.env["PATH"] ?? ""}`, FAKE_CLAUDE: fake, FAKE_REPO: join(dir, "repo") },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
      const result = JSON.parse(out.trim().split("\n").at(-1) ?? "{}") as { ids?: string[]; status?: string; abort?: string };
      expect(result.abort).toBeUndefined();
      expect(result.ids?.length).toBe(2);
      expect(new Set(result.ids).size).toBe(2);
      expect(result.status).toBe("done");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }, 30_000);
});
