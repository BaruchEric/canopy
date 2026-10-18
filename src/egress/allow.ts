/**
 * The egress proxy's rules, pure: which CONNECT targets it tunnels to and
 * which resolved addresses it dials. The coordinator's fence leaves it this
 * proxy as its one way to the internet (scripts/stages-fence.sh,
 * docs/deploy.md "The coordinator"), so everything here says no unless it
 * is sure.
 */
import { isIP } from "node:net";

/** The names claude needs, each exact: the API, the OAuth token refresh
 *  (console and platform), claude.ai for the login, and statsig, which
 *  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC should leave unused. No suffix
 *  match: every subdomain let in is one more place a prompt injection could
 *  post what the coordinator read, and the refusal log names any host
 *  claude turns out to need. */
export const ALLOWED_HOSTS: readonly string[] = [
  "api.anthropic.com",
  "console.anthropic.com",
  "statsig.anthropic.com",
  "claude.ai",
  "platform.claude.com",
];

export const allowedHost = (host: string): boolean => ALLOWED_HOSTS.includes(host);

export type ConnectTarget = { host: string; port: number };
export type ConnectRefusal = { status: 400 | 403 | 405; reason: string; host?: string };

const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

/** The request head's first line, judged: a target to tunnel to, or the
 *  status to answer and why. Only `CONNECT <name>:443 HTTP/1.x` to a name
 *  on the list passes. The name is lowercased with one trailing dot taken
 *  off; an address in its place is refused, since the list holds names. */
export function parseConnect(head: string): ConnectTarget | ConnectRefusal {
  const line = head.split("\r\n", 1)[0] ?? "";
  const parts = line.split(" ");
  if (parts[0] !== "CONNECT") return { status: 405, reason: `${(parts[0] ?? "").slice(0, 16) || "an empty line"} is not CONNECT` };
  if (parts.length !== 3) return { status: 400, reason: "the request line is not CONNECT <host>:<port> HTTP/1.x" };
  const [, target = "", version = ""] = parts;
  if (version !== "HTTP/1.1" && version !== "HTTP/1.0") return { status: 400, reason: `${version.slice(0, 16)} is not HTTP/1.x` };
  if (target.startsWith("[")) return { status: 403, reason: "the target is an address, not a name" };
  const colon = target.lastIndexOf(":");
  const rawHost = colon === -1 ? target : target.slice(0, colon);
  const port = colon === -1 ? "" : target.slice(colon + 1);
  if (port !== "443") return { status: 403, reason: `port ${port.slice(0, 8) || "(none)"} is not 443` };
  if (isIP(rawHost) !== 0) return { status: 403, reason: "the target is an address, not a name" };
  const lower = rawHost.toLowerCase();
  const host = lower.endsWith(".") ? lower.slice(0, -1) : lower;
  if (!host || host.length > 253 || !host.split(".").every((l) => LABEL.test(l))) {
    return { status: 400, reason: "the target is not a host name" };
  }
  if (!allowedHost(host)) return { status: 403, reason: `${host} is not on the egress list`, host };
  return { host, port: 443 };
}

/** [first octet, second octet low, second octet high] for each blocked
 *  range that does not fall on a /8: 100.64.0.0/10, 169.254.0.0/16,
 *  172.16.0.0/12, 192.168.0.0/16 and 198.18.0.0/15 */
const BLOCKED_SECOND: readonly (readonly [number, number, number])[] = [
  [100, 64, 127],
  [169, 254, 254],
  [172, 16, 31],
  [192, 168, 168],
  [198, 18, 19],
];
/** the /24s: IETF protocol assignments and the three documentation nets */
const BLOCKED_24: readonly string[] = ["192.0.0", "192.0.2", "198.51.100", "203.0.113"];

/** Whether a resolved address is one the proxy may dial: a dotted quad
 *  outside this-network (0/8), private (10/8, 172.16/12, 192.168/16),
 *  tailnet and CGNAT (100.64/10), loopback (127/8), link-local
 *  (169.254/16), benchmarking (198.18/15), the documentation and IETF
 *  /24s, multicast (224/4) and reserved (240/4, the broadcast address in
 *  it). Anything else, v6 included, is not. */
export function isPublicV4(addr: string): boolean {
  const parts = addr.split(".");
  if (parts.length !== 4 || !parts.every((p) => /^(0|[1-9]\d{0,2})$/.test(p))) return false;
  const [a = 0, b = 0, c = 0] = parts.map(Number);
  if (parts.some((p) => Number(p) > 255)) return false;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (BLOCKED_SECOND.some(([x, lo, hi]) => a === x && b >= lo && b <= hi)) return false;
  return !BLOCKED_24.includes(`${a}.${b}.${c}`);
}
