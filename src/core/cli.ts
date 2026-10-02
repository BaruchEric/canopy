/** canopy's own CLI, for a workflow check's shell. The check runs in the
 *  repo the step worked in, and in a seed an agent may have written a
 *  `bunfig.toml` (its preload runs code) and a `.env`, both of which bun
 *  reads from its cwd. So "$CANOPY_CLI" is `bin/canopy-check`, which starts
 *  `bin/canopy.ts` under `bun --config=/dev/null --no-env-file`, and
 *  "$CANOPY_BUN" is the bun it uses: this server's own, in the container
 *  too, where neither canopy nor a login PATH's bun can be assumed. */
import { fileURLToPath } from "node:url";

export const CANOPY_CLI_PATH = fileURLToPath(new URL("../../bin/canopy.ts", import.meta.url));
export const CANOPY_CHECK_CLI = fileURLToPath(new URL("../../bin/canopy-check", import.meta.url));

/** the variables a step's check gets beside the server's own */
export const checkEnv = (): Record<string, string> => ({ CANOPY_CLI: CANOPY_CHECK_CLI, CANOPY_BUN: process.execPath });
