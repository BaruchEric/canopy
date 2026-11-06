/** Preloaded by `bun test` (bunfig.toml). A shell inside the deployed
 *  container carries the backend's own env: `NODE_ENV=production`, which
 *  `peerSettingsFromEnv` refuses, and the compose service's CANOPY_ names,
 *  which change what the server under test does. Bun sets `NODE_ENV=test`
 *  only when it is unset, so the suite resets them itself; a test that wants
 *  one sets it. */
import { setDefaultTimeout } from "bun:test";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";

process.env["NODE_ENV"] = "test";

// Every CANOPY_ name goes, whoever set it. A canopy shell on the Mac carries
// the launchd server's settings: CANOPY_CALLERS=enforce makes every test
// server refuse the suite's calls with a 401, and CANOPY_ORIGINS and
// CANOPY_PREVIEW_PUBLIC change what it allows. The shell's own names
// (INHERITED_ENV in core/term.ts) would name another server's API and token
// to every CLI call and shell a test starts. A shell in a compose container
// carries the service's: CANOPY_STAGE_SOCKET gives a test server the live
// stage runner, which reports its stages check up and keeps seeds home, so
// a move of one is refused for the wrong reason; and CANOPY_TMUX=1, read as
// a secret, redacted every "1" in a test run's transcript. A list of names
// missed whichever one the next deploy added. A name ending in _IT is a live
// test's opt-in (CANOPY_CODEX_IT) and stays.
for (const k of Object.keys(process.env)) {
  if ((k.startsWith("CANOPY_") && !k.endsWith("_IT")) || k === "TAILCHAN_AS") delete process.env[k];
}

// Bun loads the checkout's .env before this runs. On the mini that is the
// compose settings (docs/deploy.md): TAILCHAN_URL, which gives every test
// server a broker and its shells a tailchan handle, and the deploy's tokens.
// The Mac's checkout has none, so every name in it goes.
let dotenv = "";
try {
  dotenv = readFileSync(".env", "utf8");
} catch {
  // no .env here
}
for (const line of dotenv.split("\n")) {
  const name = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=/.exec(line)?.[1];
  if (name) delete process.env[name];
}

// Bun runs a test in UTC unless TZ is set, and the suite's dates count on
// that. The mini's .env and its shells set TZ to the host's zone, and
// deleting TZ (above) leaves Bun in that zone; assigning one moves it.
process.env["TZ"] = "Etc/UTC";

// Shell tests start dozens of interactive login shells under $SHELL, and a
// zsh login runs the user's ~/.zshrc each time. On the Mac that file starts a
// background find over /private/var/folders per shell; they pile up until the
// timing tests time out. bash with no ~/.bashrc work keeps the suite quiet,
// and a test that wants another shell sets SHELL itself. TMUX goes too: run
// from inside a canopy shell, it makes a test's tmux attach refuse to nest.
process.env["SHELL"] = "/bin/bash";
delete process.env["TMUX"];

// A unix socket path holds 103 characters on macOS, and a test server's tmux
// socket sits at <tmpdir>/canopy-<name>-XXXXXX/config/tmux.sock. The system
// tmpdir is 48 characters, which fits; a tool that nests its own folder
// under $TMPDIR (context-mode's sandbox, at 65) does not, and every test
// that starts a server then fails with "File name too long". /tmp fits.
if (tmpdir().length > 56) process.env["TMPDIR"] = "/tmp";

// Bun's 5 s default is too tight for the tests that start a server, a tmux
// session or a git clone while the rest of the suite runs: under load (a
// merge running the gates in several trees at once) one such test or its
// beforeEach hook went over on five tries in a row, a different one each
// time, and each passed alone. 20 s is the default for every test and hook;
// a file or a test that sets its own keeps it.
setDefaultTimeout(20_000);
