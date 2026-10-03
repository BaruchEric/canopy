/** The stage runner's entry, bundled into the stages image. With --health it
 *  is compose's healthcheck instead: exit 0 when the runner answers a hello
 *  on its socket, 1 when it does not. */
import { readFileSync } from "node:fs";
import { StageClient } from "../core/stageclient";
import { ownPidNamespace, startStageRunner } from "./runner";

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
// The orphan sweep kills every process outside the runs and docker exec's,
// which is right only in the stages container's own pid namespace: on a
// host it would be the whole session.
const proc = (path: string): string => {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
};
const sweepOrphans = process.platform === "linux" && ownPidNamespace(proc("/proc/self/status"), process.pid, proc("/proc/1/comm"));
await startStageRunner({ socket, root, sweepOrphans });
console.log(`canopy-stage-runner on ${socket}, seeds under ${root}`);
console.log(sweepOrphans ? "orphans are swept at each run's end and every 30 s" : "no pid namespace of its own: orphans are not swept");
