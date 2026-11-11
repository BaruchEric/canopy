import { describe, expect, test } from "bun:test";
import { childEnv, chunkB64, COORD_LOGIN, encodeFrame, fromB64, gitEnv, lineSplitter, loginEnv, loginRefusal, loginRefusedHint, loginWord, parseFrame, passEnvNames, proxyEnv, requestRefusal, StageAwayError, STAGE_AWAY, type StageRequest } from "./stagewire";

describe("stage wire", () => {
  test("frames round-trip one per line", () => {
    const f = { t: "out", d: Buffer.from("hé\n").toString("base64") } as const;
    const line = encodeFrame(f);
    expect(line.endsWith("\n")).toBe(true);
    expect(line.slice(0, -1)).not.toContain("\n");
    expect(parseFrame(line)).toEqual(f);
  });
  test("a frame that is not one of ours is null", () => {
    expect(parseFrame("{}")).toBe(null);
    expect(parseFrame("nope")).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "out", d: 3 }))).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "spawn", argv: "sh", cwd: "/x", env: {} }))).toBe(null);
  });
  test("the runner starts only claude, codex or sh, by bare name", () => {
    const ok = { t: "spawn" as const, argv: ["claude", "-p"], cwd: "/s/coin", env: {} };
    expect(requestRefusal(ok)).toBe(null);
    for (const argv0 of ["/bin/sh", "bun", "../claude", "claude ", ""]) {
      expect(requestRefusal({ ...ok, argv: [argv0] })).toContain("program");
    }
    expect(requestRefusal({ ...ok, argv: [] })).toContain("program");
    expect(requestRefusal({ ...ok, cwd: "relative" })).toContain("cwd");
    expect(requestRefusal({ t: "hello" })).toBe(null);
  });
  test("the child env is the runner's base plus three names, whatever canopy sends", () => {
    const own = { PATH: "/usr/bin", HOME: "/home/bun", CLAUDE_CONFIG_DIR: "/c", SECRET: "no", GH_TOKEN: "no" };
    const asked = { CANOPY_RUN: "r1", CANOPY_REPO: "_incubator/coin", GH_TOKEN: "ghp_x", VERCEL_TOKEN: "v", PATH: "/evil", LD_PRELOAD: "/x.so" };
    expect(childEnv(own, asked)).toEqual({ PATH: "/usr/bin", HOME: "/home/bun", CLAUDE_CONFIG_DIR: "/c", CANOPY_RUN: "r1", CANOPY_REPO: "_incubator/coin" });
  });
  test("claude alone is handed the runner's own token, as the name claude reads; canopy cannot send one", () => {
    const own = { PATH: "/usr/bin", HOME: "/home/bun" };
    expect(loginEnv("sk-ant-oat01-x", "claude")).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" });
    // a check's sh and codex never see it
    expect(loginEnv("sk-ant-oat01-x", "sh")).toEqual({});
    expect(loginEnv("sk-ant-oat01-x", "codex")).toEqual({});
    expect(loginEnv(null, "claude")).toEqual({});
    // a token canopy sends is dropped like any other name; only the runner's own is set
    const asked = { CANOPY_RUN: "r1", CLAUDE_CODE_OAUTH_TOKEN: "from-canopy" };
    expect(childEnv(own, asked, [], {}, loginEnv("sk-ant-oat01-x", "claude"))).toEqual({ PATH: "/usr/bin", HOME: "/home/bun", CANOPY_RUN: "r1", CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat01-x" });
    expect(childEnv(own, asked, [], {}, loginEnv("sk-ant-oat01-x", "sh"))).toEqual({ PATH: "/usr/bin", HOME: "/home/bun", CANOPY_RUN: "r1" });
  });
  test("a hello's claude login is one of four states, and anything else is left out", () => {
    const hello = (claude: unknown) => parseFrame(JSON.stringify({ t: "hello", harnesses: ["claude"], fenced: true, claude }));
    expect(hello({ how: "token" })).toEqual({ t: "hello", harnesses: ["claude"], fenced: true, claude: { how: "token" } });
    expect(hello({ how: "login", until: 1_800_000_000_000 })).toEqual({ t: "hello", harnesses: ["claude"], fenced: true, claude: { how: "login", until: 1_800_000_000_000 } });
    expect(hello({ how: "login" })).toEqual({ t: "hello", harnesses: ["claude"], fenced: true, claude: { how: "login" } });
    expect(hello({ how: "expired", until: 5 })).toEqual({ t: "hello", harnesses: ["claude"], fenced: true, claude: { how: "expired", until: 5 } });
    expect(hello({ how: "none" })).toEqual({ t: "hello", harnesses: ["claude"], fenced: true, claude: { how: "none" } });
    // an older runner says nothing, and a newer one's word this canopy does not know is not guessed at
    for (const odd of [undefined, null, "token", { how: "revoked" }, { until: 5 }, []]) expect(hello(odd)).toEqual({ t: "hello", harnesses: ["claude"], fenced: true });
    // a time that is not a number is dropped, the state kept; nothing else rides along
    expect(hello({ how: "expired", until: "soon", accessToken: "sk-x" })).toEqual({ t: "hello", harnesses: ["claude"], fenced: true, claude: { how: "expired" } });
  });
  test("the login's words say what is wrong and what to do, or nothing when it is good", () => {
    expect(loginRefusal(undefined)).toBe(null);
    expect(loginRefusal({ how: "token" })).toBe(null);
    expect(loginRefusal({ how: "login", until: Date.UTC(2026, 11, 1) })).toBe(null);
    expect(loginRefusal({ how: "expired", until: Date.UTC(2026, 10, 1, 14, 31) })).toBe(
      "the stages' claude login expired on 2026-11-01: save a token from claude setup-token as ~/.config/canopy-stages/claude/oauth-token.txt on the host, or log in again in the stages container (docs/deploy.md, Stages, step 7)",
    );
    expect(loginRefusal({ how: "expired" })).toBe(
      "the stages' claude login expired: save a token from claude setup-token as ~/.config/canopy-stages/claude/oauth-token.txt on the host, or log in again in the stages container (docs/deploy.md, Stages, step 7)",
    );
    expect(loginRefusal({ how: "none" })).toBe(
      "the stages have no claude login: save a token from claude setup-token as ~/.config/canopy-stages/claude/oauth-token.txt on the host, or log in in the stages container (docs/deploy.md, Stages, step 7)",
    );
    // the coordinator's runner is the same program over another folder
    expect(loginRefusal({ how: "expired", until: Date.UTC(2026, 11, 1, 14, 51) }, COORD_LOGIN)).toBe(
      "the coordinator's claude login expired on 2026-12-01: save a token from claude setup-token as ~/.config/canopy-coord/claude/oauth-token.txt on the host, or log in again in the coord container (docs/deploy.md, The coordinator, step 2)",
    );
    expect(loginRefusal({ how: "none" }, COORD_LOGIN)).toStartWith("the coordinator has no claude login: save a token from claude setup-token as ~/.config/canopy-coord/claude/oauth-token.txt");
    expect(loginWord({ how: "token" })).toBe("signed in with a token");
    expect(loginWord({ how: "login", until: Date.UTC(2026, 11, 1, 14, 51) })).toBe("logged in until 2026-12-01");
    expect(loginWord({ how: "login" })).toBe("logged in");
    expect(loginWord(undefined)).toBe(null);
  });
  test("claude's words for a login it could not use get the fix, and no other error does", () => {
    const fix =
      "Anthropic refused the stages' claude login: save a fresh token from claude setup-token as ~/.config/canopy-stages/claude/oauth-token.txt on the host, or log in again in the stages container (docs/deploy.md, Stages, step 7), then retry";
    expect(loginRefusedHint("Failed to authenticate: OAuth session expired and could not be refreshed")).toBe(fix);
    expect(loginRefusedHint('API Error: 401 {"type":"error","error":{"type":"authentication_error","message":"OAuth token has been revoked"}}')).toBe(fix);
    expect(loginRefusedHint("Invalid API key · Please run /login")).toBe(fix);
    expect(loginRefusedHint("Invalid bearer token", COORD_LOGIN)).toStartWith("Anthropic refused the coordinator's claude login: save a fresh token from claude setup-token as ~/.config/canopy-coord/claude/oauth-token.txt");
    expect(loginRefusedHint("the repo is not in the scan any more")).toBe(null);
    expect(loginRefusedHint("the session expired on the build host")).toBe(null);
  });
  test("a runner told to pass more names lets those through as well, and only those", () => {
    const own = { PATH: "/usr/bin", HOME: "/home/bun", CANOPY_TOKEN: "own" };
    const asked = { CANOPY_RUN: "r1", CANOPY_API: "http://10.250.14.1:7850", CANOPY_TOKEN: "cnp_x", GH_TOKEN: "ghp_x" };
    expect(childEnv(own, asked, ["CANOPY_API", "CANOPY_TOKEN"])).toEqual({
      PATH: "/usr/bin",
      HOME: "/home/bun",
      CANOPY_RUN: "r1",
      CANOPY_API: "http://10.250.14.1:7850",
      CANOPY_TOKEN: "cnp_x",
    });
    // without the extra names the token stays out, whatever canopy sends
    expect(childEnv(own, asked)).toEqual({ PATH: "/usr/bin", HOME: "/home/bun", CANOPY_RUN: "r1" });
  });
  test("CANOPY_STAGE_PASS_ENV: unset or empty passes nothing more, CANOPY_API and CANOPY_TOKEN are the only extras", () => {
    expect(passEnvNames(undefined)).toEqual({ names: [] });
    expect(passEnvNames("")).toEqual({ names: [] });
    expect(passEnvNames(" ")).toEqual({ names: [] });
    expect(passEnvNames("CANOPY_API,CANOPY_TOKEN")).toEqual({ names: ["CANOPY_API", "CANOPY_TOKEN"] });
    expect(passEnvNames(" CANOPY_TOKEN , CANOPY_API,")).toEqual({ names: ["CANOPY_TOKEN", "CANOPY_API"] });
    expect(passEnvNames("CANOPY_API,CANOPY_API")).toEqual({ names: ["CANOPY_API"] });
    for (const bad of ["GH_TOKEN", "CANOPY_API,GH_TOKEN", "canopy_api", "CANOPY_TOKENS", "PATH", "LD_PRELOAD"]) {
      const r = passEnvNames(bad);
      expect("refused" in r ? r.refused : "").toContain("CANOPY_STAGE_PASS_ENV");
    }
  });
  test("CANOPY_STAGE_PROXY: unset or empty adds nothing, so a stages runner's children get the env they always had", () => {
    expect(proxyEnv(undefined)).toEqual({ env: {} });
    expect(proxyEnv("")).toEqual({ env: {} });
    expect(proxyEnv("  ")).toEqual({ env: {} });
    const own = { PATH: "/usr/bin", HOME: "/home/bun", HTTPS_PROXY: "http://own:1" };
    expect(childEnv(own, { CANOPY_RUN: "r1" }, [], {})).toEqual({ PATH: "/usr/bin", HOME: "/home/bun", CANOPY_RUN: "r1" });
  });
  test("CANOPY_STAGE_PROXY: an http proxy at an address and port sets both cases of the proxy names, a no-proxy list for its own host, and claude's quiet switches", () => {
    const url = "http://10.250.14.1:3128";
    const no = "10.250.14.1,127.0.0.1,localhost";
    const want = {
      HTTPS_PROXY: url,
      https_proxy: url,
      HTTP_PROXY: url,
      http_proxy: url,
      NO_PROXY: no,
      no_proxy: no,
      CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
      DISABLE_AUTOUPDATER: "1",
    };
    expect(proxyEnv(url)).toEqual({ env: want });
    expect(proxyEnv(` ${url}/ `)).toEqual({ env: want });
  });
  test("CANOPY_STAGE_PROXY: anything but http://<IPv4>:<port> stops the runner rather than leave a child unproxied", () => {
    for (const bad of [
      "10.250.14.1:3128",
      "https://10.250.14.1:3128",
      "http://proxy:3128",
      "http://10.250.14.1",
      "http://10.250.14.1:0",
      "http://10.250.14.1:65536",
      "http://10.250.14.256:3128",
      "http://user:pw@10.250.14.1:3128",
      "http://10.250.14.1:3128/path",
      "http://10.250.14.1:3128?x=1",
      "http://[::1]:3128",
    ]) {
      const r = proxyEnv(bad);
      expect("refused" in r ? r.refused : `${bad} passed`).toContain("CANOPY_STAGE_PROXY");
    }
  });
  test("the proxy names come from the runner alone: what canopy sends never sets or clears them", () => {
    const net = proxyEnv("http://10.250.14.1:3128");
    if (!("env" in net)) throw new Error(net.refused);
    const asked = { CANOPY_RUN: "r1", HTTPS_PROXY: "http://evil:1", NO_PROXY: "*", no_proxy: "*", http_proxy: "" };
    const env = childEnv({ PATH: "/usr/bin" }, asked, ["CANOPY_API", "CANOPY_TOKEN"], net.env);
    expect(env).toEqual({ PATH: "/usr/bin", CANOPY_RUN: "r1", ...net.env });
  });
  test("big output goes in 64 KiB slices", () => {
    const bytes = new Uint8Array(150_000).fill(65);
    const parts = chunkB64(bytes);
    expect(parts).toHaveLength(3);
    expect(Buffer.concat(parts.map((p) => Buffer.from(p, "base64"))).equals(Buffer.from(bytes))).toBe(true);
    expect(fromB64(parts[0] ?? "")).toHaveLength(65536);
  });
  test("the splitter keeps a partial line for the next chunk", () => {
    const split = lineSplitter();
    expect(split('{"t":"ex')).toEqual([]);
    expect(split('it","code":0}\n{"t":"eo')).toEqual(['{"t":"exit","code":0}']);
    expect(split('f"}\n')).toEqual(['{"t":"eof"}']);
  });
  test("busy: a request names a seed, the answer says whether it is busy", () => {
    const q = { t: "busy", seed: "/s/coin" } as const;
    expect(parseFrame(encodeFrame(q))).toEqual(q);
    const a = { t: "busy", busy: true } as const;
    expect(parseFrame(encodeFrame(a))).toEqual(a);
    expect(parseFrame(JSON.stringify({ t: "busy" }))).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "busy", busy: "yes" }))).toBe(null);
    expect(requestRefusal(q)).toBe(null);
    expect(requestRefusal({ t: "busy", seed: "coin" })).toContain("seed");
  });
  test("git: a request names a seed, its args and an env of git's own names only", () => {
    const q: Extract<StageRequest, { t: "git" }> = { t: "git", seed: "/s/coin", args: ["status", "--porcelain=v2"], env: { GIT_OPTIONAL_LOCKS: "0" } };
    expect(parseFrame(encodeFrame(q))).toEqual(q);
    expect(parseFrame(JSON.stringify({ t: "git", seed: "/s/coin", args: "status", env: {} }))).toBe(null);
    expect(parseFrame(JSON.stringify({ t: "git", seed: "/s/coin", args: ["status"], env: { A: 1 } }))).toBe(null);
    expect(requestRefusal(q)).toBe(null);
    expect(requestRefusal({ ...q, seed: "coin" })).toContain("seed");
    // a name the runner would drop changes what git writes: refused, never dropped
    for (const name of ["GIT_INDEX_FILE", "GIT_OBJECT_DIRECTORY", "GIT_DIR", "GIT_CONFIG_COUNT", "PATH", "GH_TOKEN"]) {
      expect(requestRefusal({ ...q, env: { [name]: "x" } })).toContain(name);
    }
  });
  test("a git request's env is the runner's own: no global or system config, a ceiling at the stage root", () => {
    const own = { PATH: "/usr/bin", HOME: "/home/bun", LANG: "C.UTF-8", GH_TOKEN: "no", CLAUDE_CONFIG_DIR: "/c" };
    const asked = { GIT_OPTIONAL_LOCKS: "0", GIT_AUTHOR_NAME: "canopy", GIT_INDEX_FILE: "/tmp/i", HOME: "/evil" };
    expect(gitEnv(own, asked, "/s")).toEqual({
      PATH: "/usr/bin",
      LANG: "C.UTF-8",
      HOME: "/nonexistent",
      XDG_CONFIG_HOME: "/nonexistent",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CEILING_DIRECTORIES: "/s",
      GIT_TERMINAL_PROMPT: "0",
      GIT_OPTIONAL_LOCKS: "0",
      GIT_AUTHOR_NAME: "canopy",
    });
  });
  test("hello and exit frames parse, with their fields checked", () => {
    expect(parseFrame('{"t":"hello"}')).toEqual({ t: "hello" });
    // a runner from before the fence says nothing of it, and reads as unchecked
    expect(parseFrame('{"t":"hello","harnesses":["claude"]}')).toEqual({ t: "hello", harnesses: ["claude"], fenced: "unchecked" });
    expect(parseFrame('{"t":"hello","harnesses":["claude"],"fenced":"yes"}')).toEqual({ t: "hello", harnesses: ["claude"], fenced: "unchecked" });
    expect(parseFrame('{"t":"hello","harnesses":[],"fenced":true}')).toEqual({ t: "hello", harnesses: [], fenced: true });
    expect(parseFrame('{"t":"hello","harnesses":[],"fenced":false,"reason":"the fence is down: http://x/ answered"}')).toEqual({
      t: "hello",
      harnesses: [],
      fenced: false,
      reason: "the fence is down: http://x/ answered",
    });
    expect(parseFrame('{"t":"hello","harnesses":[1]}')).toBe(null);
    expect(parseFrame('{"t":"exit","code":null}')).toEqual({ t: "exit", code: null });
    // a refusal keeps fenced only when it says the fence is why
    expect(parseFrame('{"t":"refused","reason":"r","fenced":"unchecked"}')).toEqual({ t: "refused", reason: "r", fenced: "unchecked" });
    expect(parseFrame('{"t":"refused","reason":"r","fenced":true}')).toEqual({ t: "refused", reason: "r" });
    expect(parseFrame('{"t":"exit","code":"0"}')).toBe(null);
  });
  test("the away error carries its message and name", () => {
    const e = new StageAwayError();
    expect(e.message).toBe(STAGE_AWAY);
    expect(e.name).toBe("StageAwayError");
    expect(e instanceof Error).toBe(true);
  });
});
