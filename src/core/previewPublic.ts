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
