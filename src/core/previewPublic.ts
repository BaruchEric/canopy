/**
 * Preview ports under public names, for a page on canopy's public https
 * address: that page cannot frame the backend's own http ports, so each
 * slot gets a hostname of its own on the tunnel (`CANOPY_PREVIEW_PUBLIC`,
 * say `https://canopy-p{slot}.beric.ca`). One name per slot keeps two apps
 * off one origin, the same reason the slots are ports and not paths.
 * Browser-safe: the server and the panel both read it.
 */

/** the template, or null for anything that is not an https origin with
 *  `{slot}` in its hostname and nothing after it */
export function parsePreviewPublic(raw: string | undefined): string | null {
  const s = (raw ?? "").trim().replace(/\/$/, "");
  const m = /^https:\/\/([a-z0-9.-]*\{slot\}[a-z0-9.-]*)$/i.exec(s);
  return m ? s : null;
}

/** the origin one slot answers on */
export function publicPreviewOrigin(template: string, slot: number): string {
  return template.replace("{slot}", String(slot));
}

/** `CANOPY_PREVIEW_HOST`: the address another machine's plain http page
 *  reaches this backend's preview ports at, its tailnet IP. An IP rather
 *  than a MagicDNS name, since `*.ts.net` is on the HSTS preload list and a
 *  browser upgrades every http frame on it to https, which the slots do not
 *  speak. Null for anything else, and for loopback or the unspecified
 *  address, which name no other machine's way in. */
export function parsePreviewHost(raw: string | undefined): string | null {
  const s = (raw ?? "").trim();
  if (!/^(\d{1,3}(\.\d{1,3}){3}|\[[0-9a-f:]+\])$/i.test(s)) return null;
  if (s.startsWith("127.") || s === "0.0.0.0" || s === "[::1]" || s === "[::]") return null;
  return s;
}
