import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HandOffReview, IncubatorStages, RunQuestion, Sprout, SproutDetail } from "../core/types";
import { NO_STAGES } from "../server/incubator";
import { answerMap, incubatorCommand, listLine, newCommand, pageBase, showLines, waitWhy } from "./incubator";

const sprout = (over: Partial<Sprout> = {}): Sprout => ({
  id: "sp_0123456789ab",
  slug: "coins",
  title: "a coin counter",
  status: "queued",
  repoId: "_incubator/coins",
  seedPath: "/x/_incubator/coins",
  prepared: true,
  inputs: [],
  clarified: false,
  reclarify: false,
  flows: [],
  spent: { runs: 2, workMs: 180_000 },
  createdAt: 1,
  updatedAt: 1,
  ...over,
});
const detail = (s: Sprout): SproutDetail => ({ sprout: s, brief: null, intent: "Count the quarters.\n", inputsIndex: "- [1] text 001-text.md\n", research: null, retro: null });
const AWAY: IncubatorStages = { isolated: false, mode: "runner", waiting: "the stage runner is not answering", unfenced: null, login: null };
const QS: RunQuestion[] = [
  { question: "Who counts?", header: "who", options: [{ label: "staff", description: "the attendant" }, { label: "owner", description: "" }], multiSelect: false },
  { question: "Which coins?", header: "coins", options: [{ label: "quarters", description: "" }, { label: "dimes", description: "" }, { label: "tokens", description: "" }], multiSelect: true },
  { question: "Anything else?", header: "else", options: [], multiSelect: false },
];
const REVIEW: HandOffReview = {
  head: "0123456789abcdef0123456789abcdef01234567",
  base: "fedcba9876543210fedcba9876543210fedcba98",
  remote: "https://github.com/eric/clms.git",
  branch: "new/coins",
  commits: [{ sha: "0123456789abcdef", subject: "add the counter" }],
  moreCommits: 0,
  files: [{ path: "src/count.ts", added: 3, removed: 1 }],
  moreFiles: 0,
  flagged: [],
  at: 1,
};

interface Seen {
  method: string;
  path: string;
  id: string | null;
  json?: unknown;
  form?: Record<string, string[]>;
}

/** A backend that answers the incubator's routes and keeps what it was sent. */
function fake(opts: { stages?: IncubatorStages | null; backends?: unknown; one?: SproutDetail; list?: Sprout[] } = {}) {
  const seen: Seen[] = [];
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      const path = url.pathname;
      const rec: Seen = { method: req.method, path, id: url.searchParams.get("id") };
      const type = req.headers.get("content-type") ?? "";
      if (type.startsWith("multipart/form-data")) {
        const form = await req.formData();
        const fields: Record<string, string[]> = {};
        for (const [k, v] of form.entries()) (fields[k] ??= []).push(typeof v === "string" ? v : `file:${v.name}:${await v.text()}`);
        rec.form = fields;
      } else if (type.includes("json")) rec.json = await req.json();
      seen.push(rec);
      if (path === "/api/incubator/stages") return opts.stages === null ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(opts.stages ?? { ...AWAY, isolated: true, waiting: null });
      if (path === "/api/backends") return opts.backends === undefined ? Response.json({ error: "not found" }, { status: 404 }) : Response.json(opts.backends);
      if (path === "/api/incubator" && req.method === "POST") return Response.json(sprout({ title: "made" }), { status: 201 });
      if (path === "/api/incubator" && req.method === "GET") return Response.json(opts.list ?? []);
      if (path === "/api/incubator" && req.method === "DELETE") return Response.json({ ok: true });
      if (path === "/api/incubator/one") return Response.json(opts.one ?? detail(sprout()));
      return Response.json(sprout({ status: "queued" }));
    },
  });
  return { seen, base: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) };
}

/** a command's stdout and stderr lines; its fail throws its words */
async function run(cmd: (argv: string[], o: { fail: (m: string) => never }) => Promise<void>, argv: string[]): Promise<{ out: string[]; err: string[] }> {
  const log = console.log;
  const error = console.error;
  const out: string[] = [];
  const err: string[] = [];
  try {
    console.log = (line: unknown) => void out.push(String(line));
    console.error = (line: unknown) => void err.push(String(line));
    await cmd(argv, { fail: (m) => { throw Error(m); } });
  } finally {
    console.log = log;
    console.error = error;
  }
  return { out, err };
}

