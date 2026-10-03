/** The stage runner's entry, bundled into the stages image. */
import { startStageRunner } from "./runner";

const socket = process.env["CANOPY_STAGE_SOCKET"];
const root = process.env["CANOPY_STAGE_ROOT"];
if (!socket || !root) {
  console.error("canopy-stage-runner needs CANOPY_STAGE_SOCKET and CANOPY_STAGE_ROOT");
  process.exit(2);
}
await startStageRunner({ socket, root });
console.log(`canopy-stage-runner on ${socket}, seeds under ${root}`);
