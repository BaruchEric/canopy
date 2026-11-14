import { expect, test } from "bun:test";
import type { CoordTask, Run } from "../core/types";
import { cardLines, coordinatorCommand, coordinatorLines, NEW_GOAL_HINT, newGoalForm, newGoalRefusal, parseNewArgs } from "./coordinator";

const card = (id: string, over: Partial<CoordTask> = {}): CoordTask => ({ id, title: `card ${id}`, repo: "playground/x", note: "", action: "propose", state: "proposed", ...over });
const coord = (id: string, over: Partial<Run> = {}): Run => ({ id, action: "coordinate", status: "working", repoId: "playground/x", note: "ship the thing\nsecond line", tasks: [], ...over }) as Run;

test("coordinatorLines lists only live coordinators: id, repo, held, counts, goal's first line", () => {
  const runs = [
    coord("c1", { held: true, tasks: [card("t1"), card("t2", { state: "running" })] }),
    coord("c2", { status: "done" }),
    { ...coord("r1"), action: "ask" } as Run,
  ];
  expect(coordinatorLines(runs)).toEqual(["c1  playground/x  held  2 cards · 1 proposed, 1 running  ship the thing"]);
  expect(coordinatorLines([coord("c3")])).toEqual(["c3  playground/x  0 cards  ship the thing"]);
});

test("cardLines pads the columns: id, state, repo, loadout, workflow, after, title", () => {
  const tasks = [
    card("t1", { state: "queued", title: "sync the spec", workflow: "spec", after: ["t2"], equip: { loadout: "quick" } }),
    card("t2", { title: "write it" }),
  ];
  expect(cardLines(coord("c1", { tasks }))).toEqual([
    "t1  queued    playground/x  quick  spec  after t2  sync the spec",
    "t2  proposed  playground/x"+" ".repeat(25)+"write it",
  ]);
  expect(cardLines(coord("c1"))).toEqual([]);
});

test("cardLines shows the goal's files a card takes, after the cards it waits for", () => {
  const tasks = [card("t1", { title: "favicon", files: ["shot.png", "notes.md"] }), card("t2", { title: "other" })];
  expect(cardLines(coord("c1", { tasks }))).toEqual([
    "t1  proposed  playground/x  files: shot.png, notes.md  favicon",
    "t2  proposed  playground/x" + " ".repeat(29) + "other",
  ]);
});

test("cardLines puts the tree a card runs in after the files column", () => {
  const tasks = [card("t1", { title: "tree work", files: ["a.md"], tree: "feat/x" }), card("t2", { title: "other" })];
  expect(cardLines(coord("c1", { tasks }))).toEqual([
    "t1  proposed  playground/x  files: a.md  in tree feat/x  tree work",
    "t2  proposed  playground/x" + " ".repeat(31) + "other",
  ]);
});

const serve = (posted: { path: string; body: unknown }[], runs: Run[]) =>
  Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: async (req) => {
    const path = new URL(req.url).pathname;
    if (req.method === "GET") return Response.json(runs);
    posted.push({ path, body: await req.json() });
    return Response.json({ ok: true, held: true, tasks: [] });
  } });

async function run(argv: string[], server: ReturnType<typeof serve>): Promise<string[]> {
  const log = console.log;
  const lines: string[] = [];
  try {
    console.log = (line: unknown) => { lines.push(String(line)); };
    await coordinatorCommand([...argv, "--backend", `http://127.0.0.1:${server.port}`], { fail: (m) => { throw Error(m); } });
  } finally {
    console.log = log;
    server.stop(true);
  }
  return lines;
}

test("hold and resume post {run, held}; start posts ids or none", async () => {
  const posted: { path: string; body: unknown }[] = [];
  await run(["hold", "c1"], serve(posted, []));
  await run(["resume", "c1"], serve(posted, []));
  await run(["start", "c1"], serve(posted, []));
  await run(["start", "c1", "t1", "t2"], serve(posted, []));
  expect(posted).toEqual([
    { path: "/api/coordinator/hold", body: { run: "c1", held: true } },
    { path: "/api/coordinator/hold", body: { run: "c1", held: false } },
    { path: "/api/coordinator/start", body: { run: "c1" } },
    { path: "/api/coordinator/start", body: { run: "c1", ids: ["t1", "t2"] } },
  ]);
});

