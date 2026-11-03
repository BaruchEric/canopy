import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { cutTranscript, placeCut, readTranscript, realDir, removeCut, sameWords, transcriptPath, transcriptPaths } from "./forkcut";
import { projectFolder } from "./sessions";
import type { RunStep } from "./types";

const CWD = "/work/repo";
const SID = "aaaaaaaa-0000-0000-0000-000000000001";
const NEW = "bbbbbbbb-0000-0000-0000-000000000002";

/** a transcript line as the CLI writes one */
const line = (type: string, uuid: string, parent: string | null, over: Record<string, unknown> = {}): string =>
  JSON.stringify({ type, uuid, parentUuid: parent, sessionId: SID, cwd: CWD, isSidechain: false, ...over });
const assistant = (uuid: string, parent: string, content: unknown[], over: Record<string, unknown> = {}): string =>
  line("assistant", uuid, parent, { message: { role: "assistant", content }, ...over });
const user = (uuid: string, parent: string | null, content: unknown, over: Record<string, unknown> = {}): string =>
  line("user", uuid, parent, { message: { role: "user", content }, ...over });

const transcript = [
  JSON.stringify({ type: "summary", summary: "the whole thing", leafUuid: "u8" }),
  JSON.stringify({ type: "queue-operation", operation: "enqueue", sessionId: SID }),
  user("u1", null, "look at the bar"),
  assistant("u2", "u1", [{ type: "thinking", thinking: "hm" }]),
  assistant("u3", "u2", [{ type: "text", text: "Looking." }]),
  assistant("u4", "u3", [{ type: "tool_use", id: "toolu_1", name: "Read", input: { file_path: "/work/repo/a.ts" } }]),
  JSON.stringify({ type: "attachment", uuid: "u4b", parentUuid: "u4", sessionId: SID }),
  user("u5", "u4", [{ type: "tool_result", tool_use_id: "toolu_1", content: "the file" }]),
  assistant("u6", "u5", [{ type: "tool_use", id: "toolu_2", name: "Read", input: { file_path: "/work/repo/a.ts" } }]),
  user("u7", "u6", [{ type: "tool_result", tool_use_id: "toolu_2", content: "the file again" }]),
  assistant("s1", "u6", [{ type: "tool_use", id: "toolu_s", name: "Grep", input: { pattern: "x" } }], { isSidechain: true }),
  assistant("u8", "u7", [{ type: "text", text: "Done." }]),
];

const text = (id: string, text: string): RunStep => ({ id, at: 1, kind: "text", text });
const read = (id: string): RunStep => ({ id, at: 1, kind: "tool", tool: { name: "Read", title: "Read a.ts", status: "ok" } });

const types = (lines: string[]): string[] => lines.map((l) => (JSON.parse(l) as { type: string }).type);
const uuids = (lines: string[]): string[] => lines.flatMap((l) => { const o = JSON.parse(l) as { uuid?: string }; return o.uuid ? [o.uuid] : []; });

