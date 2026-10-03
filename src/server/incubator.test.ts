/**
 * The incubator's routes on a real server, with autostart off so no agent
 * runs: intake (text, a voice memo, a markdown file sent the way a browser
 * often sends one, refusals), the seed landing in the scan, answers, stop,
 * resume and dismiss, the events, clarify kept out of every repo's list, and
 * a second server on the same config dir, which lists but takes nothing in.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import type { ScanResult, ServerEvent, Sprout, SproutDetail, WorkflowEntry } from "../core/types";
import { startServer } from "./index";
import { clipLabel, notKeeping, sproutFlow } from "./incubator";

let scratch: string;
let root: string;
let previous: string | undefined;
let server: { port: number; stop: () => void };
const url = (p: string) => `http://127.0.0.1:${server.port}${p}`;

/** A server for these tests, only once CANOPY_CONFIG_DIR is set and under
 *  the temp dir: every server builds an Incubator over that dir's
 *  incubator/ folder, and a test must never write the real one. */
async function scratchServer(opts: Parameters<typeof startServer>[0]): Promise<{ port: number; stop: () => void }> {
  const dir = process.env["CANOPY_CONFIG_DIR"];
  if (!dir) throw new Error("CANOPY_CONFIG_DIR is not set; refusing to start a server on the real config");
  await mkdir(dir, { recursive: true });
  const tmp = await realpath(tmpdir());
  if (!(await realpath(dir)).startsWith(tmp + sep)) throw new Error(`CANOPY_CONFIG_DIR is not under ${tmp}: ${dir}`);
  return startServer(opts);
}

async function until(pred: () => boolean | Promise<boolean>, what: string, ms = 15_000): Promise<void> {
  const start = Date.now();
  while (!(await pred())) {
    if (Date.now() - start > ms) throw new Error(`gave up waiting for ${what}`);
    await Bun.sleep(50);
  }
}

const post = (path: string, form: FormData) => fetch(url(path), { method: "POST", body: form });
const postJson = (path: string, body: unknown) =>
  fetch(url(path), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const detail = async (id: string) => (await (await fetch(url(`/api/incubator/one?id=${id}`))).json()) as SproutDetail;

function form(fields: Record<string, string | Blob | [Blob, string]>): FormData {
  const f = new FormData();
  for (const [k, v] of Object.entries(fields)) {
    if (Array.isArray(v)) f.append(k, v[0], v[1]);
    else f.append(k, v);
  }
  return f;
}

/** the first event `match` takes after `act`; other sprouts' events, which
 *  earlier tests' background work still sends, are passed over */
async function eventAfter(match: (ev: ServerEvent) => boolean, act: () => Promise<unknown>): Promise<ServerEvent> {
  const ctl = new AbortController();
  const res = await fetch(url("/api/events"), { signal: ctl.signal });
  const body = res.body;
  if (!body) throw new Error("no stream");
  const reader = body.getReader();
  const dec = new TextDecoder();
  let buf = dec.decode((await reader.read()).value);
  await act();
  try {
    for (;;) {
      for (const chunk of buf.split("\n\n")) {
        const data = chunk.split("\n").find((l) => l.startsWith("data: "));
        if (!data) continue;
        const ev = JSON.parse(data.slice(6)) as ServerEvent;
        if (match(ev)) return ev;
      }
      const { value, done } = await reader.read();
      if (done) throw new Error("the stream ended");
      buf += dec.decode(value);
    }
  } finally {
    ctl.abort();
  }
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-inc-"));
  previous = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  await Bun.$`mkdir -p ${join(root, "app")} && git -C ${join(root, "app")} init -q`.quiet();
  process.env["VERCEL_TOKEN"] = "tok_test";
  server = await scratchServer({
    root,
    port: 0,
    chan: null,
    harnesses: ["claude"],
    // no stage starts here (autostart is off); stage: null keeps a shell's CANOPY_STAGE_SOCKET out of it
    incubator: { autostart: false, transcribe: async () => "count the quarters", notes: null, ship: null, stage: null },
  });
});

test("the Vercel token leaves canopy's env once the server has read it", () => {
  expect(process.env["VERCEL_TOKEN"]).toBeUndefined();
});

