/**
 * One page, two backends: two real servers on scratch roots, each with a
 * checkout of the same remote at `proj` and B with a repo of its own, driven
 * through the ui's api layer with a registry that names both. Every call for
 * a B id must reach B with the plain id, and everything B answers must come
 * back under B's name. Shells are plain ptys (`CANOPY_TMUX=0`), so the two
 * servers cannot meet on one tmux server through the shared config dir.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LogEntry, Repo, ScanResult, ServerEvent, TermInfo } from "../core/types";
import { startServer } from "./index";

/* The ui modules are written against the DOM and this program is not, and
   the server code does not typecheck under the DOM's lib. So they are
   loaded at run time, behind the few signatures this file uses; ui/src's
   own tests typecheck them for real. */
interface Ui {
  api: {
    tree: (b?: string) => Promise<ScanResult>;
    rescan: (b?: string) => Promise<ScanResult>;
    log: (id: string) => Promise<LogEntry[]>;
    stage: (id: string, file: string, unstage: boolean) => Promise<Repo>;
    terms: (b?: string) => Promise<TermInfo[]>;
    endTerm: (id: string) => Promise<{ ok: true }>;
  };
  onBackendSignal: (fn: () => void) => void;
  readFrame: (b: string, data: string) => ServerEvent | null;
  socketUrl: (b: string, path: string) => string;
  split: (reg: Reg, id: string) => [string, string];
  joinRepos: (repos: readonly Repo[], names: readonly string[], split: (id: string) => [string, string]) => { checkouts: Repo[] }[];
  registry: () => Reg;
  setRegistry: (home: string, names: string[]) => void;
  setBase: (name: string, base: string) => void;
}
interface Reg {
  home: string;
  names: readonly string[];
}

async function loadUi(): Promise<Ui> {
  const at = (file: string): string => new URL(`../../ui/src/${file}`, import.meta.url).href;
  const [api, backends, checkouts, registry] = await Promise.all(
    ["api.ts", "backends.ts", "checkouts.ts", "registry.ts"].map((f) => import(at(f)) as Promise<Record<string, unknown>>),
  );
  return { ...api, ...backends, ...checkouts, ...registry } as unknown as Ui;
}

let ui: Ui;

let scratch: string;
const previous: Record<string, string | undefined> = {};
let serverA: { port: number; stop: () => void };
let serverB: { port: number; stop: () => void };

const SHELL = "fedcba9876543210fedcba9876543210";

/** a repo at `dir` with one commit and `origin` set, when given */
async function makeRepo(dir: string, subject: string, origin?: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  await Bun.$`git -C ${dir} init -q -b main`.quiet();
  await writeFile(join(dir, "README.md"), `${subject}\n`);
  await Bun.$`git -C ${dir} add README.md`.quiet();
  await Bun.$`git -C ${dir} -c user.name=t -c user.email=t@t commit -q -m ${subject}`.quiet();
  if (origin) await Bun.$`git -C ${dir} remote add origin ${origin}`.quiet();
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-multi-"));
  for (const k of ["CANOPY_CONFIG_DIR", "CANOPY_TMUX"]) previous[k] = process.env[k];
  const config = join(scratch, "config");
  await mkdir(config, { recursive: true });
  // the shared remote below is not real; no background fetch should try it
  await writeFile(join(config, "config.json"), JSON.stringify({ fetch: false }));
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_TMUX"] = "0";

  const origin = "https://github.com/o/proj";
  const rootA = join(scratch, "a");
  const rootB = join(scratch, "b");
  await makeRepo(join(rootA, "proj"), "made on a", origin);
  await makeRepo(join(rootB, "proj"), "made on b", origin);
  await makeRepo(join(rootB, "only-b"), "only on b");
  await writeFile(join(rootB, "proj", "new.txt"), "new\n");

  serverA = await startServer({ root: rootA, port: 0, chan: null });
  serverB = await startServer({ root: rootB, port: 0, chan: null });
  ui = await loadUi();
  ui.setRegistry("a", ["a", "b"]);
  ui.setBase("a", `http://127.0.0.1:${serverA.port}`);
  ui.setBase("b", `http://127.0.0.1:${serverB.port}`);
});

