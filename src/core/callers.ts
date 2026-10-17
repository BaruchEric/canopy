/** The route table and the rights each kind of caller holds, pure and
 *  browser-safe so the UI can name the right a 403 wanted. The server checks
 *  `needs(method, path)` against `allows(kind, right)` at the top of route().
 *
 *  The default denies: a route that is not a GET and not in the table needs
 *  `admin`, so a new route is safe until someone files it here. */

export type Right = "read" | "plan" | "operate" | "shell" | "admin" | "helper";
export type CallerKind = "page" | "cli" | "shell" | "ranger" | "coordinator" | "helper" | "none";

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

/** The right a request needs. `path` is the URL path, with or without a
 *  trailing slash. */
export function needs(method: string, path: string): Right | "open" {
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  const isLibrary = clean === "/api/library" || clean.startsWith("/api/library/") || clean.startsWith("/library/");
  if (method === "GET") {
    if (clean === "/api/term") return "shell";
    if (clean === "/api/helper") return "helper";
    // the Library engine's /open launches an editor, a terminal or a dev
    // server: a GET that runs a command is a write
    if (clean === "/library/open") return "admin";
    return "read";
  }
  if (isLibrary) return "admin";
  if (!clean.startsWith("/api/")) return "admin";
  const rel = clean.slice("/api/".length);
  const hit = exact.get(`${method} ${rel}`);
  if (hit) return hit;
  return prefixes.find((p) => p.method === method && rel.startsWith(p.prefix))?.right ?? "admin";
}
