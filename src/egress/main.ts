/** The egress proxy's entry, bundled into the stages image as
 *  /app/egress-proxy.js and run as compose's coord-proxy service. It
 *  listens on CANOPY_EGRESS_PORT (3128) inside its container; compose
 *  publishes that on the coordinator bridge's gateway alone. With --health
 *  it is the healthcheck instead: exit 0 when the proxy answers a GET with
 *  its 405, 1 otherwise. */
import { connect } from "node:net";
import { EGRESS_PORT, startEgressProxy } from "./proxy";
import { ALLOWED_HOSTS } from "./allow";

const raw = process.env["CANOPY_EGRESS_PORT"] ?? "";
const port = raw ? Number(raw) : EGRESS_PORT;
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  console.error(`canopy-egress: CANOPY_EGRESS_PORT must be a port, not ${raw}`);
  process.exit(2);
}

if (process.argv.includes("--health")) {
  const ok = await new Promise<boolean>((done) => {
    const s = connect(port, "127.0.0.1");
    let got = "";
    const t = setTimeout(() => (s.destroy(), done(false)), 2000);
    s.on("connect", () => s.write("GET / HTTP/1.1\r\nHost: health\r\n\r\n"));
    s.on("data", (d) => {
      got += d.toString("latin1");
      if (got.includes("\r\n")) {
        clearTimeout(t);
        s.destroy();
        done(got.startsWith("HTTP/1.1 405 "));
      }
    });
    s.on("error", () => (clearTimeout(t), done(false)));
  });
  process.exit(ok ? 0 : 1);
}

const p = await startEgressProxy({ host: "0.0.0.0", port });
console.log(`canopy-egress on :${p.port}, CONNECT to ${ALLOWED_HOSTS.join(", ")} on 443 and nothing else`);
const stop = (): void => void p.stop().then(() => process.exit(0));
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
