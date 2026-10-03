/** The stage runner's entry, bundled into the stages image. With --health it
 *  is compose's healthcheck instead: exit 0 when the runner answers a hello
 *  on its socket, 1 when it does not. */
import { readFileSync } from "node:fs";
import { chmod, chown } from "node:fs/promises";
import { dirname } from "node:path";
import { StageClient } from "../core/stageclient";
import { ownPidNamespace, rootStart, socketModes, stageChores, startStageRunner } from "./runner";

// --stage-chores <seeds as JSON>: the sweep and settings check a root
// runner runs before each spawn, here as the stage user it dropped to.
// It prints one JSON line, {"refused": reason or null}.
const chores = process.argv.indexOf("--stage-chores");
if (chores !== -1) {
  if (process.getuid?.() === 0) {
    console.error("canopy-stage-runner: --stage-chores runs as the stage user, never as root");
    process.exit(2);
  }
  let seeds: unknown;
  try {
    seeds = JSON.parse(process.argv[chores + 1] ?? "");
  } catch {
    seeds = null;
  }
  if (!Array.isArray(seeds) || !seeds.every((s): s is string => typeof s === "string")) {
    console.error("canopy-stage-runner: --stage-chores takes the seed roots as a JSON list");
    process.exit(2);
  }
  process.stdout.write(`${JSON.stringify({ refused: await stageChores(process.env, seeds) })}\n`);
  process.exit(0);
}

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
// As root (the stages image), the runner drops every child to the stage
// user through setpriv, and only canopy's group reaches its socket: the
// folder is root:<caller gid> 0750, set before the socket is bound, and
// the socket 0660 once it is (amendment 4, rulings 10 and 11).
let as: { uid: number; gid: number; setpriv: string; self: string[] } | undefined;
let callerGid: number | null = null;
if (process.getuid?.() === 0) {
  const start = rootStart(process.env);
  if ("refused" in start) {
    console.error(`canopy-stage-runner: ${start.refused}`);
    process.exit(2);
  }
  const setpriv = Bun.which("setpriv", { PATH: "/usr/bin:/bin:/usr/sbin:/sbin" });
  if (!setpriv) {
    console.error("canopy-stage-runner: setpriv is not installed, so the runner cannot drop its children");
    process.exit(2);
  }
  // this same entry, for the chores child: bun and the bundled runner file
  const entry = process.argv[1];
  if (!entry) {
    console.error("canopy-stage-runner: cannot tell its own entry file, so it cannot run the chores as the stage user");
    process.exit(2);
  }
  as = { uid: start.uid, gid: start.gid, setpriv, self: [process.execPath, entry] };
  callerGid = start.callerGid;
  await socketModes(dirname(socket), null, callerGid, { chown, chmod });
}
await startStageRunner({ socket, root, sweepOrphans, ...(as ? { as } : {}) });
if (callerGid !== null) await socketModes(dirname(socket), socket, callerGid, { chown, chmod });
console.log(`canopy-stage-runner on ${socket}, seeds under ${root}`);
if (as) console.log(`stages run as ${as.uid}:${as.gid} with no groups; the socket is for group ${callerGid} alone`);
console.log(sweepOrphans ? "orphans are swept at each run's end and every 30 s" : "no pid namespace of its own: orphans are not swept");
