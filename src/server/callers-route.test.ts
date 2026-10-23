/**
 * The caller check at the top of route() and the /api/auth routes, against
 * real servers on a scratch root, one per mode. Tokens a test needs are
 * minted into the scratch callers.json before its server starts, since the
 * server reads the file once. Plain ptys (`CANOPY_TMUX=0`), so nothing here
 * touches a tmux server.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HealthCheck } from "../core/types";
import { CallerBook } from "./callers";
import { COORD_REFUSAL, startServer } from "./index";

type Up = { port: number; stop: () => void | Promise<void>; lines: string[] };

let scratch: string;
const saved: Record<string, string | undefined> = {};
const ENV = ["CANOPY_CONFIG_DIR", "CANOPY_TMUX", "CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_ORIGINS", "CANOPY_CALLERS", "CANOPY_COORD_SOCKET", "CANOPY_COORD_API", "CANOPY_COORD_ROOT"];
const LISTED = "https://canopy-mac.example";
const EVIL = "https://evil.example";
/** The "shell" tokens below are minted as rangers: they hold the same rights
 *  (read, operate), and a server pruning at start-up drops a shell token
 *  whose shell it does not hold, which a pre-minted one never has. */
const TERM = "0123456789abcdef0123456789abcdef";

beforeAll(async () => {
  scratch = await mkdtemp(join(tmpdir(), "canopy-callers-"));
  for (const k of ENV) saved[k] = process.env[k];
  process.env["CANOPY_TMUX"] = "0";
  delete process.env["CANOPY_BIND"];
  delete process.env["CANOPY_PUBLIC_ORIGIN"];
  delete process.env["CANOPY_COORD_SOCKET"];
  delete process.env["CANOPY_COORD_API"];
  delete process.env["CANOPY_COORD_ROOT"];
  process.env["CANOPY_ORIGINS"] = LISTED;
  const repo = join(scratch, "root", "app");
  await Bun.$`mkdir -p ${repo} && git -C ${repo} init -q`.quiet();
});

afterAll(async () => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  await rm(scratch, { recursive: true, force: true });
});

/** A server in `mode` with its own config dir, the tokens `mint` makes
 *  already in its book, and what it printed while starting. */
async function up(name: string, mode: string, mint: (book: CallerBook) => void = () => {}): Promise<Up> {
  const config = join(scratch, name);
  process.env["CANOPY_CONFIG_DIR"] = config;
  process.env["CANOPY_CALLERS"] = mode;
  const book = new CallerBook({ file: join(config, "callers.json") });
  mint(book);
  await book.flush();
  const lines: string[] = [];
  const s = await startServer({ root: join(scratch, "root"), port: 0, callersLog: (line) => lines.push(line) });
  return { ...s, lines };
}

const call = (s: Up, path: string, init: RequestInit & { token?: string } = {}): Promise<Response> => {
  const { token, ...rest } = init;
  const headers = new Headers(rest.headers);
  if (token) headers.set("x-canopy-token", token);
  return fetch(`http://127.0.0.1:${s.port}${path}`, { ...rest, headers });
};

const post = (s: Up, path: string, body: unknown, token?: string): Promise<Response> =>
  call(s, path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), ...(token ? { token } : {}) });

type Refusal = { error: string; need: string };
type AuthInfo = { mode: string; refused: { count: number; recent: { kind: string; route: string }[] }; you: string; pending: { id: string }[] };

/** whether a websocket to `path` opens; closed again at once if it does */
async function opens(s: Up, path: string): Promise<boolean> {
  const ws = new WebSocket(`ws://127.0.0.1:${s.port}${path}`);
  const opened = await new Promise<boolean>((resolve) => {
    ws.onopen = () => resolve(true);
    ws.onerror = () => resolve(false);
    ws.onclose = () => resolve(false);
  });
  if (opened) ws.close();
  return opened;
}

