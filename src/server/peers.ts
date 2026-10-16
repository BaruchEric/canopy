/**
 * The peer routes and the peering queue they share with the whole-tree
 * pass. The pass itself (refreshPeers, peerPass) stays in index.ts, which
 * routes here and hands over its state and helpers through `PeerDeps`.
 *
 *   GET  /api/peers           { self, peers, seen, sync }
 *   POST /api/peers/sync      kicks the pass in the background: 202 with {}
 *   POST /api/repos/peer?id=  { action: "sync" | "take" | "track" | "seed", peer?, branch? }:
 *                             the repo, and `take` with where a take landed
 */
import { busyWith } from "../core/actions";
import type { Flows } from "../core/flow";
import { initRepo, PassSeen, seedRepo, syncRepo, takeWip, trackBranch } from "../core/peersync";
import type { Runner } from "../core/runner";
import type { CanopyConfig, PeerSeen, PeerState, Repo } from "../core/types";

const json = (body: unknown, status = 200): Response => Response.json(body, { status });

/** A peer route's refusal, carrying the status the client should see. */
export class PeerError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** What the peer routes reach of the server: the slice of its state they
 *  read (and the queue writes), and the helpers the pass shares with them. */
export interface PeerDeps {
  state: {
    root: string;
    peering: Promise<void> | null;
    peerSeen: PeerSeen[];
    runner: Pick<Runner, "activeFor">;
    flows: Pick<Flows, "activeFor">;
  };
  peerSettings: () => Promise<Pick<CanopyConfig, "self" | "peers" | "peerSync" | "seed">>;
  refreshPeers: () => Promise<void>;
  peerable: (repo: Repo) => boolean;
  applyPeerState: (id: string, st: PeerState) => void;
  refreshAndBroadcast: (id: string) => Promise<Repo>;
}

/** Runs `job` through the peering queue (withPeering), but coalesces
 *  repeat calls: while a job started this way is still pending (queued
 *  behind something else, or running), a second call returns that same
 *  promise instead of enqueueing job() again behind it. `pending` is a
 *  separate field from the queue itself (state.peering), since the queue
 *  alone cannot tell "a pass is next in line" from "a pass is one of
 *  several things next in line" - only this call site knows which of its
 *  own requests are for the same job. Exported for a direct unit test of
 *  the coalescing, alongside withPeering. */
export function queuePass(state: { peering: Promise<void> | null; pendingPass: Promise<void> | null }, job: () => Promise<void>): Promise<void> {
  if (state.pendingPass) return state.pendingPass;
  const run = withPeering(state, job);
  state.pendingPass = run.finally(() => {
    state.pendingPass = null;
  });
  return state.pendingPass;
}

const PEER_ACTIONS = ["sync", "take", "track", "seed"] as const;
export type PeerAction = (typeof PEER_ACTIONS)[number];
const isPeerAction = (v: unknown): v is PeerAction => (PEER_ACTIONS as readonly unknown[]).includes(v);

/** Runs one /api/repos/peer action through the peering queue, every
 *  action and not only sync: a pass running alongside a take could
 *  fast-forward the branch between takeWip's HEAD check and its read-tree,
 *  and a track or seed writes to the same repo the pass is working in.
 *  Exported for a direct unit test of the queue ordering. */
export function runPeerAction<T>(state: { peering: Promise<void> | null }, action: PeerAction, ops: Record<PeerAction, () => Promise<T>>): Promise<T> {
  return withPeering(state, ops[action]);
}

/** A true FIFO queue over `state.peering`, not just a wait-then-run: every
 *  writer of `state.peering` goes through here, the whole-tree pass
 *  (queuePass, wrapping this) included, so it is the one and only queue,
 *  never bypassed by a direct write. Each caller chains itself onto
 *  whatever the field currently holds (the pass, or an earlier queued
 *  caller here) and replaces it with its own tail *synchronously*, before
 *  awaiting the one it replaced. Two callers arriving back to back
 *  therefore never both see the same holder and race to run `fn`
 *  together: the second always sees the first's tail, not the original
 *  holder. A route action (sync's initRepo and syncRepo, a take, a track,
 *  a seed) must never touch the same repo's config, refs or files as the
 *  pass, or another queued action, at the same time. Exported for a direct unit test of
 *  the queue ordering: takes just the slice of ServerState it needs, so a
 *  test can drive it against a bare `{ peering: null }`. */
