import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { endAgent, MOVE_MAX, MoveError, movePath, placeTranscript, QUIT, rewriteTranscript, type PaneDriver } from "./move";
import { projectFolder, transcriptFile } from "./sessions";

const S = "0f5e2c1a-1111-4222-8333-444455556666";
const FROM = "/Users/e/dev/app";
const TO = "/home/e/dev/app";
let scratch = "";
beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-move-"));
});
afterAll(async () => {
  await rm(scratch, { recursive: true, force: true });
});

describe("movePath", () => {
  test("the repo and anything under it move; a sibling with the same prefix does not", () => {
    expect(movePath(FROM, FROM, TO)).toBe(TO);
    expect(movePath(`${FROM}/ui/src`, FROM, TO)).toBe(`${TO}/ui/src`);
    expect(movePath(`${FROM}2`, FROM, TO)).toBe(`${FROM}2`);
    expect(movePath("/tmp", FROM, TO)).toBe("/tmp");
  });
});

describe("rewriteTranscript", () => {
  test("claude: top-level cwd moves, message text keeps its paths", () => {
    const line = JSON.stringify({ type: "user", cwd: `${FROM}/ui`, message: { content: `look at ${FROM}/x.ts` } });
    const out = rewriteTranscript(`${line}\n`, FROM, TO);
    const rec = JSON.parse(out.trim());
    expect(rec.cwd).toBe(`${TO}/ui`);
    expect(rec.message.content).toBe(`look at ${FROM}/x.ts`);
    expect(out.endsWith("\n")).toBe(true);
  });
  test("codex: payload.cwd moves in session_meta and turn_context", () => {
    const meta = JSON.stringify({ type: "session_meta", payload: { id: S, cwd: FROM } });
    const turn = JSON.stringify({ type: "turn_context", payload: { cwd: `${FROM}/a` } });
    const [m, t] = rewriteTranscript(`${meta}\n${turn}\n`, FROM, TO).trim().split("\n").map((l) => JSON.parse(l));
    expect(m.payload.cwd).toBe(TO);
    expect(t.payload.cwd).toBe(`${TO}/a`);
  });
  test("a line that is not JSON is refused, a cut-off last line included", () => {
    const good = JSON.stringify({ cwd: FROM });
    expect(() => rewriteTranscript(`${good}\n{"cwd":"/Us`, FROM, TO)).toThrow(MoveError);
  });
  test("a cwd written with odd spacing still moves", () => {
    const spaced = `{"type":"user","cwd": "${FROM}"}`;
    expect(JSON.parse(rewriteTranscript(`${spaced}\n`, FROM, TO).trim()).cwd).toBe(TO);
  });
  test("a nested cwd with the same value is left alone", () => {
    const line = `{"message":{"content":[{"input":{"cwd":${JSON.stringify(FROM)}}}]},"cwd":${JSON.stringify(FROM)}}`;
    const rec = JSON.parse(rewriteTranscript(`${line}\n`, FROM, TO).trim());
    expect(rec.cwd).toBe(TO);
    expect(rec.message.content[0].input.cwd).toBe(FROM);
  });
  test("a line with nothing to move comes back byte for byte", () => {
    const line = '{"type":"summary","summary":"caf\\u00e9"}';
    expect(rewriteTranscript(`${line}\n`, FROM, TO)).toBe(`${line}\n`);
  });
});

