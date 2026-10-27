/** The harness mark is seeded once per backend, written by its own route,
 *  and rides through every repo broadcast and rescan. */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/store";
import { startServer } from "./index";

type RepoMark = { id: string; path: string; harness?: true };
type RepoEvent = { type: "repo"; repo: RepoMark };

let scratch = "";
let root = "";
let server: Awaited<ReturnType<typeof startServer>> | undefined;
let saved: string | undefined;

const url = (path: string): string => {
  if (!server) throw new Error("server has not started");
  return `http://127.0.0.1:${server.port}${path}`;
};

const mark = (id: string, body: unknown): Promise<Response> =>
  fetch(url(`/api/repos/harness?id=${encodeURIComponent(id)}`), {
    method: "POST",
    body: JSON.stringify(body) ?? "null",
  });

function isRepoMark(value: unknown): value is RepoMark {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return "id" in value && typeof value.id === "string" &&
    "path" in value && typeof value.path === "string" &&
    (!("harness" in value) || value.harness === undefined || value.harness === true);
}

function isRepoEvent(value: unknown): value is RepoEvent {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  return "type" in value && value.type === "repo" && "repo" in value && isRepoMark(value.repo);
}

async function tree(): Promise<RepoMark[]> {
  const response = await fetch(url("/api/tree"));
  const value: unknown = await response.json();
  if (value === null || typeof value !== "object" || Array.isArray(value) || !("repos" in value) || !Array.isArray(value.repos)) {
    throw new Error("tree response did not contain repos");
  }
  const repos: RepoMark[] = [];
  for (const repo of value.repos) {
    if (!isRepoMark(repo)) throw new Error("tree response contained an invalid repo mark");
    repos.push(repo);
  }
  return repos;
}

const marked = async (): Promise<string[]> =>
  (await tree()).filter((repo) => repo.harness).map((repo) => repo.id).sort();

async function repoEvent(action: () => Promise<unknown>, id: string): Promise<RepoMark> {
  const controller = new AbortController();
  const response = await fetch(url("/api/events"), { signal: controller.signal });
  const reader = response.body?.getReader();
  if (!reader) throw new Error("events response has no stream");
  const decoder = new TextDecoder();
  try {
    const hello = await reader.read();
    if (hello.done) throw new Error("events stream ended before hello");
    await action();
    let buffer = "";
    for (;;) {
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const data = frame.split("\n").find((line) => line.startsWith("data: "));
        if (data) {
          const event: unknown = JSON.parse(data.slice(6));
          if (isRepoEvent(event) && event.repo.id === id) return event.repo;
        }
        boundary = buffer.indexOf("\n\n");
      }
      const next = await reader.read();
      if (next.done) throw new Error("events stream ended before the repo event");
      buffer += decoder.decode(next.value);
    }
  } finally {
    controller.abort();
  }
}

async function packageRepo(name: string, contents: string): Promise<void> {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(join(path, "package.json"), contents);
  await Bun.$`git -C ${path} init -q`.quiet();
}

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-harness-"));
  saved = process.env["CANOPY_CONFIG_DIR"];
  process.env["CANOPY_CONFIG_DIR"] = join(scratch, "config");
  root = join(scratch, "root");
  await mkdir(root, { recursive: true });
  root = await realpath(root);
  await packageRepo("app", '{"name":"app"}');
  await packageRepo("canopy", '{"name":"canopy"}');
  await packageRepo("broken", "not json");
  await packageRepo("nameless", "{}");
  server = await startServer({ root, port: 0, harnesses: [] });
});

afterAll(async () => {
  if (server) await server.stop();
  if (saved === undefined) delete process.env["CANOPY_CONFIG_DIR"];
  else process.env["CANOPY_CONFIG_DIR"] = saved;
  if (scratch) await rm(scratch, { recursive: true, force: true });
});

describe("the harness mark", () => {
  test("the first start marks canopy's checkout and completes the seed past broken or nameless manifests", async () => {
    expect(await marked()).toEqual(["canopy"]);
    expect((await loadConfig()).harness).toEqual([join(root, "canopy")]);
  });

  test("refuses a body without a boolean", async () => {
    expect((await mark("app", {})).status).toBe(400);
    expect((await mark("app", { harness: "yes" })).status).toBe(400);
    expect((await mark("missing", { harness: true })).status).toBe(404);
  });

  test("marks through the repo route, broadcasts the mark, and keeps it across a rescan", async () => {
    let response: Response | undefined;
    const event = await repoEvent(async () => {
      response = await mark("app", { harness: true });
    }, "app");
    expect(response?.status).toBe(200);
    expect(event.harness).toBe(true);
    expect((await loadConfig()).harness).toEqual([join(root, "canopy"), join(root, "app")]);
    await fetch(url("/api/rescan"), { method: "POST" });
    expect(await marked()).toEqual(["app", "canopy"]);

    const unmarked = await mark("canopy", { harness: false });
    expect(unmarked.status).toBe(200);
    const removed: unknown = await unmarked.json();
    expect(isRepoMark(removed) && removed.harness).toBeUndefined();
    await mark("app", { harness: false });
    expect(await marked()).toEqual([]);
    expect((await loadConfig()).harness).toEqual([]);
  });

  test("a later start preserves an explicit empty list instead of seeding again", async () => {
    if (!server) throw new Error("server has not started");
    await server.stop();
    server = await startServer({ root, port: 0, harnesses: [] });
    expect(await marked()).toEqual([]);
    expect((await loadConfig()).harness).toEqual([]);
  });
});
