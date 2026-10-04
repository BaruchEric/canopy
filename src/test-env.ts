/** Preloaded by `bun test` (bunfig.toml). A shell inside the deployed
 *  container carries the backend's own env: `NODE_ENV=production`, which
 *  `peerSettingsFromEnv` refuses, and `CANOPY_BIND`/`CANOPY_PUBLIC_ORIGIN`/
 *  `CANOPY_SSH_HOST`, which change what the server under test does. Bun sets
 *  `NODE_ENV=test` only when it is unset, so the suite resets them itself;
 *  a test that wants one sets it. */
import { readFileSync } from "node:fs";

process.env["NODE_ENV"] = "test";
for (const k of ["CANOPY_BIND", "CANOPY_PUBLIC_ORIGIN", "CANOPY_SSH_HOST", "CANOPY_NO_DESKTOP"]) delete process.env[k];

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
