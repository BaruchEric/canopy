/** Which folder `canopy peers init|sync|take|track|seed` works on. The root
 *  decides where a missing repo gets cloned, so it is never the current
 *  directory: run from inside one repo, that once cloned a peer's whole
 *  workspace into it. `--root` wins; otherwise the running backend says
 *  which folder it scans, as long as it is this machine's own backend. */

/** What GET /api/peers said, or why it said nothing. */
export type PeersAnswer =
  | { ok: true; self: string | null; root?: unknown }
  | { ok: false; reason: string };

export function peersRoot(flag: string | undefined, self: string, backend: string, answer: PeersAnswer): { root: string } | { error: string } {
  if (flag !== undefined) return { root: flag };
  const pass = "pass --root <the folder canopy ui scans>";
  if (!answer.ok) return { error: `no --root, and ${backend} could not say which folder it scans (${answer.reason}); ${pass}` };
  if (answer.self !== self) return { error: `the backend at ${backend} is ${answer.self ?? "unnamed"}, not this machine (${self}); ${pass}` };
  if (typeof answer.root !== "string" || answer.root === "") return { error: `the backend at ${backend} does not say which folder it scans; ${pass}` };
  return { root: answer.root };
}
