/**
 * Writes the fixtures canopy-auth's Rust tests check against, from the TS
 * modules themselves: the route table (`needs`, `normalPath`), the origin
 * gate, and a callers.json minted by the TS CallerBook with the tokens that
 * open it. From the repo root:
 *   bun rust/crates/canopy-auth/scripts/gen-fixtures.ts src rust/crates/canopy-auth/tests/fixtures
 */
import { mkdirSync, readFileSync, writeFileSync, copyFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

const src = process.argv[2];
const out = process.argv[3];
if (!src || !out) throw new Error("usage: bun gen-fixtures.ts <src root> <out dir>");
mkdirSync(out, { recursive: true });

const { needs, normalPath, LANES, KIND_RIGHTS } = await import(join(src, "core/callers.ts"));
const { libraryOriginAllowed, returnLeg, coordApiHost, tailnetHost, openBind } = await import(join(src, "core/library.ts"));
const { parseOrigins } = await import(join(src, "core/cors.ts"));
const { CallerBook } = await import(join(src, "server/callers.ts"));
const { isLoopback, isLoopbackHost } = await import(join(src, "core/client.ts"));

/* ---------- the route table ---------- */

const CODE: Record<string, string> = { open: "o", read: "r", plan: "p", operate: "O", shell: "s", admin: "a", helper: "h" };
const METHODS = ["GET", "HEAD", "POST", "DELETE", "PATCH", "PUT", "OPTIONS"];
const text = readFileSync(join(src, "core/callers.ts"), "utf8");
const literals = new Set<string>();
for (const m of text.matchAll(/"([^"\\\s]*)"/g)) literals.add(m[1]!.replace(/\/\*$/, ""));
const paths = new Set<string>();
for (const l of literals) {
  for (const base of [`/api/${l}`, `/api/repos/${l}`, `/${l}`, `/library/${l}`]) {
    for (const v of [base, `${base}/`, `${base}/x`, `${base}x`, `${base}//`, `${base};x`, `${base}%2F`]) paths.add(v);
  }
}
const odd = [
  "/", "", "/api", "/api/", "/api//", "//api/tree", "/api//tree", "/API/tree", "/api/tree/", "/api/runs?kept=1",
  "/library", "/library/", "/library//", "/library/index.html", "/library/ports", "/library/ping", "/library/manifest",
  "/library/api/dev/state", "/library/api/ports/state", "/library/api/files", "/api/library", "/api/library/", "/api/library/sync",
  "/api/library/sync/status", "/api/library/sync/", "/api/libraryx", "/libraryx", "/library/open", "/library/open;x", "/library//open",
  "/library/open%3Bx", "/library/open/", "/library/ports;x", "/library//ports", "/library/ports/", "/library/api%2Fdev%2Fstate",
  "/library/%70ing", "/library/ping%zz", "/library/ping%", "/library/ping%2", "/library/ping?x=1", "/library/caf%C3%A9",
  "/library/%E2%82", "/library/%ED%A0%80", "/api/term", "/api/term/", "/api/helper", "/api/helper/", "/api/events", "/api/auth",
  "/api/auth/", "/api/authx", "/api/runs/r-1a2b3c", "/api/runs/", "/api/runs", "/api/hooks/", "/api/hooks", "/api/sweep/",
  "/api/sweeping", "/api/clips/", "/api/café", "/api/\u{1F332}", "/assets/index-abc123.js", "/index.html", "/x/",
];
for (const p of odd) paths.add(p);
const table: [string, string][] = [];
for (const p of [...paths].sort()) table.push([p, METHODS.map((m) => CODE[needs(m, p)]).join("")]);

const normalCases = [
  "/a", "/a;b", "/a?b", "/a;b?c", "/a?b;c", "//a//b///c", "/%61", "/%2F", "/%2f", "/%25", "/%zz", "/%", "/%a", "/%A",
  "/caf%C3%A9", "/café", "/%E2%82", "/%E2%82%AC", "/%ED%A0%80", "/%F4%90%80%80", "/%C0%AF", "/%80", "/%C3", "/%C3x",
  "/%C3é", "/%F0%9F%8C%B2", "/%00", "/a%3Bb", "/a%3Fb", ";x", "?x", "", "/", "///", "/a/%2F/b", "/%2F%2F", "/+%20",
];
const normal = normalCases.map((p) => [p, normalPath(p)]);

const lanes = Object.fromEntries(Object.entries(LANES).map(([k, v]) => [k, [...(v as Set<string>)]]));
writeFileSync(join(out, "needs.json"), `${JSON.stringify({ methods: METHODS, codes: CODE, table, normal, lanes, kindRights: KIND_RIGHTS })}\n`);

/* ---------- the origin gate ---------- */

const hostsList = ["127.0.0.1:7850", "localhost:7850", "[::1]:7850", "localhost", "127.0.0.1", "100.68.139.95:7850", "100.63.0.1", "macmini-2018:7850",
  "macmini-2018.tail2d2c60.ts.net:7850", "canopy.example", "canopy.example:443", "canopy.example.evil", "10.250.14.1:7850", "10.250.14.1:7851",
  "erics-macbook-pro.tail2d2c60.ts.net:7850", "127.0.0.1.evil.example", "canopy-mac.example", "[::1]", "LocalHost:80"];
const originsList = [null, "", "null", "http://127.0.0.1:7850", "http://localhost:7850", "https://canopy.example", "https://evil.example",
  "http://macmini-2018:7850", "https://erics-macbook-pro.tail2d2c60.ts.net:7850", "http://10.250.14.1:7850", "https://canopy-mac.example",
  "http://canopy.example", "http://[::1]:7850", "http://100.68.139.95:7850", "http://localhost"];
const sites = [null, "same-origin", "same-site", "cross-site", "none"];
const protos = [null, "https", "http"];
const configs = [
  { publicOrigin: null, open: false, origins: [], hosts: [] },
  { publicOrigin: "https://canopy.example", open: false, origins: [], hosts: [] },
  { publicOrigin: "https://canopy.example/", open: false, origins: [], hosts: [] },
  { publicOrigin: "http://canopy.example", open: false, origins: [], hosts: [] },
  { publicOrigin: "not a url", open: false, origins: [], hosts: [] },
  { publicOrigin: null, open: true, origins: [], hosts: [] },
  { publicOrigin: null, open: false, origins: ["https://canopy-mac.example", "https://erics-macbook-pro.tail2d2c60.ts.net:7850"], hosts: [] },
  { publicOrigin: null, open: true, origins: [], hosts: ["10.250.14.1:7850"] },
];
const gatePaths = ["/api/tree", "/api/linear/callback"];
// the whole grid, in this loop order; two bits a case: the gate's answer,
// then its answer on the request returnLeg hands it
let bits = "";
for (const host of hostsList) {
  for (const o of originsList) {
    for (const site of sites) {
      for (const proto of protos) {
        for (const c of configs) {
          for (const path of gatePaths) {
            const headers: Record<string, string> = {};
            if (o !== null) headers["origin"] = o;
            if (site !== null) headers["sec-fetch-site"] = site;
            if (proto !== null) headers["x-forwarded-proto"] = proto;
            const url = `http://${host}${path}`;
            const req = new Request(url, { headers });
            const want = libraryOriginAllowed(req, c.publicOrigin ?? undefined, c.open, c.origins, c.hosts);
            const leg = libraryOriginAllowed(returnLeg(req, new URL(url)), c.publicOrigin ?? undefined, c.open, c.origins, c.hosts);
            bits += `${want ? 1 : 0}${leg ? 1 : 0}`;
          }
        }
      }
    }
  }
}
// a POST to the return leg keeps its cross-site mark
const post = (() => {
  const url = "http://127.0.0.1:7850/api/linear/callback";
  const req = new Request(url, { method: "POST", headers: { "sec-fetch-site": "cross-site" } });
  return { want: libraryOriginAllowed(req), leg: libraryOriginAllowed(returnLeg(req, new URL(url))) };
})();
const grid = { hosts: hostsList, origins: originsList, sites, protos, configs, paths: gatePaths, bits, post };
const coordApi = [undefined, "", " ", "http://10.250.14.1:7850", " http://10.250.14.1:7850/ ", "https://x.example", "https://x.example:443/a", "http://x:80",
  "10.250.14.1:7850", "ftp://10.250.14.1:7850", "http://[::1]:7850", "HTTP://X.EXAMPLE:8080", "http://", "not a url", "﻿http://bom.example"]
  .map((v) => [v ?? null, coordApiHost(v)]);
const tailnet = ["100.64.0.1", "100.127.255.254", "100.63.0.1", "100.128.0.1", "100.0064.1.1", "100.64.1", "100.64.1.1.1", "mini.tail2d2c60.ts.net",
  "ts.net", ".ts.net", "mini", "", "mini.example.com", "[::1]", "localhost", "100.99999999999999999999.1.1", "x.ts.net.evil", "100.٤٤.1.1"]
  .map((h) => [h, tailnetHost(h)]);
const originsRaw = [undefined, "", " https://canopy.beric.ca , http://macmini-2018:7850 ", "https://a.example/x,*,ftp://b.example,,https://c.example",
  "HTTPS://X.EXAMPLE", "https://x.example:443", "http://x.example:80", "http://x.example:8080", "https://x.example/", "http://[::1]:7850",
  "﻿https://bom.example", "https://é.example", "https://xn--9ca.example", "http://user@x.example", "https://x.example?q", "null"]
  .map((v) => [v ?? null, parseOrigins(v)]);
const binds = [undefined, "", "127.0.0.1", "localhost", "::1", "[::1]", "0.0.0.0", "100.68.139.95", " 127.0.0.1"].map((v) => [v ?? null, openBind(v)]);
const loopAddrs = ["127.0.0.1", "::1", "::ffff:127.0.0.1", "127.5.6.7", "127.", "128.0.0.1", "100.68.139.95", "", "::ffff:127.0.0.2"].map((a) => [a, isLoopback(a)]);
const loopHosts = ["localhost", "[::1]", "127.0.0.1", "127.0.0.9", "127.1", "127.0.0.1.evil", "evil.example", "LOCALHOST", "::1", "127.١.0.0"].map((h) => [h, isLoopbackHost(h)]);
writeFileSync(join(out, "origin.json"), `${JSON.stringify({ grid, coordApi, tailnet, originsRaw, binds, loopAddrs, loopHosts })}\n`);

/* ---------- a book minted by the TS ---------- */

const bookDir = join(out, "ts-book");
rmSync(bookDir, { recursive: true, force: true });
mkdirSync(bookDir, { recursive: true });
const work = join(out, ".work");
rmSync(work, { recursive: true, force: true });
mkdirSync(work, { recursive: true });
const file = join(work, "callers.json");
const T0 = 1_700_000_000_000;
let t = T0;
const book = new CallerBook({ file, now: () => t });
const minted: { token: string; caller: unknown }[] = [];
const mint = (kind: string, opts: Record<string, string>): string => {
  const got = book.mint(kind, opts);
  minted.push(got);
  return got.caller.id;
};
book.localCaller();
mint("page", { label: 'laptop "quoted" \\ back' });
mint("cli", { label: "cli mac\u0001ctl\ttab\nline" });
mint("shell", { label: "sh café", term: "t1" });
mint("ranger", { label: "ranger \u{1F332}", run: "r1" });
mint("coordinator", { label: "coordinator web", run: "co1" });
mint("run", { label: "run app", run: "r2", user: "p-abcdefgh" });
const helperId = mint("helper", { label: "helper mini" });
mint("page", { label: "owner phone", user: "owner" });
mint("page", { label: "member phone  sep", user: "p-averyave" });
await book.flush();
copyFileSync(file, join(bookDir, "callers.json"));
// one check two minutes on writes the bump, then a revoke
t += 2 * 60 * 1000;
const bumped = book.check(minted[0]!.token);
const revoked = await book.revoke(helperId);
await book.flush();
copyFileSync(file, join(bookDir, "callers-after.json"));
writeFileSync(join(bookDir, "tokens.json"), `${JSON.stringify({ t0: T0, minted, bumpedId: bumped?.id ?? null, revokedId: helperId, revoked, list: book.list() }, null, 2)}\n`);

// a messy file read back by the TS and written again after one bump
const sha = (s: string): string => createHash("sha256").update(s).digest("hex");
const messy = [
  { hash: sha("cnp_page_fixture"), id: "keepme01", kind: "page", label: "kept", created: T0, used: T0, extra: "dropped", user: "owner" },
  { id: "nohash01", kind: "page", label: "x", created: T0, used: T0 },
  { hash: sha("cnp_admin_x"), id: "badkind1", kind: "admin", label: "x", created: T0, used: T0 },
  { hash: sha("cnp_page_y"), id: "strtime1", kind: "page", label: "x", created: "1", used: T0 },
  { hash: sha("cnp_shell_z"), id: "numterm1", kind: "shell", label: "z", created: T0, used: T0, term: 5, run: "r9", user: "p-zzzzzzzz" },
  null,
  7,
  "str",
  [1],
  { hash: sha("cnp_cli_w"), id: 3, kind: "cli", label: "x", created: T0, used: T0 },
  { hash: sha("cnp_cli_v"), id: "nolabel1", kind: "cli", created: T0, used: T0 },
];
const messyFile = join(work, "messy.json");
writeFileSync(messyFile, JSON.stringify(messy));
copyFileSync(messyFile, join(bookDir, "messy.json"));
t = T0;
const messyBook = new CallerBook({ file: messyFile, now: () => t });
t += 2 * 60 * 1000;
const messyCheck = messyBook.check("cnp_page_fixture");
await messyBook.flush();
copyFileSync(messyFile, join(bookDir, "messy-after.json"));
writeFileSync(join(bookDir, "messy.json.expect"), `${JSON.stringify({ checked: messyCheck, list: messyBook.list() }, null, 2)}\n`);
rmSync(work, { recursive: true, force: true });

console.log(`needs: ${table.length} paths x ${METHODS.length} methods, normalPath: ${normal.length}, origin: ${bits.length / 2} cases, book: ${minted.length} tokens`);
