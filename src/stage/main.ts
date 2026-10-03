/** The stage runner's entry, bundled into the stages image. With --health it
 *  is compose's healthcheck instead: exit 0 when the runner answers a hello
 *  on its socket, 1 when it does not. */
import { StageClient } from "../core/stageclient";
import { startStageRunner } from "./runner";

const socket = process.env["CANOPY_STAGE_SOCKET"];
const root = process.env["CANOPY_STAGE_ROOT"];
if (!socket || !root) {
  console.error("canopy-stage-runner needs CANOPY_STAGE_SOCKET and CANOPY_STAGE_ROOT");
  process.exit(2);
}
if (process.argv.includes("--health")) {
  // an empty harness list is still an answer: the runner is up
  process.exit((await new StageClient(socket).hello(2000)) ? 0 : 1);
}
await startStageRunner({ socket, root });
console.log(`canopy-stage-runner on ${socket}, seeds under ${root}`);