afterAll(async () => {
  server.stop();
  delete process.env["VERCEL_TOKEN"];
  if (previous === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = previous;
  await rm(scratch, { recursive: true, force: true });
});

describe("intake", () => {
  test("an idea answers at once, then its seed is a repo in the scan with one commit by canopy", async () => {
    const res = await post("/api/incubator", form({ text: "A coin counter for the laundromat", url: "https://example.com/coins" }));
    expect(res.status).toBe(201);
    const s = (await res.json()) as Sprout;
    expect(s.status).toBe("queued");
    expect(s.repoId).toBe("_incubator/coin-counter-laundromat");
    await until(async () => ((await (await fetch(url("/api/tree"))).json()) as ScanResult).repos.some((r) => r.id === s.repoId), "the seed in the scan");
    await until(async () => (await detail(s.id)).sprout.prepared, "the sprout prepared");
    expect(existsSync(join(root, "_incubator/coin-counter-laundromat/.canopy/brief.md"))).toBe(true);
    const log = await Bun.$`git -C ${join(root, "_incubator/coin-counter-laundromat")} log --format=%an%x09%s`.text();
    expect(log.trim()).toMatch(/^canopy\tseed: a new project from the incubator$/);
    const d = await detail(s.id);
    expect(d.brief).toContain("# A coin counter for the laundromat");
    expect(d.inputsIndex).toContain("- [2] url 002-link.url: not summarized yet");
    const list = (await (await fetch(url("/api/incubator"))).json()) as Sprout[];
    expect(list.map((x) => x.id)).toContain(s.id);
  });

  test("a voice memo with its codec named comes in as audio and gets its transcript", async () => {
    const memo = new Blob([new Uint8Array([1, 2, 3])], { type: "audio/webm;codecs=opus" });
    const res = await post("/api/incubator", form({ file: [memo, "voice.webm"] }));
    expect(res.status).toBe(201);
    const s = (await res.json()) as Sprout;
    expect(s.inputs[0]?.type).toBe("audio/webm");
    await until(async () => (await detail(s.id)).sprout.inputs.some((e) => e.kind === "transcript"), "the transcript");
    const t = (await detail(s.id)).sprout.inputs.find((e) => e.kind === "transcript");
    // the words stay in the inputs folder, out of the record and the index
    expect(t?.summary).toBe("");
  });

  test("a markdown file sent as octet-stream is taken as markdown", async () => {
    const md = new Blob(["# notes\n"], { type: "application/octet-stream" });
    const res = await post("/api/incubator", form({ file: [md, "notes.md"] }));
    expect(res.status).toBe(201);
    expect(((await res.json()) as Sprout).inputs[0]?.type).toBe("text/markdown");
  });

  test("a zip, a JSON body, an empty form and an oversized file are refused", async () => {
    const zip = new Blob([new Uint8Array([1])], { type: "application/zip" });
    expect((await post("/api/incubator", form({ file: [zip, "a.zip"] }))).status).toBe(415);
    expect((await postJson("/api/incubator", { text: "x" })).status).toBe(415);
    expect((await post("/api/incubator", form({ text: " " }))).status).toBe(400);
    const big = new Blob([new Uint8Array(25 * 1024 * 1024 + 1)], { type: "image/png" });
    expect((await post("/api/incubator", form({ file: [big, "big.png"] }))).status).toBe(413);
  });

  test("a new sprout is broadcast", async () => {
    const ev = await eventAfter((e) => e.type === "incubator" && e.sprout.title === "a broadcast idea", () => post("/api/incubator", form({ text: "a broadcast idea" })));
    expect(ev.type === "incubator" && ev.sprout.title).toBe("a broadcast idea");
  });
});

describe("the rest of the routes", () => {
  test("an unknown or malformed id is a 404 for the detail", async () => {
    expect((await fetch(url("/api/incubator/one?id=sp_ffffffffffff"))).status).toBe(404);
    expect((await fetch(url("/api/incubator/one?id=nope"))).status).toBe(404);
  });

  test("answers need open questions; an unknown id is a 404", async () => {
    const s = (await (await post("/api/incubator", form({ text: "answers idea" }))).json()) as Sprout;
    expect((await postJson(`/api/incubator/answer?id=${s.id}`, { skip: true })).status).toBe(409);
    expect((await postJson("/api/incubator/answer?id=sp_ffffffffffff", { answers: {} })).status).toBe(404);
    expect((await postJson(`/api/incubator/answer?id=${s.id}`, { answers: { q: 1 } })).status).toBe(400);
  });

  test("more input takes no repo", async () => {
    const s = (await (await post("/api/incubator", form({ text: "input idea" }))).json()) as Sprout;
    expect((await post(`/api/incubator/input?id=${s.id}`, form({ repo: "https://github.com/a/b" }))).status).toBe(400);
    const res = await post(`/api/incubator/input?id=${s.id}`, form({ text: "one more thing" }));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Sprout).inputs.map((e) => e.n)).toEqual([1, 2]);
  });

  test("a parked project resumes: a clone that failed is tried again", async () => {
    // nothing listens on port 1, so the clone fails at once and the sprout parks
    const res = await post("/api/incubator", form({ text: "resume idea", repo: "https://127.0.0.1:1/canopy-test/nothing.git" }));
    expect(res.status).toBe(201);
    const s = (await res.json()) as Sprout;
    // a text-only sprout stays queued with autostart off, so it is surely not parked
    const queued = (await (await post("/api/incubator", form({ text: "queued idea" }))).json()) as Sprout;
    expect((await postJson(`/api/incubator/resume?id=${queued.id}`, { choice: "retry" })).status).toBe(409);
    await until(async () => (await detail(s.id)).sprout.status === "parked", "the sprout parked");
    expect((await detail(s.id)).sprout.parked).toStartWith("could not make the seed: git clone failed");
    const resumed = await postJson(`/api/incubator/resume?id=${s.id}`, { choice: "retry" });
    expect(resumed.status).toBe(200);
    const back = (await resumed.json()) as Sprout;
    expect(back.status).toBe("queued");
    expect(back.parked).toBeUndefined();
    // and it parks again on the same clone, which settles its work before the next test
    await until(async () => (await detail(s.id)).sprout.status === "parked", "the sprout parked again");
  });

  test("stop, then dismiss, which keeps the inputs under .dismissed", async () => {
    const s = (await (await post("/api/incubator", form({ text: "stop idea" }))).json()) as Sprout;
    expect((await fetch(url(`/api/incubator?id=${s.id}`), { method: "DELETE" })).status).toBe(409);
    expect((await postJson(`/api/incubator/resume?id=${s.id}`, { choice: "sideways" })).status).toBe(400);
    const stopped = (await (await postJson(`/api/incubator/stop?id=${s.id}`, {})).json()) as Sprout;
    expect(stopped.status).toBe("stopped");
    const ev = await eventAfter((e) => e.type === "incubator-gone" && e.id === s.id, () => fetch(url(`/api/incubator?id=${s.id}`), { method: "DELETE" }));
    expect(ev.type === "incubator-gone" && ev.id).toBe(s.id);
    expect(existsSync(join(scratch, "config/incubator/.dismissed", s.id))).toBe(true);
    const list = (await (await fetch(url("/api/incubator"))).json()) as Sprout[];
    expect(list.some((x) => x.id === s.id)).toBe(false);
  });

  test("clarify is in no repo's list of workflows", async () => {
    const list = (await (await fetch(url("/api/repos/workflows?id=app"))).json()) as WorkflowEntry[];
    expect(list.some((e) => (e.ok ? e.workflow.name : e.name) === "clarify")).toBe(false);
  });

  test("the flow route and the fleet route refuse clarify", async () => {
    const flow = await postJson("/api/repos/flow?id=app", { workflow: "clarify", note: "x" });
    expect(flow.status).toBe(400);
    expect(((await flow.json()) as { error: string }).error).toBe("clarify runs only inside the incubator");
    const fleet = await postJson("/api/fleet", { workflow: "clarify", ids: ["app"], note: "x" });
    expect(fleet.status).toBe(400);
    expect(((await fleet.json()) as { error: string }).error).toBe("clarify runs only inside the incubator");
  });
});

