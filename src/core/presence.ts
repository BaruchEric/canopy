/**
 * Who is on the backend. A browser registers itself on the event stream's
 * query (`client=`, its own id, `name=` and `platform=`), and the server
 * folds the open streams into one `Device` per id. Browser-safe and pure:
 * `deviceName` guesses a name off the user agent for a browser that has not
 * been given one, and the parsers here are what the server checks the query
 * with. Tested in presence.test.ts.
 */
import { DEVICE_PLATFORMS, type Device, type DevicePlatform } from "./types";

/** what one open event stream said about its browser */
export interface Stream {
  id: string;
  name: string;
  platform: DevicePlatform;
  address: string;
  since: number;
}

const isPlatform = (v: string): v is DevicePlatform => (DEVICE_PLATFORMS as readonly string[]).includes(v);

/** the registration off the stream's query, or null when it carries none
 *  (an older page, a curl): such a stream is not a device */
export function parseStream(params: URLSearchParams, address: string, now = Date.now()): Stream | null {
  const id = params.get("client") ?? "";
  if (!/^[0-9a-f]{16}$/.test(id)) return null;
  const name = (params.get("name") ?? "").trim().slice(0, 40) || "a browser";
  const p = params.get("platform") ?? "other";
  return { id, name, platform: isPlatform(p) ? p : "other", address, since: now };
}

/** the open streams as devices: one per id, the newest name (a rename in
 *  one window applies to the device), the oldest `since`, oldest first */
export function devicesOf(streams: Iterable<Stream>): Device[] {
  const byId = new Map<string, Device & { named: number }>();
  for (const s of streams) {
    const d = byId.get(s.id);
    if (!d) {
      byId.set(s.id, { id: s.id, name: s.name, platform: s.platform, address: s.address, since: s.since, streams: 1, named: s.since });
      continue;
    }
    d.streams += 1;
    if (s.since < d.since) d.since = s.since;
    if (s.since >= d.named) {
      d.name = s.name;
      d.named = s.since;
    }
  }
  return [...byId.values()]
    .sort((a, b) => a.since - b.since)
    .map(({ named: _named, ...d }) => d);
}

/** the platform word off a user agent */
export function platformOf(ua: string): DevicePlatform {
  if (/iPhone|iPad|iPod/.test(ua)) return "ios";
  if (/Android/.test(ua)) return "android";
  if (/Macintosh|Mac OS X/.test(ua)) return "mac";
  if (/Windows/.test(ua)) return "windows";
  if (/Linux|X11/.test(ua)) return "linux";
  return "other";
}

/** a browser's guess at its own name: the platform and the browser, which
 *  is what tells a phone from a laptop in the devices list until the user
 *  names it in settings */
export function deviceName(ua: string): string {
  const os =
    platformOf(ua) === "ios" ? "iPhone"
    : platformOf(ua) === "android" ? "Android"
    : platformOf(ua) === "mac" ? "Mac"
    : platformOf(ua) === "windows" ? "Windows"
    : platformOf(ua) === "linux" ? "Linux"
    : "Browser";
  const browser =
    /Edg\//.test(ua) ? "Edge"
    : /OPR\//.test(ua) ? "Opera"
    : /Firefox\//.test(ua) ? "Firefox"
    : /Chrome\//.test(ua) ? "Chrome"
    : /Safari\//.test(ua) ? "Safari"
    : "";
  return browser ? `${os}, ${browser}` : os;
}

/** a fresh client id: 16 hex digits */
export function newClientId(random: () => number = Math.random): string {
  let out = "";
  for (let i = 0; i < 16; i++) out += Math.floor(random() * 16).toString(16);
  return out;
}
