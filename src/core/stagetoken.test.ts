import { describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deployTargets, folderCheck, parseTokenArgs, saveCommand, TokenFilter, TOKEN_MASK, TOKEN_USAGE, withoutTokens } from "./stagetoken";
import { COORD_LOGIN, STAGES_LOGIN, type LoginSite } from "./stagewire";

/** a made-up token in the shape claude setup-token prints */
const TOKEN = `sk-ant-oat01-${"a1B2_c3-".repeat(12)}`;
/** what the screen shows in its place: the mask at the token's width */
const MASKED = TOKEN_MASK.padEnd(TOKEN.length);

/** every chunk of `text` pushed, then the end: what the screen got and what was found */
function run(chunks: readonly string[]): { shown: string; token: string | null } {
  const f = new TokenFilter();
  let shown = "";
  for (const c of chunks) shown += f.push(c);
  shown += f.end();
  return { shown, token: f.token() };
}

describe("TokenFilter", () => {
  const screen = `\u001b[32m✓\u001b[39m Long-lived authentication token created successfully!\r\n\r\nYour OAuth token (valid for 1 year):\r\n\r\n\u001b[33m${TOKEN}\u001b[39m\r\n\r\nStore this token securely.\r\nUse this token by setting: export CLAUDE_CODE_OAUTH_TOKEN=<token>\r\n`;

  test("finds the token and shows the screen without it", () => {
    const r = run([screen]);
    expect(r.token).toBe(TOKEN);
    expect(r.shown).not.toContain("sk-ant-oat01-");
    expect(r.shown).toBe(screen.replace(TOKEN, MASKED));
  });

  test("a token cut anywhere by a chunk's end never reaches the screen in part", () => {
    for (let cut = 1; cut < screen.length; cut += 1) {
      const f = new TokenFilter();
      const first = f.push(screen.slice(0, cut));
      // nothing of the token is out before its last character is in
      expect(first).not.toContain("sk-ant-oat01-a");
      const shown = first + f.push(screen.slice(cut)) + f.end();
      expect(f.token()).toBe(TOKEN);
      expect(shown).toBe(screen.replace(TOKEN, MASKED));
    }
  });

  test("one character at a time gives the same screen", () => {
    const r = run([...screen]);
    expect(r.token).toBe(TOKEN);
    expect(r.shown).toBe(screen.replace(TOKEN, MASKED));
  });

  test("a token that ends the stream is taken at the end", () => {
    const r = run(["here it is: ", TOKEN.slice(0, 30), TOKEN.slice(30)]);
    expect(r.token).toBe(TOKEN);
    expect(r.shown).toBe(`here it is: ${MASKED}`);
  });

  test("words that only start like a token are shown as they are", () => {
    for (const text of ["a key starts sk-ant- and goes on\n", "sk-ant-api03-short\n", "sk-a", "ask-an", "risk-ant", "sk-ant-oat01-tooshort "]) {
      const r = run([text]);
      expect(r.token).toBe(null);
      expect(r.shown).toBe(text);
    }
  });

  test("the last whole token wins, and each is masked", () => {
    const other = `sk-ant-oat01-${"z9".repeat(40)}`;
    const r = run([`${other}\n`, `${TOKEN}\n`]);
    expect(r.token).toBe(TOKEN);
    expect(r.shown).toBe(`${TOKEN_MASK.padEnd(other.length)}\n${MASKED}\n`);
  });
});