describe("a server without the flows lock", () => {
  test("lists what the owner keeps and takes nothing in", async () => {
    const mine = (await (await fetch(url("/api/incubator"))).json()) as Sprout[];
    expect(mine.length).toBeGreaterThan(0);
    // the first server holds the lock, so this one, on the same config dir and root, does not
    const second = await scratchServer({ root, port: 0, chan: null, harnesses: ["claude"], incubator: { autostart: false, transcribe: null, notes: null } });
    const at = (p: string) => `http://127.0.0.1:${second.port}${p}`;
    try {
      const listed = (await (await fetch(at("/api/incubator"))).json()) as Sprout[];
      expect(listed.map((x) => x.id).sort()).toEqual(mine.map((x) => x.id).sort());
      const one = mine[0];
      if (!one) throw new Error("no sprout");
      const d = (await (await fetch(at(`/api/incubator/one?id=${one.id}`))).json()) as SproutDetail;
      expect(d.sprout.id).toBe(one.id);
      const refused = await fetch(at("/api/incubator"), { method: "POST", body: form({ text: "not here" }) });
      expect(refused.status).toBe(503);
      // the first server is this same process, holding the lock
      expect(((await refused.json()) as { error: string }).error).toBe(
        `this canopy is not keeping the incubator right now: canopy pid ${process.pid} keeps it for this config folder`,
      );
      expect((await fetch(at(`/api/incubator/input?id=${one.id}`), { method: "POST", body: form({ text: "more" }) })).status).toBe(503);
      expect((await fetch(at(`/api/incubator/stop?id=${one.id}`), { method: "POST" })).status).toBe(503);
    } finally {
      second.stop();
    }
  });
});

