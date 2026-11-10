/** A request's body, read no further than a cap. A route that checks
 *  `content-length` and then reads the body whole trusts a header that a
 *  request sent in chunks does not carry: the read then holds whatever
 *  arrives, up to the server's own cap (just over the largest body any route
 *  takes, about 101 MB), before the route can say it is too big. */

/** The body's bytes, or null once it passes `max`: a length over the cap is
 *  refused unread, and a read that passes it stops there and lets the rest
 *  go. No body reads as no bytes. */
export async function bodyUpTo(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null> {
  if (Number(req.headers.get("content-length") ?? 0) > max) return null;
  if (!req.body) return new Uint8Array(0);
  const reader = req.body.getReader();
  const parts: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => undefined);
      return null;
    }
    parts.push(value);
  }
  const out = new Uint8Array(size);
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}
