/** canopy's own CLI, for a workflow check's shell. bin/canopy.ts is
 *  executable with a bun shebang, so "$CANOPY_CLI" runs it wherever the
 *  checkout is, in the container too, where canopy is not on PATH. */
import { fileURLToPath } from "node:url";

export const CANOPY_CLI_PATH = fileURLToPath(new URL("../../bin/canopy.ts", import.meta.url));

/** the variables a step's check gets beside the server's own */
export const checkEnv = (): Record<string, string> => ({ CANOPY_CLI: CANOPY_CLI_PATH });
