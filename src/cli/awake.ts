/** `canopy awake`: where keep awake stands on a backend, or a new mode for
 *  it, over the backend's API (core/awake). */

import { AWAKE_MODES, awakeWords, type AwakeInfo } from "../core/types";
import { ask, errText, take, Unreachable, type Target } from "./health";

export const AWAKE_USAGE = `usage: canopy awake [${AWAKE_MODES.join("|")}] [--backend URL]`;

/** One line: the mode, and whether the machine is held right now and why not. */
export const awakeLine = (info: AwakeInfo, backend: string): string => `keep awake${backend ? ` on ${backend}` : ""}: ${info.mode}, ${awakeWords(info)}`;

export async function awakeCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  const given = take(args, "--backend");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const target: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(err instanceof Unreachable ? `the backend did not answer: ${err.message}` : errText(err));
  const word = args.shift();
  if (args.length > 0 || (word !== undefined && word !== "status" && !AWAKE_MODES.some((m) => m === word))) return fail(AWAKE_USAGE);
  const info =
    word === undefined || word === "status"
      ? await ask<AwakeInfo>(target, "GET", "/api/awake").catch(failed)
      : await ask<AwakeInfo>(target, "POST", "/api/awake", { mode: word }).catch(failed);
  console.log(awakeLine(info, given ?? ""));
}