describe("placeTranscript", () => {
  const homes = () => ({ claude: join(scratch, "claude"), codex: join(scratch, "codex") });
  test("claude: lands under the target's project folder", async () => {
    const got = await placeTranscript({ harness: "claude", session: S, text: "{}\n", name: `${S}.jsonl`, to: TO, homes: homes() });
    expect(got.file).toBe(join(scratch, "claude", "projects", projectFolder(TO), `${S}.jsonl`));
    expect(got.replaced).toBe(false);
    expect(await readFile(got.file, "utf8")).toBe("{}\n");
  });
  test("an earlier copy that is a line prefix is replaced; a split copy is refused", async () => {
    const got = await placeTranscript({ harness: "claude", session: S, text: "{}\n{}\n", name: `${S}.jsonl`, to: TO, homes: homes() });
    expect(got.replaced).toBe(true);
    const split = placeTranscript({ harness: "claude", session: S, text: '{"a":1}\n', name: `${S}.jsonl`, to: TO, homes: homes() });
    await expect(split).rejects.toMatchObject({ status: 409 });
  });
  test("codex: keeps its day folders and file name", async () => {
    const name = `2026/10/10/rollout-2026-10-10T09-00-00-${S}.jsonl`;
    const got = await placeTranscript({ harness: "codex", session: S, text: "{}\n", name, to: TO, homes: homes() });
    expect(got.file).toBe(join(scratch, "codex", "sessions", name));
  });
  test("codex: a name that climbs out or names another session is refused", async () => {
    for (const name of ["../../x.jsonl", `2026/10/10/rollout-x-${"1".repeat(8)}.jsonl`]) {
      await expect(placeTranscript({ harness: "codex", session: S, text: "{}\n", name, to: TO, homes: homes() })).rejects.toMatchObject({ status: 400 });
    }
  });
  test("over the cap is refused", async () => {
    const big = "x".repeat(MOVE_MAX + 1);
    await expect(placeTranscript({ harness: "claude", session: S, text: big, name: `${S}.jsonl`, to: TO, homes: homes() })).rejects.toMatchObject({ status: 413 });
  });
});

describe("transcriptFile", () => {
  test("claude: the session's file under the folder's project dir, null when missing", async () => {
    const home = join(scratch, "tf-claude");
    const dir = join(home, "projects", projectFolder(FROM));
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, `${S}.jsonl`), "{}\n");
    expect(await transcriptFile("claude", FROM, S, { claude: home })).toEqual({ file: join(dir, `${S}.jsonl`), name: `${S}.jsonl` });
    expect(await transcriptFile("claude", FROM, S.replace("0f", "1f"), { claude: home })).toBeNull();
  });
});

/** a pane whose agent exits once it has been sent its quit command and Enter */
function fakePane(runs: "claude" | "codex" | null, exits = true): PaneDriver & { sent: string[][] } {
  let agent = runs;
  let typed = "";
  const sent: string[][] = [];
  return {
    sent,
    async keys(keys, literal) {
      sent.push(literal ? ["-l", ...keys] : keys);
      if (literal) typed = keys.join("");
      if (!literal && keys[0] === "Enter" && exits && agent && typed === QUIT[agent]) agent = null;
    },
    async agent() {
      return agent;
    },
  };
}

describe("endAgent", () => {
  const quick = { waitMs: 200, beatMs: 1 };
  test("claude: Escape, then /exit and Enter as two sends, then back at the shell", async () => {
    const pane = fakePane("claude");
    expect(await endAgent(pane, "claude", quick)).toBe(true);
    expect(pane.sent).toEqual([["Escape"], ["-l", "/exit"], ["Enter"]]);
  });
  test("codex quits with /quit", async () => {
    const pane = fakePane("codex");
    expect(await endAgent(pane, "codex", quick)).toBe(true);
    expect(pane.sent[1]).toEqual(["-l", "/quit"]);
  });
  test("nothing running: done, no keys", async () => {
    const pane = fakePane(null);
    expect(await endAgent(pane, "claude", quick)).toBe(true);
    expect(pane.sent).toEqual([]);
  });
  test("an agent that never exits times out", async () => {
    expect(await endAgent(fakePane("claude", false), "claude", quick)).toBe(false);
  });
  test("the other harness in the pane is refused before any key", async () => {
    const pane = fakePane("codex");
    await expect(endAgent(pane, "claude", quick)).rejects.toMatchObject({ status: 409 });
    expect(pane.sent).toEqual([]);
  });
});
