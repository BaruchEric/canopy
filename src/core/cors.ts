/** The origins another canopy page may drive this backend from, read off
 *  `CANOPY_ORIGINS` (comma separated). Only exact http(s) origins survive,
 *  so a typo cannot widen it and a `*` is never one. */
export function parseOrigins(raw: string | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const part of raw.split(",")) {
    const v = part.trim();
    if (!v) continue;
    try {
      const u = new URL(v);
      if ((u.protocol === "http:" || u.protocol === "https:") && u.origin === v) out.push(v);
    } catch {
      // not an origin
    }
  }
  return out;
}

/** The CORS headers for a listed origin: that origin back, never `*`, with
 *  credentials so the gate's cookie rides along. Null for anything else. */
export function corsHeaders(origin: string | null, origins: readonly string[]): Record<string, string> | null {
  if (!origin || !origins.includes(origin)) return null;
  return { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true", Vary: "Origin" };
}

/** What a preflight from a listed origin is told on top of `corsHeaders`:
 *  the methods and the one header the client sends. */
export const PREFLIGHT_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Methods": "GET, POST, DELETE, PATCH",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Max-Age": "600",
};
