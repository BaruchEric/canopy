/**
 * canopy's side of the secrets service's socket: one request line out, one
 * reply line back, then the connection closes. A service that is down or
 * slow is one answer, SECRETS_AWAY, so the page can say so.
 */

import { connect } from "node:net";
import { encodeLine, LIMITS, parseReply, type SecretsReply, type SecretsRequest } from "./secretwire";

export const SECRETS_AWAY = "the secrets service is not answering";

export function askSecrets(socket: string, req: SecretsRequest, timeoutMs = 15_000): Promise<SecretsReply> {
  return new Promise((resolve) => {
    let buf = "";
    let settled = false;
    const sock = connect(socket);
    const done = (r: SecretsReply): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      sock.destroy();
      resolve(r);
    };
    const timer = setTimeout(() => done({ ok: false, error: SECRETS_AWAY }), timeoutMs);
    sock.setEncoding("utf8");
    sock.on("connect", () => sock.write(encodeLine(req)));
    sock.on("data", (chunk: string) => {
      buf += chunk;
      if (buf.length > LIMITS.line * 2) return done({ ok: false, error: "the secrets service answered more than a reply holds" });
      const nl = buf.indexOf("\n");
      if (nl !== -1) done(parseReply(buf.slice(0, nl)) ?? { ok: false, error: "the secrets service answered something unreadable" });
    });
    sock.on("error", () => done({ ok: false, error: SECRETS_AWAY }));
    sock.on("close", () => done({ ok: false, error: SECRETS_AWAY }));
  });
}
