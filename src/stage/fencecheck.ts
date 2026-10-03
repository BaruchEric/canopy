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

/** Any HTTP answer is open, a 403 or a redirect too; a refusal, a drop or
 *  the 4 s timeout is blocked. */
export async function probe(t: FenceTarget, fetchFn: FetchFn = fetch): Promise<"blocked" | "open"> {
  try {
    await fetchFn(t.url, { redirect: "manual", signal: AbortSignal.timeout(4000) });
    return "open";
  } catch {
    return "blocked";
  }
}

if (import.meta.main) {
  let bad = 0;
  for (const t of fenceTargets(process.env)) {
    const got = await probe(t);
    if (got === t.expect) {
      console.log(`ok  ${t.name}`);
    } else {
      bad++;
      console.log(`BAD ${t.name}: expected ${t.expect}, got ${got}`);
    }
  }
  process.exit(bad ? 1 : 0);
}
