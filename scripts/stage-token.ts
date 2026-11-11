/**
 * bun run stage-token [mini | desoto | here] [stages | coord | all]
 *
 * Gives a backend's stage runner a claude login that lasts a year, in one
 * command: runs `claude setup-token` here, takes the token out of what it
 * prints (the screen shows a placeholder), asks Anthropic whether it works,
 * and saves it as the runner's `oauth-token.txt` on the backend's host over
 * ssh. The one thing left to a person is the browser's "Authorize". On a
 * Mac the browser opens itself; on a host with none, claude prints a link
 * and asks for the code the page gives. Nothing is redeployed: the runner
 * reads the file at its next hello. See docs/deploy.md, Stages, step 7.
 * Bun: the pty is Bun's.
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { folderCheck, LOGIN_CHECK, LOGIN_SITES, MINT_COLS, parseTokenArgs, saveCommand, TokenFilter, withoutTokens, type StageLoginName } from "../src/core/stagetoken";
import { LOGIN_TOKEN_FILE } from "../src/core/stagewire";

const say = (line: string): void => void process.stdout.write(`${line}\n`);

/** a command on the backend's host, or here when there is no host to dial */
function onHost(dest: string | null, line: string, stdin?: string): Bun.Subprocess<"ignore" | Uint8Array, "pipe", "pipe"> {
  const argv = dest === null ? ["sh", "-c", line] : ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=15", dest, line];
  return Bun.spawn(argv, { stdin: stdin === undefined ? "ignore" : new TextEncoder().encode(stdin), stdout: "pipe", stderr: "pipe" });
}

async function ended(p: Bun.Subprocess<"ignore" | Uint8Array, "pipe", "pipe">): Promise<{ code: number; words: string }> {
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  return { code, words: withoutTokens(`${err}\n${out}`.trim()).split("\n").slice(-3).join(" ").trim() };
}

/** `claude setup-token` on a pty, the terminal handed through both ways,
 *  the token kept off the screen. Throws when it ends with no token. */
async function mint(): Promise<string> {
  const filter = new TokenFilter();
  const decoder = new TextDecoder();
  let hangup: ReturnType<typeof setTimeout> | undefined;
  const proc = Bun.spawn(["claude", "setup-token"], {
    env: process.env,
    terminal: {
      cols: Math.max(process.stdout.columns ?? 0, MINT_COLS),
      rows: process.stdout.rows ?? 24,
      data: (_t, chunk) => {
        process.stdout.write(filter.push(decoder.decode(chunk, { stream: true })));
        // the token is in hand: claude is given a moment to end on its own
        if (filter.token() !== null && hangup === undefined) hangup = setTimeout(() => proc.kill("SIGHUP"), 3_000);
      },
    },
  });
  const terminal = proc.terminal;
  if (!terminal) {
    proc.kill("SIGKILL");
    throw new Error("the spawn gave no terminal");
  }
  const keys = (data: Buffer): void => {
    if (!terminal.closed) terminal.write(data);
  };
  const resize = (): void => {
    if (terminal.closed) return;
    terminal.resize(Math.max(process.stdout.columns ?? 0, MINT_COLS), process.stdout.rows ?? 24);
    proc.kill("SIGWINCH");
  };
  process.stdin.setRawMode(true);
  process.stdin.resume();
  process.stdin.on("data", keys);
  process.stdout.on("resize", resize);
  let code: number;
  try {
    code = await proc.exited;
  } finally {
    clearTimeout(hangup);
    process.stdin.off("data", keys);
    process.stdout.off("resize", resize);
    process.stdin.setRawMode(false);
    process.stdin.pause();
    if (!terminal.closed) terminal.close();
  }
  process.stdout.write(`${filter.push(decoder.decode())}${filter.end()}\n`);
  const token = filter.token();
  if (token === null) throw new Error(code === 0 ? "claude setup-token ended without printing a token" : `claude setup-token ended with exit ${code} and no token`);
  return token;
}

/** One turn with the token and nothing else to sign in with: a fresh config
 *  folder, no API key in the environment. Throws with claude's own words
 *  when Anthropic does not take it, so a token cut short never lands. */
async function proves(token: string): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), "canopy-token-"));
  try {
    const env: Record<string, string> = {};
    for (const [k, v] of Object.entries(process.env)) if (v !== undefined && !k.startsWith("ANTHROPIC_") && !k.startsWith("CLAUDE_CODE_USE_")) env[k] = v;
    const p = Bun.spawn(["claude", "-p", "Reply with the one word ok."], {
      cwd: dir,
      env: { ...env, CLAUDE_CONFIG_DIR: dir, CLAUDE_CODE_OAUTH_TOKEN: token },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const slow = setTimeout(() => p.kill("SIGKILL"), 120_000);
    const r = await ended(p).finally(() => clearTimeout(slow));
    if (r.code !== 0) throw new Error(`Anthropic did not take the new token: ${r.words || `claude -p ended with exit ${r.code}`}`);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function main(): Promise<number> {
  const plan = parseTokenArgs(process.argv.slice(2), process.env, process.platform);
  if (!plan.ok) {
    console.error(plan.error);
    return 2;
  }
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("stage-token needs a terminal: claude setup-token waits for a browser approval");
    return 2;
  }
  if (!Bun.which("claude")) {
    console.error("no claude on PATH here; run this on a machine that has it");
    return 2;
  }
  const where = plan.dest === null ? "this host" : `${plan.backend} (${plan.dest})`;
  // before any token is made: a host that cannot be reached, or has no place for one, mints nothing
  for (const name of plan.logins) {
    const r = await ended(onHost(plan.dest, folderCheck(LOGIN_SITES[name])));
    if (r.code !== 0) {
      console.error(`${where} has no ${LOGIN_SITES[name].folder} to save into${r.words ? `: ${r.words}` : ""}`);
      return 1;
    }
  }
  const done: StageLoginName[] = [];
  for (const name of plan.logins) {
    const site = LOGIN_SITES[name];
    say(`\n== a token for ${site.whose} on ${where}. Approve it in the browser when it asks.`);
    try {
      const token = await mint();
      say("asking Anthropic whether the token works");
      await proves(token);
      const saved = await ended(onHost(plan.dest, saveCommand(site), `${token}\n`));
      if (saved.code !== 0) throw new Error(`could not save it on ${where}: ${saved.words || `exit ${saved.code}`}`);
    } catch (err) {
      console.error(`stage-token: ${withoutTokens(err instanceof Error ? err.message : String(err))}`);
      if (done.length > 0) console.error(`saved before this: ${done.join(", ")}`);
      return 1;
    }
    done.push(name);
    say(`saved as ${site.folder}/${LOGIN_TOKEN_FILE} on ${where}`);
  }
  say(`\ndone. Within 15 seconds ${plan.backend === "here" ? "this backend" : plan.backend}'s health page reads "signed in with a token" for: ${done.map((n) => LOGIN_CHECK[n]).join(", ")}.`);
  return 0;
}

if (import.meta.main) process.exit(await main());