afterAll(async () => {
  if (ui) {
    ui.setRegistry("", [""]);
    ui.setBase("a", "");
    ui.setBase("b", "");
    ui.onBackendSignal(() => {});
  }
  serverA?.stop();
  serverB?.stop();
  for (const [k, v] of Object.entries(previous)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

describe("two backends behind one page", () => {
  test("each tree comes back under its backend's name, and one remote is one card", async () => {
    const a = await ui.api.tree("a");
    const b = await ui.api.tree("b");
    expect(a.repos.map((r) => r.id)).toEqual(["proj"]);
    expect(b.repos.map((r) => r.id).sort()).toEqual(["b|only-b", "b|proj"]);
    expect(b.sources.map((s) => s.id)).toEqual(["b|launch"]);

    const cards = ui.joinRepos([...a.repos, ...b.repos], ["a", "b"], (id) => ui.split(ui.registry(), id));
    const proj = cards.find((c) => c.checkouts.some((r) => r.id === "proj"));
    expect(proj?.checkouts.map((r) => r.id)).toEqual(["proj", "b|proj"]);
    const only = cards.find((c) => c.checkouts.some((r) => r.id === "b|only-b"));
    expect(only?.checkouts.map((r) => r.id)).toEqual(["b|only-b"]);
    expect(cards).toHaveLength(2);
  });

  test("a foreign checkout's log and stage reach that checkout", async () => {
    expect((await ui.api.log("b|proj")).map((e) => e.subject)).toEqual(["made on b"]);
    expect((await ui.api.log("proj")).map((e) => e.subject)).toEqual(["made on a"]);

    const staged = await ui.api.stage("b|proj", "new.txt", false);
    expect(staged.id).toBe("b|proj");
    expect(staged.status?.files).toEqual([expect.objectContaining({ path: "new.txt", index: "A", untracked: false })]);
  });

  test("a shell opened on b is b's alone and ends through its qualified id", async () => {
    expect(await ui.api.terms("b")).toEqual([]);
    const url = ui.socketUrl(
      "b",
      "/api/term?" + new URLSearchParams({ id: "proj", term: SHELL, place: "strip", cols: "80", rows: "24" }).toString(),
    );
    expect(url.startsWith(`ws://127.0.0.1:${serverB.port}/api/term?`)).toBe(true);
    const ws = new WebSocket(url);
    ws.binaryType = "arraybuffer";
    const closed = new Promise<void>((resolve) => {
      ws.onclose = () => resolve();
    });
    await new Promise<void>((resolve, reject) => {
      ws.onmessage = (e: MessageEvent<ArrayBuffer | string>) => {
        if (typeof e.data !== "string") resolve();
      };
      ws.onerror = () => reject(new Error("the socket failed"));
    });

    expect((await ui.api.terms("b")).map((t) => [t.id, t.repoId])).toEqual([[`b|${SHELL}`, "b|proj"]]);
    expect(await ui.api.terms("a")).toEqual([]);

    await ui.api.endTerm(`b|${SHELL}`);
    await closed;
    expect(await ui.api.terms("b")).toEqual([]);
  });

  test("b's event stream names b's repos under b", async () => {
    const stop = new AbortController();
    const res = await fetch(`http://127.0.0.1:${serverB.port}/api/events`, { signal: stop.signal });
    const body = res.body;
    if (!body) throw new Error("the stream has no body");
    const reader = body.getReader();
    const dec = new TextDecoder();
    // the stream is registered once the response is here; a rescan now is heard
    await ui.api.rescan("b");
    let buf = "";
    let scan: ServerEvent | null = null;
    const deadline = Date.now() + 15_000;
    try {
      while (!scan && Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buf += dec.decode(value, { stream: true });
        const lines = buf.split("\n");
        buf = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data:")) continue;
          const ev = ui.readFrame("b", line.slice(5).trim());
          if (ev?.type === "scan") scan = ev;
        }
      }
    } finally {
      stop.abort();
    }
    if (scan?.type !== "scan") throw new Error("no scan frame arrived");
    expect(scan.result.repos.map((r) => r.id)).toContain("b|proj");
  });
});