describe("enforce", () => {
  let s: Up;
  let shell = "";
  let page = "";
  beforeAll(async () => {
    s = await up("enforce", "enforce", (book) => {
      shell = book.mint("ranger", { label: "a shell", term: TERM }).token;
      page = book.mint("page", { label: "a page" }).token;
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  test("a bare POST is refused with the right it needed, and no login key", async () => {
    const res = await post(s, "/api/repos/run?id=app", {});
    expect(res.status).toBe(401);
    const body = (await res.json()) as Refusal & { login?: unknown };
    expect(body.need).toBe("operate");
    expect(body.error).toContain("operate");
    expect("login" in body).toBe(false);
  });

  test("an unknown token is refused like no token", async () => {
    expect((await post(s, "/api/repos/run?id=app", {}, "cnp_page_nope")).status).toBe(401);
  });

  test("a shell token passes for operate", async () => {
    const res = await post(s, "/api/repos/run?id=app", {}, shell);
    expect([401, 403]).not.toContain(res.status);
  });

  test("a shell token lacks admin, the Library included", async () => {
    const role = await post(s, "/api/agents/role", {}, shell);
    expect(role.status).toBe(403);
    const body = (await role.json()) as Refusal & { login?: unknown };
    expect(body.need).toBe("admin");
    expect("login" in body).toBe(false);
    expect((await call(s, "/library/refresh", { method: "POST", token: shell })).status).toBe(403);
  });

  test("the Library's /open runs a command, so even its GET needs admin", async () => {
    const q = `?action=finder&path=${encodeURIComponent(join(scratch, "root", "app"))}`;
    const bare = await call(s, `/library/open${q}`);
    expect(bare.status).toBe(401);
    expect(((await bare.json()) as Refusal).need).toBe("admin");
    const lacks = await call(s, `/library/open${q}`, { token: shell });
    expect(lacks.status).toBe(403);
    expect(((await lacks.json()) as Refusal).need).toBe("admin");
  });

  test("a Library path the engine would read as /open needs admin too", async () => {
    const q = `?action=finder&path=${encodeURIComponent(join(scratch, "root", "app"))}`;
    for (const p of ["/library/open;x", "/library//open", "/library/open%3Bx"]) {
      const bare = await call(s, `${p}${q}`);
      expect(bare.status).toBe(401);
      expect(((await bare.json()) as Refusal).need).toBe("admin");
    }
  });

  test("a stream with no token hears that the sweep changed, never the plan its routes guard", async () => {
    const events = new AbortController();
    const stream = await call(s, "/api/events", { signal: events.signal });
    if (!stream.body) throw new Error("the event stream has no body");
    const reader = stream.body.getReader();
    expect((await call(s, "/api/sweep")).status).toBe(401);
    const saved = await post(s, "/api/sweep/settings", { spans: { shell: 2 * 3_600_000 } }, page);
    expect(saved.status).toBe(200);
    let seen = "";
    const until = Date.now() + 5_000;
    while (!seen.includes(`"type":"sweep"`) && Date.now() < until) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    events.abort();
    const frame = seen.split("\n").find((l) => l.includes(`"type":"sweep"`));
    expect(frame).toBe(`data: {"type":"sweep"}`);
  });

  test("reads stay open", async () => {
    expect((await call(s, "/api/runs")).status).toBe(200);
    const auth = (await (await call(s, "/api/auth", { token: page })).json()) as AuthInfo;
    expect(auth.mode).toBe("enforce");
    expect(auth.you).toBe("page");
  });

  test("a shell socket needs a ticket, and a page token gets one", async () => {
    const q = new URLSearchParams({ id: "app", term: "fedcba9876543210fedcba9876543210", place: "strip", cols: "80", rows: "24" });
    expect(await opens(s, `/api/term?${q}`)).toBe(false);
    const res = await post(s, "/api/auth/ticket", { for: "term" }, page);
    expect(res.status).toBe(200);
    const { ticket } = (await res.json()) as { ticket: string };
    q.set("ticket", ticket);
    expect(await opens(s, `/api/term?${q}`)).toBe(true);
    // a ticket works once
    expect(await opens(s, `/api/term?${q}`)).toBe(false);
  });

  test("a ticket needs the right it opens", async () => {
    const bare = await post(s, "/api/auth/ticket", { for: "term" });
    expect(bare.status).toBe(401);
    expect(((await bare.json()) as Refusal).need).toBe("shell");
    const lacks = await post(s, "/api/auth/ticket", { for: "term" }, shell);
    expect(lacks.status).toBe(403);
    expect(((await lacks.json()) as Refusal).need).toBe("shell");
    expect((await post(s, "/api/auth/ticket", { for: "helper" }, page)).status).toBe(403);
  });

  test("another origin may not read /api/auth", async () => {
    expect((await call(s, "/api/auth", { headers: { origin: EVIL } })).status).toBe(403);
  });

  test("a preflight from a listed origin allows the token header", async () => {
    const res = await call(s, "/api/repos/run?id=app", {
      method: "OPTIONS",
      headers: { origin: LISTED, "access-control-request-method": "POST", "access-control-request-headers": "content-type, x-canopy-token" },
    });
    expect(res.status).toBe(204);
    expect(res.headers.get("access-control-allow-headers")).toContain("x-canopy-token");
  });

  test("a coordinate run is refused where no isolated coordinator runner is set up", async () => {
    const res = await post(s, "/api/repos/run?id=app", { action: "coordinate", note: "ship it" }, shell);
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error: string }).error).toBe(COORD_REFUSAL);
    const ws = await post(s, "/api/workspaces/run", { name: "w", action: "coordinate", note: "ship it" }, shell);
    expect(ws.status).toBe(400);
    const branch = await post(s, "/api/repos/run?id=app", { action: "coordinate", note: "ship it", branch: true }, shell);
    expect(branch.status).toBe(400);
  });

  test("with the coordinator's env set but no runner to take it, a coordinate run waits and nothing starts", async () => {
    process.env["CANOPY_COORD_SOCKET"] = "/nonexistent/runner.sock";
    process.env["CANOPY_COORD_API"] = "http://10.250.14.1:7850";
    const seeds = join(scratch, "coord-seeds");
    await mkdir(seeds);
    process.env["CANOPY_COORD_ROOT"] = seeds;
    try {
      const res = await post(s, "/api/repos/run?id=app", { action: "coordinate", note: "ship it" }, shell);
      expect(res.status).toBe(503);
      const runs = (await (await call(s, "/api/runs")).json()) as { action: string }[];
      expect(runs.filter((r) => r.action === "coordinate")).toEqual([]);
      // the run's folder made for it goes with the refusal
      expect(await readdir(seeds)).toEqual([]);
    } finally {
      delete process.env["CANOPY_COORD_SOCKET"];
      delete process.env["CANOPY_COORD_API"];
      delete process.env["CANOPY_COORD_ROOT"];
    }
  });

  test("the coordinator routes reach the hub past the gate", async () => {
    const plan = await post(s, "/api/coordinator/plan", { run: "nope", tasks: [] }, shell);
    expect(plan.status).toBe(404);
    expect(((await plan.json()) as { error: string }).error).toBe("no run nope");
    expect((await post(s, "/api/coordinator/start", { run: "nope" }, shell)).status).toBe(404);
    expect((await post(s, "/api/coordinator/plan", { run: "nope", tasks: [] })).status).toBe(401);
  });

  test("the health check says enforce", async () => {
    const checks = ((await (await call(s, "/api/health")).json()) as { checks: HealthCheck[] }).checks;
    const c = checks.find((x) => x.id === "canopy:callers");
    expect(c?.state).toBe("ok");
    expect(c?.detail).toContain("enforce mode");
    expect(c?.detail).toContain("refused");
  });
});

describe("a coordinator's token from before a restart", () => {
  let s: Up;
  let coordinator = "";
  let ranger = "";
  beforeAll(async () => {
    s = await up("sweep", "enforce", (book) => {
      coordinator = book.mint("coordinator", { label: "coordinator app", run: "gone1234" }).token;
      ranger = book.mint("ranger", { label: "a shell", term: TERM }).token;
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  test("is dropped at start, and a caller of another kind is kept", async () => {
    // an admin route neither holds: unknown to the book is a 401, a known caller without the right a 403
    expect((await post(s, "/api/agents/role", {}, coordinator)).status).toBe(401);
    expect((await post(s, "/api/agents/role", {}, ranger)).status).toBe(403);
  });
});

describe("revoking a caller", () => {
  let s: Up;
  let holder = { token: "", id: "" };
  let helper = { token: "", id: "" };
  let admin = "";
  beforeAll(async () => {
    s = await up("revoke", "enforce", (book) => {
      const a = book.mint("page", { label: "a page with a shell open" });
      holder = { token: a.token, id: a.caller.id };
      const h = book.mint("helper", { label: "helper mbp" });
      helper = { token: h.token, id: h.caller.id };
      admin = book.mint("page", { label: "the page that revokes" }).token;
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  const ticket = async (token: string, what: "term" | "helper"): Promise<string> => {
    const res = await post(s, "/api/auth/ticket", { for: what }, token);
    expect(res.status).toBe(200);
    return ((await res.json()) as { ticket: string }).ticket;
  };

  /** a socket opened with a ticket, and how long it waited for its close */
  async function held(path: string): Promise<{ closed: (ms: number) => Promise<{ code: number } | "still open"> }> {
    const ws = new WebSocket(`ws://127.0.0.1:${s.port}${path}`);
    const closed = new Promise<{ code: number }>((resolve) => {
      ws.onclose = (e) => resolve({ code: e.code });
    });
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("the socket failed"));
    });
    return {
      closed: (ms) => Promise.race([closed, Bun.sleep(ms).then((): "still open" => "still open")]),
    };
  }

  test("closes the shell socket it opened, and leaves another caller's open", async () => {
    const q = new URLSearchParams({ id: "app", term: "aaaabbbbccccdddd0000111122223333", place: "strip", cols: "80", rows: "24" });
    q.set("ticket", await ticket(holder.token, "term"));
    const mine = await held(`/api/term?${q}`);
    const other = new URLSearchParams({ id: "app", term: "aaaabbbbccccdddd4444555566667777", place: "strip", cols: "80", rows: "24" });
    other.set("ticket", await ticket(admin, "term"));
    const theirs = await held(`/api/term?${other}`);
    expect((await post(s, "/api/auth/revoke", { id: holder.id }, admin)).status).toBe(200);
    // 1008, which the dock reads as a drop and rejoins, so its tabs stay
    expect(await mine.closed(2_000)).toEqual({ code: 1008 });
    expect(await theirs.closed(200)).toBe("still open");
  });

  test("closes a helper's socket", async () => {
    const q = new URLSearchParams({ name: "mbp", platform: "darwin", openers: "finder" });
    q.set("ticket", await ticket(helper.token, "helper"));
    const sock = await held(`/api/helper?${q}`);
    expect((await post(s, "/api/auth/revoke", { id: helper.id }, admin)).status).toBe(200);
    expect(await sock.closed(2_000)).toEqual({ code: 1008 });
  });
});

describe("log", () => {
  let s: Up;
  beforeAll(async () => {
    s = await up("log", "log");
  });
  afterAll(async () => {
    await s.stop();
  });

  test("a would-refuse call passes and is counted", async () => {
    const res = await post(s, "/api/repos/run?id=app", {});
    expect([401, 403]).not.toContain(res.status);
    const auth = (await (await call(s, "/api/auth")).json()) as AuthInfo;
    expect(auth.mode).toBe("log");
    expect(auth.refused.count).toBeGreaterThanOrEqual(1);
    expect(auth.refused.recent[0]?.kind).toBe("none");
    expect(auth.refused.recent[0]?.route).toBe("POST /api/repos/run");
  });

  test("the auth routes are checked whatever the mode", async () => {
    expect((await post(s, "/api/auth/approve", { id: "x" })).status).toBe(401);
  });

  test("the health check stays ok and counts the would-refuse calls", async () => {
    // the first refusal asks the polled check for a probe at once
    let c: HealthCheck | undefined;
    const counted = (x: HealthCheck | undefined): boolean => !!x?.detail && !x.detail.includes(" 0 calls");
    const until = Date.now() + 2_000;
    while (!counted(c) && Date.now() < until) {
      const checks = ((await (await call(s, "/api/health")).json()) as { checks: HealthCheck[] }).checks;
      c = checks.find((x) => x.id === "canopy:callers");
      if (!counted(c)) await Bun.sleep(50);
    }
    expect(c?.state).toBe("ok");
    expect(c?.detail).toContain("log mode");
    expect(c?.detail).toContain("would be refused");
    expect(counted(c)).toBe(true);
  });

  test("its lines go to the log sink, once per kind, method and path", async () => {
    await post(s, "/api/repos/run?id=app", {});
    expect(s.lines.filter((l) => l === "callers: would refuse none POST /api/repos/run (needs operate)")).toHaveLength(1);
  });
});

describe("off", () => {
  let s: Up;
  beforeAll(async () => {
    s = await up("off", "off");
  });
  afterAll(async () => {
    await s.stop();
  });

  test("a bare POST passes and nothing is counted", async () => {
    const res = await post(s, "/api/repos/run?id=app", {});
    expect([401, 403]).not.toContain(res.status);
    const auth = (await (await call(s, "/api/auth")).json()) as AuthInfo;
    expect(auth.mode).toBe("off");
    expect(auth.refused.count).toBe(0);
  });
});

describe("pairing over HTTP", () => {
  let s: Up;
  let shell = "";
  let shellId = "";
  /** the page token the first pairing test claims */
  let page = "";
  beforeAll(async () => {
    s = await up("pair", "enforce", (book) => {
      const minted = book.mint("ranger", { label: "a shell", term: TERM });
      shell = minted.token;
      shellId = minted.caller.id;
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  const firstCode = (): string => {
    const line = s.lines.find((l) => l.includes("first sign-in code"));
    const m = /first sign-in code (\S+) \(good until a page or the CLI signs in\)/.exec(line ?? "");
    if (!m?.[1]) throw new Error(`no first code in ${JSON.stringify(s.lines)}`);
    return m[1];
  };

  test("the first code is printed at start", () => {
    expect(firstCode()).toMatch(/^[A-Z2-9]{6}$/);
  });

  test("a pair is approved by the first code, and its claim is a page token with admin", async () => {
    const events = new AbortController();
    const stream = await call(s, "/api/events", { signal: events.signal });
    if (!stream.body) throw new Error("the event stream has no body");
    const reader = stream.body.getReader();

    const paired = await post(s, "/api/auth/pair", { label: "page test" });
    expect(paired.status).toBe(200);
    const pair = (await paired.json()) as { id: string; code: string; secret: string };
    expect(pair.code).toMatch(/^[A-Z2-9]{6}$/);

    // the page hears of the pair on the event stream
    let seen = "";
    const until = Date.now() + 5_000;
    while (!seen.includes(`"type":"auth"`) && Date.now() < until) {
      const { value, done } = await reader.read();
      if (done) break;
      seen += new TextDecoder().decode(value);
    }
    events.abort();
    expect(seen).toContain(`"type":"auth"`);
    expect(seen).toContain(pair.id);

    expect((await post(s, "/api/auth/approve", { id: pair.id })).status).toBe(401);
    const lacks = await post(s, "/api/auth/approve", { id: pair.id }, shell);
    expect(lacks.status).toBe(403);
    expect(((await lacks.json()) as Refusal).need).toBe("admin");

    const early = await post(s, "/api/auth/claim", { id: pair.id, secret: pair.secret });
    expect(await early.json()).toEqual({ waiting: true });

    const first = await post(s, "/api/auth/first", { id: pair.id, code: firstCode() });
    expect(first.status).toBe(200);
    const claimed = await post(s, "/api/auth/claim", { id: pair.id, secret: pair.secret });
    expect(claimed.status).toBe(200);
    const { token } = (await claimed.json()) as { token: string };
    expect(token).toStartWith("cnp_page_");
    page = token;

    const role = await post(s, "/api/agents/role", {}, token);
    expect([401, 403]).not.toContain(role.status);
    const auth = (await (await call(s, "/api/auth", { token })).json()) as AuthInfo;
    expect(auth.you).toBe("page");
    expect(auth.pending).toEqual([]);

    // the page may revoke the shell, and the shell token stops working
    expect((await post(s, "/api/auth/revoke", { id: "nobody" }, token)).status).toBe(404);
    expect((await post(s, "/api/auth/revoke", { id: shellId }, token)).status).toBe(200);
    expect((await post(s, "/api/repos/run?id=app", {}, shell)).status).toBe(401);
  });

  test("a claimed pair is gone, and a wrong secret gets nothing", async () => {
    const paired = (await (await post(s, "/api/auth/pair", { label: "page two" })).json()) as { id: string; secret: string };
    expect((await post(s, "/api/auth/claim", { id: paired.id, secret: "wrong" })).status).toBe(404);
  });

  test("a page polling a denied pair is not guessing", async () => {
    const paired = (await (await post(s, "/api/auth/pair", { label: "page denied" })).json()) as { id: string; secret: string };
    expect((await post(s, "/api/auth/deny", { id: paired.id }, page)).status).toBe(200);
    for (let i = 0; i < 15; i++) expect((await post(s, "/api/auth/claim", { id: paired.id, secret: paired.secret })).status).toBe(404);
  });

  test("guessing is cut off after ten misses", async () => {
    const paired = (await (await post(s, "/api/auth/pair", { label: "page three" })).json()) as { id: string; secret: string };
    // the claim test above missed once already
    for (let i = 0; i < 9; i++) expect((await post(s, "/api/auth/claim", { id: paired.id, secret: "wrong" })).status).toBe(404);
    expect((await post(s, "/api/auth/claim", { id: paired.id, secret: paired.secret })).status).toBe(429);
    for (let i = 0; i < 10; i++) expect((await post(s, "/api/auth/first", { id: paired.id, code: "AAAAAA" })).status).toBe(403);
    expect((await post(s, "/api/auth/first", { id: paired.id, code: "AAAAAA" })).status).toBe(429);
  });
});

describe("the pair request names its kind", () => {
  let s: Up;
  let admin = "";
  beforeAll(async () => {
    s = await up("pair-kind", "enforce", (book) => {
      admin = book.mint("page", { label: "admin page" }).token;
    });
  });
  afterAll(async () => {
    await s.stop();
  });

  const pending = async (): Promise<{ id: string; label: string; kind: string }[]> =>
    ((await (await call(s, "/api/auth")).json()) as { pending: { id: string; label: string; kind: string }[] }).pending;
  const asked = async (body: unknown): Promise<{ id: string; secret: string }> => {
    const res = await post(s, "/api/auth/pair", body);
    expect(res.status).toBe(200);
    return (await res.json()) as { id: string; secret: string };
  };

  test("an unknown kind is a 400 and makes no pair", async () => {
    for (const kind of ["admin", "shell", 3, ""]) expect((await post(s, "/api/auth/pair", { label: "x", kind })).status).toBe(400);
    expect(await pending()).toHaveLength(0);
  });

  test("a kind is kept and shown, and a missing one falls back to the label", async () => {
    const a = await asked({ label: "cli looks", kind: "page" });
    const b = await asked({ label: "helper old" });
    expect((await pending()).map((p) => [p.label, p.kind])).toEqual([
      ["cli looks", "page"],
      ["helper old", "helper"],
    ]);
    for (const p of [a, b]) expect((await post(s, "/api/auth/deny", { id: p.id }, admin)).status).toBe(200);
  });

  test("a renewal replaces, and the old claim says so; a bare repeat does not", async () => {
    const a = await asked({ label: "renew", kind: "page" });
    const bare = await asked({ label: "renew", kind: "page" });
    expect((await pending()).map((p) => p.id)).toEqual([a.id, bare.id]);
    const b = await asked({ label: "renew", kind: "page", id: a.id, secret: a.secret });
    expect((await pending()).map((p) => p.id)).toEqual([bare.id, b.id]);
    const old = await post(s, "/api/auth/claim", { id: a.id, secret: a.secret });
    expect(old.status).toBe(404);
    expect(((await old.json()) as { error: string }).error).toContain("replaced by a newer one");
    for (const p of [bare, b]) expect((await post(s, "/api/auth/deny", { id: p.id }, admin)).status).toBe(200);
  });

  test("the 7th new pair in a minute is a 429 with an error and makes no pair", async () => {
    // each is denied at once, so the waiting cap stays out of it; earlier tests made some
    let made = 0;
    let refused: Response | null = null;
    for (let i = 0; i < 8 && !refused; i++) {
      const res = await post(s, "/api/auth/pair", { label: "loop", kind: "page" });
      if (res.status === 429) refused = res;
      else {
        made++;
        const p = (await res.json()) as { id: string };
        await post(s, "/api/auth/deny", { id: p.id }, admin);
      }
    }
    expect(refused).not.toBeNull();
    expect(made).toBeLessThan(7);
    expect(typeof ((await (refused as Response).json()) as { error: unknown }).error).toBe("string");
    expect(await pending()).toHaveLength(0);
  });
});