describe("cutTranscript", () => {
  test("a text step: through its line, every sessionId rewritten, a summary of a later leaf dropped", () => {
    const cut = cutTranscript(transcript, text("1", "Looking."), CWD, NEW);
    expect(cut).not.toBeNull();
    expect(uuids(cut ?? [])).toEqual(["u1", "u2", "u3"]);
    expect(types(cut ?? [])).toEqual(["queue-operation", "user", "assistant", "assistant"]);
    for (const l of cut ?? []) {
      const o = JSON.parse(l) as { sessionId?: string };
      if ("sessionId" in o) expect(o.sessionId).toBe(NEW);
    }
  });

  test("a tool step: through the result that answers its call, the attachment between kept", () => {
    const cut = cutTranscript(transcript, read("1"), CWD, NEW);
    expect(uuids(cut ?? [])).toEqual(["u1", "u2", "u3", "u4", "u4b", "u5"]);
  });

  test("the k-th of several lines that read the same, by the steps before it", () => {
    const cut = cutTranscript(transcript, read("2"), CWD, NEW, [text("0", "Looking."), read("1")]);
    expect(uuids(cut ?? []).at(-1)).toBe("u7");
    // a summary whose leaf is past the cut goes; one for a kept leaf stays
    const withSummary = [JSON.stringify({ type: "summary", summary: "early", leafUuid: "u3" }), ...transcript];
    expect(types(cutTranscript(withSummary, read("2"), CWD, NEW, [read("1")]) ?? [])[0]).toBe("summary");
  });

  test("a tool whose title differs from the fold's is still found by its name; a step not in the file is null", () => {
    const renamed: RunStep = { id: "1", at: 1, kind: "tool", tool: { name: "Read", title: "Read elsewhere.ts", status: "ok" } };
    expect(uuids(cutTranscript(transcript, renamed, CWD, NEW) ?? []).at(-1)).toBe("u5");
    expect(cutTranscript(transcript, text("1", "never said"), CWD, NEW)).toBeNull();
    expect(cutTranscript(transcript, { id: "1", at: 1, kind: "tool", tool: { name: "Edit", title: "Edit x", status: "ok" } }, CWD, NEW)).toBeNull();
  });

  test("a subagent's step is looked for among the sidechain lines, and a main-thread step never matches one", () => {
    const grep: RunStep = { id: "1", at: 1, kind: "tool", tool: { name: "Grep", title: "Grep x", status: "ok" }, parent: "p" };
    expect(uuids(cutTranscript(transcript, grep, CWD, NEW) ?? []).at(-1)).toBe("s1");
    expect(cutTranscript(transcript, { ...grep, parent: undefined }, CWD, NEW)).toBeNull();
  });

  test("a kept run's step with a secret redacted out still finds its line, by the words around the redaction", () => {
    expect(sameWords("read <redacted:CANOPY_CONFIG_DIR>/a.ts", "read /x/config/a.ts")).toBe(true);
    expect(sameWords("read <redacted:CANOPY_CONFIG_DIR>/a.ts", "read /x/config/b.ts")).toBe(false);
    expect(sameWords("<redacted:X> then <redacted:Y>", "one then two")).toBe(true);
    expect(sameWords("plain", "plain")).toBe(true);
    expect(sameWords("plain", "plain enough")).toBe(false);
    const redacted: RunStep = { id: "1", at: 1, kind: "tool", tool: { name: "Read", title: "Read <redacted:CANOPY_REPO>.ts", status: "ok" } };
    expect(uuids(cutTranscript(transcript, redacted, CWD, NEW) ?? []).at(-1)).toBe("u5");
    expect(uuids(cutTranscript(transcript, text("1", "<redacted:WORD>ing."), CWD, NEW) ?? [])).toEqual(["u1", "u2", "u3"]);
  });

  test("a line that is not JSON goes through as it is", () => {
    const odd = ["not json", ...transcript];
    expect(cutTranscript(odd, text("1", "Looking."), CWD, NEW)?.[0]).toBe("not json");
  });
});

describe("placing the copy", () => {
  const scratch: string[] = [];
  afterAll(async () => { for (const d of scratch) await rm(d, { recursive: true, force: true }); });

  test("under the worktree's slug, mode 0600, read back and removed", async () => {
    const home = await mkdtemp(join(tmpdir(), "canopy-forkcut-"));
    scratch.push(home);
    // a worktree that is gone: its slug is of the path as given
    const cwd = "/x/worktrees/repo/ab12";
    const file = await placeCut(cwd, NEW, ["{\"a\":1}", "{\"b\":2}"], home);
    expect(file).toBe(join(home, "projects", projectFolder(cwd), `${NEW}.jsonl`));
    expect(file).toBe(transcriptPath(cwd, NEW, home));
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(await readFile(file, "utf8")).toBe("{\"a\":1}\n{\"b\":2}\n");
    expect(await readTranscript(file)).toEqual(["{\"a\":1}", "{\"b\":2}"]);
    await removeCut(file);
    expect(await readTranscript(file)).toBeNull();
    await removeCut(file);
  });

  test("a worktree reached through a symlink is filed under its real path's slug, as the CLI's cwd spells it", async () => {
    const home = await mkdtemp(join(tmpdir(), "canopy-forkcut-"));
    scratch.push(home);
    const real = join(home, "real", "ab12");
    await mkdir(real, { recursive: true });
    await symlink(join(home, "real"), join(home, "link"));
    const viaLink = join(home, "link", "ab12");
    expect(await realDir(viaLink)).toBe(await realpath(real));
    // a folder gone from under the link still resolves through its parent
    expect(await realDir(join(home, "link", "gone"))).toBe(join(dirname(await realpath(real)), "gone"));
    const file = await placeCut(viaLink, NEW, ["{}"], home);
    expect(file).toBe(transcriptPath(await realpath(real), NEW, home));
    const both = await transcriptPaths(viaLink, NEW, home);
    expect(both).toEqual([transcriptPath(viaLink, NEW, home), file]);
    expect(await transcriptPaths(real, NEW, home)).toHaveLength(await realpath(real) === real ? 1 : 2);
  });
});