describe("parseTokenArgs", () => {
  test("no words: the mini's stages from a Mac, this host's anywhere else", () => {
    expect(parseTokenArgs([], {}, "darwin")).toEqual({ ok: true, backend: "mini", dest: "macmini-2018", logins: ["stages"] });
    expect(parseTokenArgs([], {}, "linux")).toEqual({ ok: true, backend: "here", dest: null, logins: ["stages"] });
  });

  test("a backend and a login in either order", () => {
    expect(parseTokenArgs(["desoto", "stages"], {}, "darwin")).toEqual({ ok: true, backend: "desoto", dest: "eric@desoto-canopy", logins: ["stages"] });
    expect(parseTokenArgs(["all", "mini"], {}, "darwin")).toEqual({ ok: true, backend: "mini", dest: "macmini-2018", logins: ["stages", "coord"] });
    expect(parseTokenArgs(["coord"], {}, "linux")).toEqual({ ok: true, backend: "here", dest: null, logins: ["coord"] });
    expect(parseTokenArgs(["here", "all"], {}, "darwin")).toEqual({ ok: true, backend: "here", dest: null, logins: ["stages", "coord"] });
  });

  test("the redeploy script's own settings name the hosts", () => {
    expect(deployTargets({})).toEqual({ mini: "macmini-2018", desoto: "eric@desoto-canopy" });
    expect(deployTargets({ CANOPY_DEPLOY_MINI: "macmini-ts" })["mini"]).toBe("macmini-ts");
    expect(deployTargets({ CANOPY_DEPLOY_TARGETS: "lab=eric@lab  barn=barn.local" })).toEqual({ lab: "eric@lab", barn: "barn.local" });
    expect(parseTokenArgs(["lab"], { CANOPY_DEPLOY_TARGETS: "lab=eric@lab" }, "darwin")).toMatchObject({ backend: "lab", dest: "eric@lab" });
    // a Mac whose list has no mini falls back to this machine, never a guess
    expect(parseTokenArgs([], { CANOPY_DEPLOY_TARGETS: "lab=eric@lab" }, "darwin")).toMatchObject({ backend: "here", dest: null });
  });

  test("a word it does not know, and a thing named twice, are refused with the usage", () => {
    for (const args of [["staging"], ["mini", "desoto"], ["stages", "coord"], ["--force"]]) {
      const r = parseTokenArgs(args, {}, "darwin");
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain(TOKEN_USAGE);
    }
  });
});

describe("the lines that run on the host", () => {
  /** a login site whose folder is under `home` */
  const run = async (line: string, home: string, stdin: string): Promise<{ code: number; err: string }> => {
    const p = Bun.spawn(["sh", "-c", line], { env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", HOME: home }, stdin: new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
    const [code, err] = await Promise.all([p.exited, new Response(p.stderr).text()]);
    return { code, err };
  };
  const site: LoginSite = { ...STAGES_LOGIN, folder: "~/stages/claude" };

  test("the folders are the runners' own", () => {
    expect(saveCommand(STAGES_LOGIN)).toContain('d="$HOME/.config/canopy-stages/claude"');
    expect(saveCommand(COORD_LOGIN)).toContain('d="$HOME/.config/canopy-coord/claude"');
    expect(folderCheck(COORD_LOGIN)).toBe('test -d "$HOME/.config/canopy-coord/claude" && test -w "$HOME/.config/canopy-coord/claude"');
  });

  test("saves the token whole, private, over an old one, and leaves nothing beside it", async () => {
    const home = await mkdtemp(join(tmpdir(), "cst-"));
    try {
      await Bun.$`mkdir -p ${join(home, "stages/claude")}`.quiet();
      const file = join(home, "stages/claude/oauth-token.txt");
      await writeFile(file, "an old token\n", { mode: 0o644 });
      expect((await run(folderCheck(site), home, "")).code).toBe(0);
      const r = await run(saveCommand(site), home, `${TOKEN}\n`);
      expect(r).toEqual({ code: 0, err: "" });
      expect(await readFile(file, "utf8")).toBe(`${TOKEN}\n`);
      expect((await stat(file)).mode & 0o777).toBe(0o600);
      expect((await Bun.$`ls -A ${join(home, "stages/claude")}`.text()).trim()).toBe("oauth-token.txt");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });

  test("a host with no such folder is refused before and after, and an empty stdin keeps the old token", async () => {
    const home = await mkdtemp(join(tmpdir(), "cst-"));
    try {
      expect((await run(folderCheck(site), home, "")).code).not.toBe(0);
      const none = await run(saveCommand(site), home, `${TOKEN}\n`);
      expect(none.code).toBe(3);
      expect(none.err).toContain("on this host");
      await Bun.$`mkdir -p ${join(home, "stages/claude")}`.quiet();
      const file = join(home, "stages/claude/oauth-token.txt");
      await writeFile(file, "an old token\n");
      const empty = await run(saveCommand(site), home, "");
      expect(empty.code).toBe(4);
      expect(await readFile(file, "utf8")).toBe("an old token\n");
      expect((await Bun.$`ls -A ${join(home, "stages/claude")}`.text()).trim()).toBe("oauth-token.txt");
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  });
});

test("an error's words never carry a token", () => {
  expect(withoutTokens(`401 for ${TOKEN}: revoked`)).toBe(`401 for ${TOKEN_MASK}: revoked`);
  expect(withoutTokens("nothing here")).toBe("nothing here");
});
