/**
 * Run inside the stages container: what the fence must refuse (canopy, the
 * broker, the bridge gateway, the LAN) and what it must let through (the
 * internet the agents talk to). Bundled into the stages image as
 * /app/fence-check.js, since that image holds no canopy CLI.
 */
export interface FenceTarget {
  name: string;
  url: string;
  expect: "blocked" | "open";
}
export const STAGES_GATEWAY = "10.250.13.1";

export function fenceTargets(env: Record<string, string | undefined>): FenceTarget[] {
  const tail = env["CANOPY_FENCE_TAILNET_IP"];
  const lan = env["CANOPY_FENCE_LAN_IP"];
  const out: FenceTarget[] = [];
  if (tail) {
    out.push({ name: "canopy on the tailnet", url: `http://${tail}:7850/api/about`, expect: "blocked" });
    out.push({ name: "tailchan broker", url: `http://${tail}:7855/`, expect: "blocked" });
  }
  out.push({ name: "the bridge gateway", url: `http://${STAGES_GATEWAY}:7850/`, expect: "blocked" });
  if (lan) out.push({ name: "the LAN", url: `http://${lan}/`, expect: "blocked" });
  out.push({ name: "the internet", url: "https://api.anthropic.com/", expect: "open" });
  return out;
}

/** Bun's `typeof fetch` also carries `preconnect`, which a plain function
 *  does not have, so the parameter is the call shape alone. */
export type FetchFn = (url: string, init?: RequestInit) => Promise<Response>;

export type ProbeResult = "blocked" | "open" | "error";

/** A connection the far end refused or reset: a packet reached a host.
 *  Bun's own codes and node's, since the image's bun may say either. */
const REACHED = new Set(["ConnectionRefused", "ECONNREFUSED", "ECONNRESET", "ConnectionClosed"]);

/** What a fetch's failure says about the path. The fence drops, so a fenced
 *  packet ends in the timeout and nothing else does; a lookup or certificate
 *  failure says nothing about the fence and must not pass as open. */
export function classify(err: unknown): ProbeResult {
  if (err instanceof Error || err instanceof DOMException) {
    if (err.name === "TimeoutError") return "blocked";
    const code = (err as { code?: unknown }).code;
    if (typeof code === "string" && REACHED.has(code)) return "open";
  }
  return "error";
}

/** One probe, with what the failure said when there was one. */
export async function reach(t: FenceTarget, fetchFn: FetchFn = fetch): Promise<{ result: ProbeResult; why?: string }> {
  try {
    await fetchFn(t.url, { redirect: "manual", signal: AbortSignal.timeout(4000) });
    return { result: "open" };
  } catch (err) {
    const code = (err as { code?: unknown } | null)?.code;
    const why = typeof code === "string" ? code : err instanceof Error ? err.message : String(err);
    return { result: classify(err), why };
  }
}

/** Any HTTP answer is open, a 403 or a redirect too, and so is a refusal or
 *  a reset; only the 4 s timeout is blocked; anything else is an error. */
export async function probe(t: FenceTarget, fetchFn: FetchFn = fetch): Promise<ProbeResult> {
  return (await reach(t, fetchFn)).result;
}

if (import.meta.main) {
  let bad = 0;
  for (const t of fenceTargets(process.env)) {
    const { result, why } = await reach(t);
    if (result === t.expect) {
      console.log(`ok  ${t.name}`);
    } else {
      bad++;
      console.log(`BAD ${t.name}: expected ${t.expect}, got ${result}${why ? ` (${why})` : ""}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
