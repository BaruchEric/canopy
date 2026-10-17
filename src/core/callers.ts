/** The route table and the rights each kind of caller holds, pure and
 *  browser-safe so the UI can name the right a 403 wanted. The server checks
 *  `needs(method, path)` against `allows(kind, right)` at the top of route().
 *
 *  The default denies: a route that is not a GET and not in the table needs
 *  `admin`, so a new route is safe until someone files it here. */

export type Right = "read" | "plan" | "operate" | "shell" | "admin" | "helper";
export type CallerKind = "page" | "cli" | "shell" | "ranger" | "coordinator" | "helper" | "none";

/** the kinds a pair request may ask for: the ones a person or a helper
 *  signs in as, and never a shell, ranger or coordinator */
export type PairKind = "page" | "cli" | "helper";
export const PAIR_KINDS: readonly PairKind[] = ["page", "cli", "helper"];

/** The kind a label names, for a request that does not say: "cli " a CLI,
 *  "helper " a helper, anything else a page. */
export const kindOfLabel = (label: string): PairKind => (label.startsWith("cli ") ? "cli" : label.startsWith("helper ") ? "helper" : "page");

export const KIND_RIGHTS: Record<CallerKind, readonly Right[]> = {
  page: ["read", "operate", "shell", "admin"],
  cli: ["read", "operate", "admin"],
  shell: ["read", "operate"],
  ranger: ["read", "operate"],
  coordinator: ["read", "plan"],
  helper: ["helper"],
  none: ["read"],
};

/** `open` routes are the ones pairing needs before a caller has a token. */
export const allows = (kind: CallerKind, right: Right | "open"): boolean =>
  right === "open" || KIND_RIGHTS[kind].includes(right);

type Rule = { methods: readonly string[]; paths: readonly string[]; right: Right | "open" };

const POST = ["POST"];
const DEL = ["DELETE"];
const POST_DEL = ["POST", "DELETE"];
const REPO_OPERATE = ["run", "flow", "resume", "stage", "commit", "push", "pull", "unlock", "note", "favorite", "spec", "suggest", "refresh"];

/** Paths are written without `/api/`. A trailing `/*` matches anything below. */
const RULES: readonly Rule[] = [
  // auth/ticket is open here because its route checks the right the ticket is
  // for (shell or helper); a helper token has no read right to pass this table with
  { methods: POST, paths: ["auth/pair", "auth/claim", "auth/first", "auth/ticket"], right: "open" },
  { methods: POST, paths: ["grep", "remembered/check", "repos/movecheck"], right: "read" },
  { methods: POST, paths: ["runs/answer", "runs/stop", "runs/say"], right: "operate" },
  { methods: DEL, paths: ["runs", "flows", "jobs"], right: "operate" },
  { methods: POST, paths: ["flows/resume", "flows/stop", "fleet/stop", "jobs/stop"], right: "operate" },
  { methods: POST_DEL, paths: ["fleet", "repos/health", "incubator", "ranger/wakes", "layouts"], right: "operate" },
  { methods: ["POST", "DELETE", "PATCH"], paths: ["workspaces"], right: "operate" },
  { methods: POST, paths: ["workspaces/run", "workspaces/open"], right: "operate" },
  { methods: POST, paths: REPO_OPERATE.map((a) => `repos/${a}`), right: "operate" },
  { methods: POST, paths: ["repos/tasks", "repos/tasks/def"], right: "operate" },
  { methods: POST, paths: ["landing/*", "prs/*", "incubator/*"], right: "operate" },
  { methods: POST, paths: ["tailchan/send", "tailchan/put", "tailchan/notify"], right: "operate" },
  { methods: POST, paths: ["asks/answer", "presence", "presence/beat", "layouts/reset", "rescan", "preview"], right: "operate" },
  {
    methods: POST,
    paths: ["terms/restore", "terms/paste", "terms/move/out", "terms/move/finish", "terms/move/undo", "repos/agent", "repos/movein"],
    right: "shell",
  },
  { methods: DEL, paths: ["terms", "terms/kept"], right: "shell" },
  // Admin is also the default; these are written out so the test can pin them.
  { methods: POST, paths: ["agents/profile", "agents/role", "peers/sync", "repos/peer", "keep", "health/heal", "remembered/forget"], right: "admin" },
  { methods: POST_DEL, paths: ["sources"], right: "admin" },
  { methods: POST, paths: ["sources/rescan", "kit/*", "secrets/*", "ranger", "ranger/restart", "ranger/fresh"], right: "admin" },
  { methods: POST, paths: ["auth/approve", "auth/deny", "auth/revoke"], right: "admin" },
  { methods: ["PUT"], paths: ["guards"], right: "admin" },
  {
    methods: POST,
    paths: ["repos/archive", "repos/open", "repos/openfile", "repos/launch", "repos/halt", "repos/install", "repos/uninstall", "repos/build", "repos/launcher"],
    right: "admin",
  },
];

const exact = new Map<string, Right | "open">();
const prefixes: { method: string; prefix: string; right: Right | "open" }[] = [];
for (const r of RULES) {
  for (const method of r.methods) {
    for (const p of r.paths) {
      if (p.endsWith("/*")) prefixes.push({ method, prefix: p.slice(0, -1), right: r.right });
      else exact.set(`${method} ${p}`, r.right);
    }
  }
}

/** The Library GETs that only read: the dashboard and its ports page (the
 *  Library view's iframe loads both, and a frame's load carries no token),
 *  the engine's ping, manifest and state reads, and its file listing, which
 *  stays inside the root. Every other Library GET needs `admin`: `/open`
 *  launches an editor, a terminal or a dev server, and a path the engine
 *  reads differently from this table (`/open;x` is `/open` to Python's
 *  urlparse) must not slip past it. */
const LIBRARY_READS: ReadonlySet<string> = new Set([
  "/api/library",
  "/library",
  "/library/",
  "/library/index.html",
  "/library/ports",
  "/library/ping",
  "/library/manifest",
  "/library/api/dev/state",
  "/library/api/ports/state",
  "/library/api/files",
]);

/** A path cut at `;` and `?`, its repeated slashes collapsed and
 *  percent-decoded once; null when it will not decode. */
export function normalPath(path: string): string | null {
  const cut = path.split(/[;?]/, 1)[0] ?? "";
  try {
    return decodeURIComponent(cut.replace(/\/{2,}/g, "/"));
  } catch {
    return null;
  }
}

/** Whether a Library GET only reads: a path already in normal form, on the
 *  allowlist as written. */
const libraryRead = (path: string): boolean => normalPath(path) === path && LIBRARY_READS.has(path);

/** The right a request needs. `path` is the URL path, with or without a
 *  trailing slash outside the Library, where the path must match exactly. */
export function needs(method: string, path: string): Right | "open" {
  const isLibrary = path === "/api/library" || path.startsWith("/api/library/") || path === "/library" || path.startsWith("/library/");
  if (isLibrary) return method === "GET" && libraryRead(path) ? "read" : "admin";
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (method === "GET") {
    if (clean === "/api/term") return "shell";
    if (clean === "/api/helper") return "helper";
    return "read";
  }
  if (!clean.startsWith("/api/")) return "admin";
  const rel = clean.slice("/api/".length);
  const hit = exact.get(`${method} ${rel}`);
  if (hit) return hit;
  return prefixes.find((p) => p.method === method && rel.startsWith(p.prefix))?.right ?? "admin";
}