const dir = mkdtempSync(join(tmpdir(), "canopy-incubator-cli-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));
const memo = join(dir, "memo.md");
writeFileSync(memo, "count the quarters");

describe("canopy new", () => {
  test("asks where stages run before it sends a file, and stops in the server's own words when they are off", async () => {
    const b = fake({ stages: { isolated: false, mode: "off", waiting: null } });
    try {
      await expect(run(newCommand, ["a coin counter", "--file", memo, "--backend", b.base])).rejects.toThrow(NO_STAGES);
      expect(b.seen.map((r) => `${r.method} ${r.path}`)).toEqual(["GET /api/incubator/stages"]);
    } finally {
      b.stop();
    }
  });

  test("prints the link at the backend's public origin, and at the API's when the backend names none", async () => {
    const listed = { self: "mini", backends: [{ name: "mac", public: "https://mac.example" }, { name: "mini", public: "https://canopy.example/", tailnet: "http://mini.ts:7850" }] };
    const b = fake({ backends: listed });
    try {
      const { out } = await run(newCommand, ["a coin counter", "--file", memo, "--backend", b.base]);
      expect(out.at(-1)).toBe("https://canopy.example/?view=incubator&sprout=sp_0123456789ab");
      const posted = b.seen.find((r) => r.method === "POST");
      expect(posted?.form).toEqual({ text: ["a coin counter"], file: ["file:memo.md:count the quarters"], via: ["cli"] });
    } finally {
      b.stop();
    }
    const bare = fake();
    try {
      const { out } = await run(newCommand, ["a coin counter", "--backend", bare.base]);
      expect(out.at(-1)).toBe(`${bare.base}/?view=incubator&sprout=sp_0123456789ab`);
    } finally {
      bare.stop();
    }
  });

  test("an older backend that cannot say where stages run still gets the project", async () => {
    const b = fake({ stages: null });
    try {
      const { out } = await run(newCommand, ["a coin counter", "--backend", b.base]);
      expect(out[0]).toContain("sp_0123456789ab");
    } finally {
      b.stop();
    }
  });

  test("a lone repo url goes as the repo, with the note on stderr; an unknown flag sends nothing", async () => {
    const b = fake();
    try {
      const { out, err } = await run(newCommand, ["https://github.com/a/b", "--backend", b.base]);
      expect(b.seen.find((r) => r.method === "POST")?.form).toEqual({ repo: ["https://github.com/a/b"], via: ["cli"] });
      expect(err).toEqual(["took https://github.com/a/b as --repo; pass it with --url to give it as a link"]);
      expect(out[0]).toContain("sp_0123456789ab");
      b.seen.length = 0;
      await expect(run(newCommand, ["a coin counter", "--fiel", memo, "--backend", b.base])).rejects.toThrow("unknown flag --fiel");
      expect(b.seen).toEqual([]);
    } finally {
      b.stop();
    }
  });
});

describe("the lines", () => {
  test("pageBase takes the public origin of the backend's own entry, else the API origin", () => {
    const api = "http://127.0.0.1:7850";
    expect(pageBase(api, { self: "mini", backends: [{ name: "mini", public: "https://canopy.example" }] })).toBe("https://canopy.example");
    expect(pageBase(api, { self: "mini", backends: [{ name: "mac", public: "https://mac.example" }] })).toBe(api);
    expect(pageBase(api, { self: "mini", backends: [{ name: "mini", tailnet: "http://mini.ts:7850" }] })).toBe(api);
    expect(pageBase(api, { self: "mini", backends: [{ name: "mini", public: "not a url" }] })).toBe(api);
    expect(pageBase(api, null)).toBe(api);
    expect(pageBase(api, { error: "not found" })).toBe(api);
  });

  test("a queued project waits in its backend's words, unless it is being prepared or bound for canopy's own deploy", () => {
    expect(waitWhy(sprout(), AWAY)).toBe("the stage runner is not answering");
    expect(waitWhy(sprout({ prepared: false }), AWAY)).toBe(null);
    expect(waitWhy(sprout({ status: "building" }), AWAY)).toBe(null);
    expect(waitWhy(sprout(), null)).toBe(null);
    const bound = sprout({ clarified: true, pick: { kind: "new", host: "vercel", why: "w" }, flows: [{ workflow: "scout", flowId: "f1", outcome: "done" }, { workflow: "build-new", flowId: "f2", outcome: "done" }] });
    expect(waitWhy(bound, AWAY)).toBe(null);
    expect(listLine(sprout(), AWAY)).toBe("sp_0123456789ab  queued      a coin counter (waiting: the stage runner is not answering)");
    expect(listLine(sprout({ status: "clarifying", questions: QS }), AWAY)).toBe("sp_0123456789ab  clarifying  a coin counter (3 questions waiting)");
  });

  test("show says why the project waits and lists clarify's questions with their options and the command that answers", () => {
    const lines = showLines(detail(sprout({ status: "clarifying", questions: QS })), AWAY, "https://canopy.example/?view=incubator&sprout=sp_0123456789ab");
    expect(lines.slice(0, 3)).toEqual(["a coin counter  _incubator/coins", "clarifying", "2 runs, 3 min of agent work"]);
    expect(lines).toContain("clarify asks 3 questions:");
    expect(lines).toContain("1. Who counts?");
    expect(lines).toContain("   1) staff: the attendant");
    expect(lines).toContain("   2) owner");
    expect(lines).toContain("2. Which coins? (pick any)");
    expect(lines).toContain("3. Anything else?");
    expect(lines).toContain('answer: canopy incubator answer sp_0123456789ab "<1>" "<2>" "<3>"');
    expect(lines).toContain("or go on assumptions: canopy incubator answer sp_0123456789ab --skip");
    expect(lines.at(-1)).toBe("https://canopy.example/?view=incubator&sprout=sp_0123456789ab");
    expect(lines).toContain("Count the quarters.");

    const waiting = showLines(detail(sprout()), AWAY, "L");
    expect(waiting.slice(0, 3)).toEqual(["a coin counter  _incubator/coins", "queued", "waiting: the stage runner is not answering"]);
  });

  test("show gives a parked project's ways on, a hand-off's review and its yes, and an ended one's dismiss", () => {
    const parked = showLines(detail(sprout({ status: "parked", parked: "Accept did not accept the work" })), AWAY, "L");
    expect(parked[1]).toBe("parked: Accept did not accept the work");
    expect(parked).toContain("go on: canopy incubator resume sp_0123456789ab");
    expect(parked).toContain("run the step again, or send the work back: canopy incubator resume sp_0123456789ab --retry");
    expect(parked).toContain("end it: canopy incubator stop sp_0123456789ab");
    const approving = showLines(detail(sprout({ status: "approving", handOff: REVIEW })), AWAY, "L");
    expect(approving.join("\n")).toContain("Push new/coins to github.com/eric/clms, from fedcba987654 to 0123456789ab.");
    expect(approving).toContain("push it: canopy incubator handoff sp_0123456789ab --yes 0123456789ab");
    expect(showLines(detail(sprout({ status: "stopped" })), AWAY, "L")).toContain("off the list: canopy incubator dismiss sp_0123456789ab");
  });

  test("answerMap keys each answer by its question: a number picks an option, several where any may be picked, '' leaves one", () => {
    expect(answerMap(QS, ["2", "1,3", "open on Sundays"])).toEqual({ answers: { "Who counts?": "owner", "Which coins?": "quarters, tokens", "Anything else?": "open on Sundays" } });
    // out of range, or several where one is picked: the words as written
    expect(answerMap(QS, ["7", "", ""])).toEqual({ answers: { "Who counts?": "7" } });
    expect(answerMap(QS, ["1,2"])).toEqual({ answers: { "Who counts?": "1,2" } });
    expect(answerMap(QS, ["the night shift"])).toEqual({ answers: { "Who counts?": "the night shift" } });
    expect(answerMap(QS, ["1", "1", "x", "extra"])).toEqual({ error: "4 answers for 3 questions: give one per question, in order" });
    const none = answerMap(QS, ["", " "]);
    expect("error" in none && none.error.startsWith("give an answer, or --skip")).toBe(true);
  });
});

describe("canopy incubator", () => {
  test("answer reads the questions, then posts the answers keyed by each; --skip goes on assumptions", async () => {
    const b = fake({ one: detail(sprout({ status: "clarifying", questions: QS })) });
    try {
      await run(incubatorCommand, ["answer", "sp_0123456789ab", "1", "2", "--backend", b.base]);
      await run(incubatorCommand, ["answer", "sp_0123456789ab", "--skip", "--backend", b.base]);
      expect(b.seen.map((r) => [r.method, r.path, r.id, r.json])).toEqual([
        ["GET", "/api/incubator/one", "sp_0123456789ab", undefined],
        ["POST", "/api/incubator/answer", "sp_0123456789ab", { answers: { "Who counts?": "staff", "Which coins?": "dimes" } }],
        ["POST", "/api/incubator/answer", "sp_0123456789ab", { skip: true }],
      ]);
      await expect(run(incubatorCommand, ["answer", "sp_0123456789ab", "--skp", "--backend", b.base])).rejects.toThrow("unknown flag --skp");
      await expect(run(incubatorCommand, ["answer", "sp_0123456789ab", "1", "--skip", "--backend", b.base])).rejects.toThrow("give answers or --skip, not both");
    } finally {
      b.stop();
    }
    const quiet = fake({ one: detail(sprout({ status: "researching" })) });
    try {
      await expect(run(incubatorCommand, ["answer", "sp_0123456789ab", "1", "--backend", quiet.base])).rejects.toThrow("this project has no open questions");
      expect(quiet.seen.filter((r) => r.method === "POST")).toEqual([]);
    } finally {
      quiet.stop();
    }
  });

  test("resume, resume --retry, stop and dismiss call the routes the sheet's buttons do", async () => {
    const b = fake();
    try {
      const { out } = await run(incubatorCommand, ["resume", "sp_0123456789ab", "--backend", b.base]);
      expect(out).toEqual(["sp_0123456789ab  queued      a coin counter"]);
      // a flag before the id is not the id
      await run(incubatorCommand, ["resume", "--retry", "sp_0123456789ab", "--backend", b.base]);
      await run(incubatorCommand, ["stop", "sp_0123456789ab", "--backend", b.base]);
      const dismissed = await run(incubatorCommand, ["dismiss", "sp_0123456789ab", "--backend", b.base]);
      expect(dismissed.out).toEqual(["sp_0123456789ab is off the list; its seed, inputs and vault note stay"]);
      expect(b.seen.map((r) => [r.method, r.path, r.id, r.json])).toEqual([
        ["POST", "/api/incubator/resume", "sp_0123456789ab", { choice: "continue" }],
        ["POST", "/api/incubator/resume", "sp_0123456789ab", { choice: "retry" }],
        ["POST", "/api/incubator/stop", "sp_0123456789ab", {}],
        ["DELETE", "/api/incubator", "sp_0123456789ab", undefined],
      ]);
      await expect(run(incubatorCommand, ["stop", "--backend", b.base])).rejects.toThrow("usage: canopy incubator stop <id>");
    } finally {
      b.stop();
    }
  });

  test("add sends words, links and files as the intake form, and refuses a repo or an unknown flag", async () => {
    const b = fake();
    try {
      await run(incubatorCommand, ["add", "sp_0123456789ab", "also", "dimes", "--url", "https://example.com/spec", "--file", memo, "--backend", b.base]);
      expect(b.seen.map((r) => [r.method, r.path, r.id, r.form])).toEqual([
        ["POST", "/api/incubator/input", "sp_0123456789ab", { text: ["also dimes"], url: ["https://example.com/spec"], file: ["file:memo.md:count the quarters"], via: ["cli"] }],
      ]);
      await expect(run(incubatorCommand, ["add", "sp_0123456789ab", "--repo", "https://github.com/a/b", "--backend", b.base])).rejects.toThrow("unknown flag --repo");
      await expect(run(incubatorCommand, ["add", "sp_0123456789ab", "--backend", b.base])).rejects.toThrow("give words, --file or --url");
    } finally {
      b.stop();
    }
  });

  test("handoff --yes names the whole head the short one show printed stands for; --no gives the reason", async () => {
    const b = fake({ one: detail(sprout({ status: "approving", handOff: REVIEW })) });
    try {
      await run(incubatorCommand, ["handoff", "sp_0123456789ab", "--yes", "0123456789ab", "--backend", b.base]);
      await run(incubatorCommand, ["handoff", "sp_0123456789ab", "--no", "not", "this", "week", "--backend", b.base]);
      expect(b.seen.filter((r) => r.method === "POST").map((r) => r.json)).toEqual([
        { approve: true, head: REVIEW.head },
        { approve: false, head: "", reason: "not this week" },
      ]);
      await expect(run(incubatorCommand, ["handoff", "sp_0123456789ab", "--yes", "--backend", b.base])).rejects.toThrow("--yes takes the head show printed");
      await expect(run(incubatorCommand, ["handoff", "sp_0123456789ab", "--backend", b.base])).rejects.toThrow("usage: canopy incubator handoff");
    } finally {
      b.stop();
    }
  });

  test("show prints the questions, the wait and the link at the public origin; list says why a queued project waits", async () => {
    const b = fake({ stages: AWAY, backends: { self: "mini", backends: [{ name: "mini", public: "https://canopy.example" }] }, one: detail(sprout()), list: [sprout()] });
    try {
      const shown = await run(incubatorCommand, ["show", "sp_0123456789ab", "--backend", b.base]);
      expect(shown.out).toContain("waiting: the stage runner is not answering");
      expect(shown.out.at(-1)).toBe("https://canopy.example/?view=incubator&sprout=sp_0123456789ab");
      const listed = await run(incubatorCommand, ["list", "--backend", b.base]);
      expect(listed.out).toEqual(["sp_0123456789ab  queued      a coin counter (waiting: the stage runner is not answering)"]);
    } finally {
      b.stop();
    }
  });
});
