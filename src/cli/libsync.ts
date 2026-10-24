/** `canopy library sync`: where the Library sync stands on a backend, a pull
 *  now, or a join (`--seed`, `--adopt`), over the backend's API
 *  (server/libsync). The rest of `canopy library` goes to the engine. */

import type { LibrarySyncStatus } from "../core/libsync";
import { ask, errText, take, Unreachable, type Target } from "./health";

export const LIBRARY_SYNC_USAGE = "usage: canopy library sync [--status | --seed | --adopt BACKEND | --accept BACKEND] [--backend URL]";

/** whether `canopy library <args>` is this command and not the engine's */
export function isLibrarySync(args: readonly string[]): boolean {
  const rest = [...args];
  take(rest, "--root");
  take(rest, "--backend");
  return rest[0] === "sync";
}

const ago = (at: number, now: number): string => {
  const s = Math.max(0, Math.round((now - at) / 1000));
  return s < 90 ? `${s}s ago` : s < 5400 ? `${Math.round(s / 60)}m ago` : `${Math.round(s / 3600)}h ago`;
};

/** the status as lines: the mode and join, then a line per other backend */
export function syncLines(st: LibrarySyncStatus, now: number): string[] {
  const joined = st.joined ? `joined by ${st.joined.how}${st.joined.from ? ` from ${st.joined.from}` : ""}` : "not joined (--seed on the first backend, --adopt BACKEND on the rest)";
  const out = [`library sync on ${st.self ?? "(no self in the config)"}: ${st.mode}, ${joined}`];
  if (st.error) out.push(`  stopped: ${st.error}`);
  for (const p of st.peers) {
    const when = p.at === null ? "not pulled yet" : `pulled ${ago(p.at, now)}`;
    const how = p.held ?? p.away ?? `${p.dry ? "would take" : "took"} ${p.taken}, ${p.dry ? "would delete" : "deleted"} ${p.deleted}`;
    out.push(`  ${p.name}: ${when}, ${how}`);
    if (p.kept.length) out.push(`    kept while their folders have projects: ${p.kept.map((k) => k.slice("cat:".length)).join(", ")}`);
  }
  if (st.mode !== "off" && st.peers.length === 0) out.push("  no other backend in the config's backends");
  return out;
}

export async function librarySyncCommand(argv: string[], { fail }: { fail: (msg: string) => never }): Promise<void> {
  const args = [...argv];
  take(args, "--root");
  const given = take(args, "--backend");
  const home = (given ?? process.env["CANOPY_API"] ?? "http://127.0.0.1:7850").replace(/\/+$/, "");
  const target: Target = { name: "home", urls: [home] };
  const failed = (err: unknown): never => fail(err instanceof Unreachable ? `the backend did not answer: ${err.message}` : errText(err));
  args.shift(); // "sync"
  const adopt = take(args, "--adopt");
  const accept = take(args, "--accept");
  const seed = args.includes("--seed");
  const status = args.includes("--status");
  const left = args.filter((a) => a !== "--seed" && a !== "--status");
  const picked = [adopt !== undefined, accept !== undefined, seed, status].filter(Boolean).length;
  if (left.length > 0 || picked > 1 || adopt === "" || accept === "") return fail(LIBRARY_SYNC_USAGE);
  const st = status
    ? await ask<LibrarySyncStatus>(target, "GET", "/api/library/sync/status").catch(failed)
    : await ask<LibrarySyncStatus>(
        target,
        "POST",
        "/api/library/sync",
        adopt !== undefined ? { action: "adopt", backend: adopt } : accept !== undefined ? { action: "accept", backend: accept } : { action: seed ? "seed" : "pull" },
        60_000,
      ).catch(failed);
  for (const line of syncLines(st, Date.now())) console.log(line);
}