describe("intake limits", () => {
  test("more than 50 links or 50 files is refused", async () => {
    const links = new FormData();
    for (let i = 0; i < 51; i++) links.append(i % 2 ? "url" : "urls[]", `https://example.com/${i}`);
    const r1 = await post("/api/incubator", links);
    expect(r1.status).toBe(400);
    expect(((await r1.json()) as { error: string }).error).toBe("at most 50 links at a time");
    const files = new FormData();
    for (let i = 0; i < 51; i++) files.append(i % 2 ? "file" : "files[]", new Blob(["x"], { type: "text/plain" }), `n${i}.txt`);
    const r2 = await post("/api/incubator", files);
    expect(r2.status).toBe(400);
    expect(((await r2.json()) as { error: string }).error).toBe("at most 50 files at a time");
  });

  test("a long file name is cut to 200 characters with its extension kept", async () => {
    const name = `${"n".repeat(300)}.md`;
    const res = await post("/api/incubator", form({ file: [new Blob(["# notes\n"], { type: "" }), name] }));
    expect(res.status).toBe(201);
    const s = (await res.json()) as Sprout;
    expect(s.inputs[0]?.label).toBe(`${"n".repeat(197)}.md`);
    expect(s.inputs[0]?.type).toBe("text/markdown");
    expect(clipLabel("short.md")).toBe("short.md");
    expect(clipLabel("x".repeat(250))).toHaveLength(200);
  });
});

describe("who keeps the incubator", () => {
  test("each refusal says why, in words that hold for it", () => {
    expect(notKeeping({ kind: "starting" })).toBe("this canopy is not keeping the incubator right now: it is still taking its projects back; try again in a moment");
    expect(notKeeping({ kind: "elsewhere", pid: 42 })).toBe("this canopy is not keeping the incubator right now: canopy pid 42 keeps it for this config folder");
    expect(notKeeping({ kind: "unlocked" })).toBe("this canopy is not keeping the incubator right now: it could not lock the flows folder");
  });
  test("a flow on a seed is the sprout's to speak for, owned yet or not", () => {
    const none = () => false;
    expect(sproutFlow({ id: "f1", repoId: "_incubator/coins" }, none)).toBe(true);
    expect(sproutFlow({ id: "f2", repoId: "app" }, none)).toBe(false);
    expect(sproutFlow({ id: "f3", repoId: "app" }, (id) => id === "f3")).toBe(true);
    expect(sproutFlow({ id: "f4", repoId: "src:_incubator/x" }, none)).toBe(false);
  });
});