test("coordinator <run> prints its cards; an unknown run fails", async () => {
  const runs = [coord("c1", { tasks: [card("t1")] })];
  expect(await run(["c1"], serve([], runs))).toEqual(["t1  proposed  playground/x  card t1"]);
  await expect(run(["nope"], serve([], runs))).rejects.toThrow("no live coordinator nope");
});

test("parseNewArgs reads the goal, repeated --repo and --file, and model and effort", () => {
  expect(parseNewArgs(["fix the cart", "--repo", "web/shop", "--repo", "canopy", "--file", "a.png", "--model", "sonnet"])).toEqual({
    goal: "fix the cart",
    repos: ["web/shop", "canopy"],
    files: ["a.png"],
    model: "sonnet",
  });
  expect(parseNewArgs(["--effort", "high", "ship it"])).toEqual({ goal: "ship it", repos: [], files: [], effort: "high" });
  expect(parseNewArgs(["a", "goal", "words"])).toEqual({ goal: "a goal words", repos: [], files: [] });
});

test("parseNewArgs refuses no goal, a flag without a value and an unknown flag", () => {
  const none = parseNewArgs([]);
  const text = "error" in none ? none.error : "";
  expect(text.startsWith("usage:")).toBe(true);
  expect(text).toContain("canopy coordinator new <goal>");
  expect(parseNewArgs(["goal", "--repo"])).toEqual({ error: "--repo needs a value" });
  expect(parseNewArgs(["goal", "--wat", "x"])).toEqual({ error: "unknown flag --wat" });
});

test("newGoalForm puts goal, repos[], files[], model and effort in the form", async () => {
  const form = newGoalForm({ goal: "g", repos: ["a", "b"], files: [{ name: "x.txt", data: new TextEncoder().encode("hi") }], model: "opus" });
  expect(form.get("goal")).toBe("g");
  expect(form.getAll("repos[]")).toEqual(["a", "b"]);
  const files = form.getAll("files[]");
  expect(files.length).toBe(1);
  const file = files[0] as File;
  expect(file.name).toBe("x.txt");
  expect(await file.text()).toBe("hi");
  expect(form.get("model")).toBe("opus");
  expect(form.has("effort")).toBe(false);
});

test("newGoalRefusal adds the --on hint to a 409 when no backend was named, and nothing else", () => {
  const why = "the coordinator runs only where an isolated coordinator runner is set up (docs/deploy.md, The coordinator)";
  expect(newGoalRefusal(why, 409, false)).toBe(`${why}\n${NEW_GOAL_HINT}`);
  expect(NEW_GOAL_HINT).toContain("--on <backend>");
  expect(newGoalRefusal(why, 409, true)).toBe(why);
  expect(newGoalRefusal("write the goal first", 400, false)).toBe("write the goal first");
});

test("coordinator new: a refusal from the home backend names --on, and one from a named backend does not", async () => {
  const refuse = () =>
    Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json({ error: "the coordinator runs only where an isolated coordinator runner is set up" }, { status: 409 }) });
  const failOf = async (argv: string[]): Promise<string> => {
    try {
      await coordinatorCommand(argv, { fail: (m) => { throw Error(m); } });
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
    return "";
  };
  const home = refuse();
  const saved = process.env["CANOPY_API"];
  process.env["CANOPY_API"] = `http://127.0.0.1:${home.port}`;
  try {
    expect(await failOf(["new", "ship it"])).toBe(`the coordinator runs only where an isolated coordinator runner is set up\n${NEW_GOAL_HINT}`);
  } finally {
    if (saved === undefined) delete process.env["CANOPY_API"];
    else process.env["CANOPY_API"] = saved;
    home.stop(true);
  }
  const named = refuse();
  try {
    expect(await failOf(["new", "ship it", "--backend", `http://127.0.0.1:${named.port}`])).toBe("the coordinator runs only where an isolated coordinator runner is set up");
  } finally {
    named.stop(true);
  }
});
