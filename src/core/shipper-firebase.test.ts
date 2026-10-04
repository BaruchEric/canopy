import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exec, type ExecOptions, type ExecResult } from "./exec";
import { shipConfig, shipper, type ShipDeps } from "./shipper";

const TOKEN = "1//fb-refresh-secret";
const cfg = shipConfig({ VERCEL_TOKEN: "tok_secret", VERCEL_SCOPE: "eric-team", FIREBASE_TOKEN: TOKEN }, "mini");
const FB = "/opt/firebase/bin/firebase";
const success = (result: unknown): ExecResult => ({ code: 0, stdout: JSON.stringify({ status: "success", result }), stderr: "" });
const failure = (error: string): ExecResult => ({ code: 1, stdout: JSON.stringify({ status: "error", error }), stderr: "" });

interface Call {
  cmd: string[];
  opts: ExecOptions;
  /** what the call's home and cwd held while it ran */
  homeThere: boolean;
  cwdFiles: Record<string, boolean>;
}

/** the firebase CLI answered from `answer` by its command; git runs for real */
function world(answer: (args: string[]) => ExecResult, http: (url: string, init?: RequestInit) => Response = () => new Response("{}", { status: 200 })) {
  const calls: Call[] = [];
  const fetched: { url: string; method: string; body: string }[] = [];
  const deps: ShipDeps = {
    exec: async (cmd, opts = {}) => {
      if (cmd[0] !== FB) return exec(cmd, opts);
      const home = opts.env?.["HOME"] ?? "";
      const cwd = opts.cwd ?? "";
      const cwdFiles = Object.fromEntries([".firebaserc", ".env.local", "firestore.rules", "firebase.json"].map((f) => [f, existsSync(join(cwd, f))]));
      calls.push({ cmd, opts, homeThere: existsSync(home), cwdFiles });
      return answer(cmd.slice(1));
    },
    fetch: (async (input: string | URL | Request, init?: RequestInit) => {
      fetched.push({ url: String(input), method: init?.method ?? "GET", body: typeof init?.body === "string" ? init.body : "" });
      return http(String(input), init);
    }) as typeof fetch,
    which: (bin, path) => (bin === "firebase" && path ? FB : `/usr/bin/${bin}`),
  };
  return { calls, fetched, deps };
}

describe("the firebase CLI's process", () => {
  test("the token is in its env alone, beside PATH and a scratch home that is gone after; never on argv", async () => {
    const w = world(() => success({ projectId: "coin-a1b2c3" }));
    await shipper(cfg, w.deps).firebaseProject("coin-a1b2c3");
    const c = w.calls[0];
    expect(c?.cmd).toEqual([FB, "projects:create", "coin-a1b2c3", "--display-name", "coin-a1b2c3", "--non-interactive", "--json"]);
    expect(c?.cmd.join(" ")).not.toContain(TOKEN);
    expect(Object.keys(c?.opts.base ?? {})).toEqual(["PATH"]);
    const env = c?.opts.env ?? {};
    expect(env["FIREBASE_TOKEN"]).toBe(TOKEN);
    expect(env["NO_UPDATE_NOTIFIER"]).toBe("1");
    const home = env["HOME"] ?? "";
    expect(home.startsWith(tmpdir()) || home.startsWith("/var/") || home.startsWith("/private/")).toBe(true);
    expect(env["XDG_CONFIG_HOME"]).toBe(join(home, ".config"));
    expect(env["XDG_CACHE_HOME"]).toBe(join(home, ".cache"));
    expect(c?.homeThere).toBe(true);
    expect(existsSync(home)).toBe(false);
    expect(Object.keys(env).sort()).toEqual(["FIREBASE_TOKEN", "HOME", "NO_UPDATE_NOTIFIER", "XDG_CACHE_HOME", "XDG_CONFIG_HOME"]);
  });

  test("a failure says the CLI's error with the token masked", async () => {
    const w = world(() => failure(`Request failed with token ${TOKEN}: quota exceeded`));
    const err = await shipper(cfg, w.deps).firebaseDatabase("p").then(() => "", (e: unknown) => String(e));
    expect(err).toContain("firebase firestore:databases:create: Request failed with token ***: quota exceeded");
    expect(err).not.toContain(TOKEN);
  });

  test("no token or no CLI fails before anything runs, and ready says which", async () => {
    const noToken = shipConfig({ VERCEL_TOKEN: "t" }, "mini");
    const w = world(() => success({}));
    await expect(shipper(noToken, w.deps).firebaseProject("p-a1b2c3")).rejects.toThrow("add FIREBASE_TOKEN to mini's .env");
    expect(shipper(noToken, w.deps).ready("vercel+firebase")).toBe("add FIREBASE_TOKEN to mini's .env");
    const noCli = { ...w.deps, which: (b: string) => (b === "vercel" ? "/usr/bin/vercel" : null) };
    expect(shipper(cfg, noCli).ready("vercel+firebase")).toBe("the firebase CLI is not installed on mini");
    expect(shipper(cfg, w.deps).ready("vercel+firebase")).toBe(null);
    const badLoc = shipConfig({ VERCEL_TOKEN: "t", FIREBASE_TOKEN: "x", FIREBASE_LOCATION: "nam5; rm -rf" }, "mini");
    expect(shipper(badLoc, w.deps).ready("vercel+firebase")).toBe("FIREBASE_LOCATION nam5; rm -rf on mini is not a Firestore location id");
    expect(w.calls).toHaveLength(0);
  });
});