export async function withPeering<T>(state: { peering: Promise<void> | null }, fn: () => Promise<T>): Promise<T> {
  const prev = state.peering;
  const run = (async () => {
    if (prev) await prev.catch(() => {});
    return fn();
  })();
  const tail: Promise<void> = run.then(
    () => undefined,
    () => undefined,
  );
  state.peering = tail;
  void tail.finally(() => {
    // Only clear the field if nothing has queued behind us since: a later
    // caller's own tail is what state.peering must still point to.
    if (state.peering === tail) state.peering = null;
  });
  return run;
}

/** GET /api/peers */
export async function getPeers(d: PeerDeps): Promise<Response> {
  const s = await d.peerSettings();
  return json({ self: s.self, peers: s.peers, seen: d.state.peerSeen, sync: s.peerSync });
}

/** POST /api/peers/sync */
export function postPeersSync(d: PeerDeps): Response {
  void d.refreshPeers().catch((err) => console.error("canopy: peer pass", err));
  return json({}, 202);
}

/** POST /api/repos/peer, for the repo the id named */
export async function postRepoPeer(d: PeerDeps, repo: Repo, req: Request): Promise<Response> {
  const state = d.state;
  if (!d.peerable(repo)) throw new PeerError(400, "peer sync covers local repos under the launch root");
  const raw: unknown = await req.json().catch(() => null);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new PeerError(400, "malformed body");
  const body = raw as { action?: unknown; peer?: unknown; branch?: unknown };
  const bodyAction = body.action;
  if (!isPeerAction(bodyAction)) throw new PeerError(400, `unknown action: ${String(body.action)}`);
  const s = await d.peerSettings();
  if (!s.self) throw new PeerError(400, "peers are not set up: no self in the config");
  const self = s.self;
  // Off blocks every action; dry (below) governs only the background
  // pass and this route's own "sync" — take and track are explicit user
  // actions and always run for real.
  if (s.peerSync === "off") throw new PeerError(409, "peer sync is off");
  const needPeer = bodyAction === "take" || bodyAction === "track";
  if (needPeer) {
    if (typeof body.peer !== "string" || body.peer === "") throw new PeerError(400, "peer is required");
    if (typeof body.branch !== "string" || body.branch === "") throw new PeerError(400, "branch is required");
  }
  const peer = s.peers.find((p) => p.name === body.peer);
  if (needPeer && !peer) throw new PeerError(404, `unknown peer: ${String(body.peer)}`);
  // The same conflicts the run action refuses on: a Claude run or a
  // workflow already has this repo, and initRepo/syncRepo/takeWip could
  // step on files or refs either of those is using.
  const activeRun = state.runner.activeFor(repo.id);
  if (activeRun) throw new PeerError(409, busyWith(repo.name, activeRun.verb));
  if (state.flows.activeFor(repo.id)) throw new PeerError(409, "a workflow is running here");
  const dry = s.peerSync === "dry";
  let take: unknown;
  try {
    // Only take answers with something; the rest answer the repo alone.
    take = await runPeerAction<unknown>(state, bodyAction, {
      sync: async () => {
        await initRepo(repo.path, repo.id, s.peers, dry);
        d.applyPeerState(repo.id, await syncRepo(repo.id, { self, peers: s.peers, seed: s.seed, dry, root: state.root }, new PassSeen()));
      },
      take: () => takeWip(repo.path, peer!.name, body.branch as string),
      track: () => trackBranch(repo.path, peer!.name, body.branch as string),
      seed: async () => {
        await seedRepo(repo.path, repo.id, s.peers, s.seed, dry);
      },
    });
  } catch (err) {
    if (err instanceof PeerError) throw err;
    throw new PeerError(409, String(err instanceof Error ? err.message : err));
  }
  const fresh = await d.refreshAndBroadcast(repo.id);
  return json(take ? { ...fresh, take } : fresh);
}