describe("making the Firebase side", () => {
  test("a project already there counts only when the login reaches it", async () => {
    const reach = world((a) => (a[0] === "projects:create" ? failure("Project already exists") : success([])));
    await shipper(cfg, reach.deps).firebaseProject("p-a1b2c3");
    expect(reach.calls.map((c) => c.cmd[1])).toEqual(["projects:create", "apps:list"]);
    const other = world((a) => (a[0] === "projects:create" ? failure("Project already exists") : failure("Permission denied")));
    await expect(shipper(cfg, other.deps).firebaseProject("p-a1b2c3")).rejects.toThrow("already exists");
  });

  test("Firestore at the configured location; one already there counts", async () => {
    const w = world(() => failure("Database '(default)' already exists"));
    await shipper(shipConfig({ FIREBASE_TOKEN: TOKEN, FIREBASE_LOCATION: "eur3" }, "mini"), w.deps).firebaseDatabase("p-a1b2c3");
    expect(w.calls[0]?.cmd.slice(1, 7)).toEqual(["firestore:databases:create", "(default)", "--location", "eur3", "--project", "p-a1b2c3"]);
  });

  test("the web app is reused by its name, else made", async () => {
    const had = world(() => success([{ appId: "1:9:web:9", displayName: "coin" }]));
    expect(await shipper(cfg, had.deps).firebaseApp("p", "coin")).toBe("1:9:web:9");
    expect(had.calls).toHaveLength(1);
    const none = world((a) => (a[0] === "apps:list" ? success([]) : success({ appId: "1:2:web:3", displayName: "coin" })));
    expect(await shipper(cfg, none.deps).firebaseApp("p", "coin")).toBe("1:2:web:3");
    expect(none.calls[1]?.cmd.slice(1, 6)).toEqual(["apps:create", "WEB", "coin", "--project", "p"]);
  });

  test("the app's config goes to Vercel as public env for Vite and Next, upserted, in the team's scope", async () => {
    const config = { projectId: "p", appId: "1:2:web:3", apiKey: "AIza", authDomain: "p.firebaseapp.com" };
    const w = world(() => success({ fileName: "firebase-js-config.json", sdkConfig: config }), () => new Response(JSON.stringify({ created: [], failed: [] }), { status: 201 }));
    await shipper(cfg, w.deps).firebaseEnv("p", "1:2:web:3", "coin");
    expect(w.fetched[0]?.url).toBe("https://api.vercel.com/v10/projects/coin/env?upsert=true&slug=eric-team");
    const body: unknown = JSON.parse(w.fetched[0]?.body ?? "[]");
    expect(body).toContainEqual({ key: "VITE_FIREBASE_API_KEY", value: "AIza", type: "plain", target: ["production", "preview", "development"] });
    expect(body).toContainEqual({ key: "NEXT_PUBLIC_FIREBASE_PROJECT_ID", value: "p", type: "plain", target: ["production", "preview", "development"] });
    expect(JSON.stringify(body)).not.toContain(TOKEN);
    const other = world(() => success({ sdkConfig: { ...config, projectId: "someone-else" } }));
    await expect(shipper(cfg, other.deps).firebaseEnv("p", "1:2:web:3", "coin")).rejects.toThrow("did not answer the config of a web app in p");
    const refused = world(() => success({ sdkConfig: config }), () => new Response(JSON.stringify({ failed: [{ error: "x" }] }), { status: 201 }));
    await expect(shipper(cfg, refused.deps).firebaseEnv("p", "1:2:web:3", "coin")).rejects.toThrow("refused 1 of the Firebase config's env");
  });
});

describe("firebaseDeploy", () => {
  const git = async (cwd: string, ...args: string[]): Promise<void> => {
    const r = await exec(["git", "-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
    if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  };
  const seedWith = async (files: Record<string, string>, links: Record<string, string> = {}): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "canopy-fb-seed-"));
    await git(dir, "init", "-q", "-b", "main");
    for (const [rel, text] of Object.entries(files)) await writeFile(join(dir, rel), text);
    for (const [rel, to] of Object.entries(links)) await symlink(to, join(dir, rel));
    await git(dir, "add", "-A", "-f");
    await git(dir, "commit", "-qm", "seed");
    return dir;
  };
  const good = { "firebase.json": JSON.stringify({ firestore: { rules: "firestore.rules" } }), "firestore.rules": "rules_version = '2';", ".firebaserc": '{"projects":{"default":"someone-elses"}}', ".env.local": "SECRET=1" };

  test("deploys the rules from a clean clone, with no .firebaserc or env file, to the project named", async () => {
    const w = world(() => success({}));
    await shipper(cfg, w.deps).firebaseDeploy(await seedWith(good), "p-a1b2c3");
    const c = w.calls[0];
    expect(c?.cmd.slice(1)).toEqual(["deploy", "--only", "firestore", "--project", "p-a1b2c3", "--non-interactive", "--json"]);
    expect(c?.cwdFiles).toEqual({ ".firebaserc": false, ".env.local": false, "firestore.rules": true, "firebase.json": true });
    expect(existsSync(c?.opts.cwd ?? "")).toBe(false);
  });

  test("a firebase.json with more than Firestore, or a link out of the repo, never reaches the CLI", async () => {
    const w = world(() => success({}));
    const s = shipper(cfg, w.deps);
    await expect(s.firebaseDeploy(await seedWith({ ...good, "firebase.json": JSON.stringify({ firestore: { rules: "firestore.rules" }, hosting: { public: "dist" } }) }), "p")).rejects.toThrow(
      "firebase.json holds hosting",
    );
    await expect(s.firebaseDeploy(await seedWith({ "firebase.json": good["firebase.json"] }, { "firestore.rules": "/etc/hosts" }), "p")).rejects.toThrow("symlink");
    await expect(s.firebaseDeploy(await seedWith(good, { "notes.md": "/etc/hosts" }), "p")).rejects.toThrow("notes.md is a symlink out of the repo");
    await expect(s.firebaseDeploy(await seedWith({ "firebase.json": good["firebase.json"] }), "p")).rejects.toThrow("names firestore.rules, which is not in the repo");
    expect(w.calls).toHaveLength(0);
  });
});
