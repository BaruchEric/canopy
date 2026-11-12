/** The route table and the rights each kind of caller holds, pure and
 *  browser-safe so the UI can name the right a 403 wanted. The server checks
 *  `needs(method, path)` against `allows(kind, right)` at the top of route().
 *
 *  The default denies: a route that is not a GET and not in the table needs
 *  `admin`, so a new route is safe until someone files it here. A GET needs
 *  `read` unless the table names it, and `read` is held by every caller with
 *  a token and by nobody without one: the tree, the lists of runs, flows and
 *  shells, the notes and the event stream all take a token. What a caller
 *  with no token gets is the short list filed `open`: the page's own files,
 *  what signing in needs, and the few answers a script with no token asks
 *  for (`OPEN_READS` below). */

export type Right = "read" | "plan" | "operate" | "shell" | "admin" | "helper";
export type CallerKind = "page" | "cli" | "shell" | "ranger" | "coordinator" | "run" | "helper" | "none";

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
  run: ["read", "plan"],
  helper: ["helper"],
  // nobody known reads nothing: only an `open` route answers
  none: [],
};

/** What a kind held to a lane may call, method and exact path; a kind with no
 *  entry is held by the table alone. A coordinator gets the reads its brief
 *  (lib/coordinator.md) names, /api/about, and its plan. A run gets the reads
 *  its tools make and the four plan routes, each of which also holds a run's
 *  token to its own run in its handler (FR-038). */
export const LANES: Partial<Record<CallerKind, ReadonlySet<string>>> = {
  coordinator: new Set(["GET /api/about", "GET /api/tree", "GET /api/runs", "GET /api/landing", "POST /api/coordinator/plan"]),
  run: new Set([
    "GET /api/tree",
    "GET /api/runs",
    "GET /api/landing",
    "GET /api/health",
    "GET /api/auth",
    "POST /api/runs/child",
    "POST /api/runs/say",
    "POST /api/ranger/wakes",
    "POST /api/work/note",
  ]),
};

/** `open` routes are the ones pairing needs before a caller has a token.
 *  Whoever may operate may also plan: a page or the CLI posts a plan for any
 *  coordinator, which a coordinator's own token may do for its run alone. */
export const allows = (kind: CallerKind, right: Right | "open"): boolean =>
  right === "open" || KIND_RIGHTS[kind].includes(right) || (right === "plan" && KIND_RIGHTS[kind].includes("operate"));

type Rule = { methods: readonly string[]; paths: readonly string[]; right: Right | "open" };

const POST = ["POST"];
const DEL = ["DELETE"];
const POST_DEL = ["POST", "DELETE"];
const REPO_OPERATE = ["run", "flow", "resume", "stage", "commit", "push", "dropstale", "pull", "unlock", "note", "favorite", "harness", "spec", "suggest", "refresh"];

/** The GETs a caller with no token gets, each for a reason. `about` is the
 *  build and the machine's name, which a deploy checks came up. `auth` says
 *  the mode and who the caller is, and leaves the callers out for anyone who
 *  is not an admin. `going` is what a redeploy would cut off: ids, repos and
 *  states, with none of an agent's words. `terms/watched` answers a hook in a
 *  shell with one boolean. Linear's app install is a browser's navigation
 *  and its return, which carry no header. */
const OPEN_READS = ["about", "auth", "going", "terms/watched", "linear/install", "linear/callback"];

/** Paths are written without `/api/`. A trailing `/*` matches anything below. */
const RULES: readonly Rule[] = [
  { methods: ["GET"], paths: OPEN_READS, right: "open" },
  // Removing kept transcripts is a hand's job, like the sweep's closes.
  { methods: POST, paths: ["runs/prune"], right: "admin" },
  // a run read by its id is its whole transcript, kept or live, and so are
  // its export and its replay: an agent reads files aloud there, so it is a
  // hand's to read. The list of runs carries a live run's steps and is a
  // plain read: any token, a run's and a coordinator's included.
  { methods: ["GET"], paths: ["runs/*"], right: "operate" },
  // what is in a repo is a hand's to read, as a shell's screen is: a file's
  // bytes (an .env's among them), a diff, the log, a search, a session's
  // transcript, a task's output. The tree says which repos there are and how
  // each stands, and is a plain read; anything read out of one is a hand's,
  // a repo read nobody has written yet included. A landing's diff and
  // the host's folders (the picker's listing) go the same way.
  { methods: ["GET"], paths: ["repos/*", "landing/diff", "browse"], right: "operate" },
  // a search across repos reads their files
  { methods: POST, paths: ["grep"], right: "operate" },
  // auth/ticket is open here because its route checks the right the ticket is
  // for (shell, helper or the event stream's read); a helper token has no read
  // right to pass this table with
  { methods: POST, paths: ["auth/pair", "auth/claim", "auth/first", "auth/ticket"], right: "open" },
  // a trigger's hook comes from Sentry or Linear, which send no token; the hub checks
  // the delivery's signature against the rule's secret before it reads a word
  { methods: POST, paths: ["hooks/*"], right: "open" },
  { methods: POST, paths: ["triggers/*"], right: "operate" },
  { methods: DEL, paths: ["triggers/events"], right: "operate" },
  // a permission hook in any terminal asks whether a remembered rule covers
  // its call, and outside a canopy shell it has no token to ask with; the
  // answer is the one rule's words or nothing
  { methods: POST, paths: ["remembered/check"], right: "open" },
  { methods: POST, paths: ["repos/movecheck"], right: "read" },
  // stopping a turn ends what the agent was doing, as a stop does, so a
  // run's token, which holds plan alone, never interrupts another run
  { methods: POST, paths: ["runs/answer", "runs/stop", "runs/fork", "runs/interrupt"], right: "operate" },
  // a coordinator's token holds plan alone: it proposes cards, and editing
  // them or starting them is the user's
  { methods: POST, paths: ["coordinator/plan"], right: "plan" },
  // what a run's token may do beyond reading (FR-038). Whoever operates may
  // plan, so the rest keep these routes; a run's handler holds it to its own
  // run, and the coordinator's lane leaves these out
  { methods: POST, paths: ["runs/child", "runs/say", "ranger/wakes", "work/note"], right: "plan" },
  { methods: POST, paths: ["coordinator/tasks", "coordinator/start"], right: "operate" },
  { methods: DEL, paths: ["runs", "flows", "jobs"], right: "operate" },
  { methods: POST, paths: ["flows/resume", "flows/stop", "fleet/stop", "jobs/stop"], right: "operate" },
  { methods: POST_DEL, paths: ["fleet", "repos/health", "incubator", "layouts"], right: "operate" },
  { methods: DEL, paths: ["ranger/wakes"], right: "operate" },
  { methods: ["POST", "DELETE", "PATCH"], paths: ["workspaces"], right: "operate" },
  { methods: POST, paths: ["workspaces/run", "workspaces/open"], right: "operate" },
  { methods: POST, paths: REPO_OPERATE.map((a) => `repos/${a}`), right: "operate" },
  { methods: POST, paths: ["repos/tasks", "repos/tasks/def"], right: "operate" },
  { methods: POST, paths: ["work/*"], right: "operate" },
  // a note is a hand's jot: a shell's or the CLI's token may add one, mark it done or drop it (FR-020)
  { methods: POST_DEL, paths: ["notes", "notes/*"], right: "operate" },
  // a clipboard holds whatever was copied, so even reading it is a hand's: a
  // page, the CLI or a shell's token may read, keep, pin and drop clips, and a
  // caller with no token never sees them (FR-054)
  { methods: ["GET"], paths: ["clips", "clips/*"], right: "operate" },
  { methods: POST_DEL, paths: ["clips", "clips/*"], right: "operate" },
  { methods: POST, paths: ["landing/*", "groups/*", "prs/*", "incubator/*"], right: "operate" },
  // reading the windows now and starting a held start as interactive are a
  // hand's; the thresholds are the admin's (POST capacity, below)
  { methods: POST, paths: ["capacity/read", "capacity/release"], right: "operate" },
  // prune removes what the landing section's remove already lets operate remove
  { methods: POST, paths: ["worktrees/prune"], right: "operate" },
  // a kept worktree is a shell's to make and drop: an agent in one spins
  // its siblings up the way worktrunk's does
  { methods: POST, paths: ["trees/add", "trees/remove", "trees/merge", "trees/clean", "trees/sync", "trees/auto"], right: "operate" },
  { methods: POST, paths: ["tailchan/send", "tailchan/put", "tailchan/notify"], right: "operate" },
  // what was said on tailchan and the files put there are a hand's to read,
  // as sending is: a run's and a coordinator's token read neither
  { methods: ["GET"], paths: ["tailchan", "tailchan/read", "tailchan/blob"], right: "operate" },
  { methods: POST, paths: ["asks/answer", "presence", "presence/beat", "layouts/reset", "rescan", "preview"], right: "operate" },
  // a browser subscribes itself to push (FR-042) with its own page token; the
  // handler also wants the token's kind to be page, since shells and the
  // ranger hold operate too. The list and a test push are the admin's;
  // push/key is a plain read.
  { methods: POST_DEL, paths: ["push/subscribe"], right: "operate" },
  { methods: POST, paths: ["push/test"], right: "admin" },
  { methods: ["GET"], paths: ["push"], right: "admin" },
  // a voice session is billed by the minute on the backend's key, and a
  // dictated clip goes to the backend's speech model; a call's end writes
  // its minutes to the cost ledger
  { methods: POST, paths: ["voice/session", "voice/live", "voice/dictate", "voice/ended"], right: "operate" },
  {
    methods: POST,
    paths: ["terms/restore", "terms/paste", "terms/move/out", "terms/move/finish", "terms/move/undo", "repos/agent", "repos/movein"],
    right: "shell",
  },
  // typing a line or a key into a shell from outside its terminal is what
  // its socket does, so it takes the same right
  {
    methods: POST,
    paths: ["terms/say", "terms/keys"],
    right: "shell",
  },
  { methods: DEL, paths: ["terms", "terms/kept"], right: "shell" },
  // a move's reads go with its writes: the plan names the agent's session
  // and its last prompt, and the transcript is its whole conversation
  { methods: ["GET"], paths: ["terms/move/plan", "terms/move/transcript"], right: "shell" },
  // what a shell shows can be anything typed or printed there, a key
  // included, so its screen, its text and its agent's transcript are a
  // hand's to read, as the clipboard is: a run's token never sees them. The
  // list of shells and the facts about one (terms/agent) are plain reads.
  { methods: ["GET"], paths: ["terms/screen", "terms/text", "terms/transcript"], right: "operate" },
  // Admin is also the default; these are written out so the test can pin them.
  { methods: POST, paths: ["agents/profile", "agents/role", "peers/sync", "repos/peer", "keep", "awake", "worktrees/warm", "health/heal", "remembered/forget", "capacity"], right: "admin" },
  { methods: POST_DEL, paths: ["sources"], right: "admin" },
  { methods: POST, paths: ["sources/rescan", "kit/*", "secrets/*", "ranger", "ranger/restart", "ranger/fresh"], right: "admin" },
  // a plugin catalog or details read runs the agent's CLI on that machine
  // (over ssh for gpd), and a commit's preview runs git in its ~/.claude,
  // so a run's token, which only reads, starts none of them
  { methods: ["GET"], paths: ["kit/plugins/catalog", "kit/plugins/details", "kit/plugins/commit"], right: "operate" },
  { methods: POST, paths: ["auth/approve", "auth/deny", "auth/revoke"], right: "admin" },
  { methods: ["PUT"], paths: ["guards"], right: "admin" },
  // the sweep's reads too: its plan names every shell and chat here, and an
  // agent in a shell (which holds operate) must never close the rest
  { methods: ["GET", "POST", "DELETE"], paths: ["sweep", "sweep/*"], right: "admin" },
  // the set's text is the holdout: a page or the CLI reads it, a shell or the
  // ranger does not; names and a run are for everyone who operates
  { methods: ["GET"], paths: ["scenarios"], right: "admin" },
  { methods: POST_DEL, paths: ["scenarios"], right: "admin" },
  { methods: POST, paths: ["scenarios/run"], right: "operate" },
  {
    methods: POST,
    paths: ["repos/archive", "repos/open", "repos/openfile", "repos/emulator", "repos/launch", "repos/halt", "repos/install", "repos/uninstall", "repos/build", "repos/launcher"],
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

/** the table's right for a path written without `/api/`, if it has one */
const ruled = (method: string, rel: string): Right | "open" | undefined =>
  exact.get(`${method} ${rel}`) ?? prefixes.find((p) => p.method === method && rel.startsWith(p.prefix))?.right;

/** The Library GETs that only read: the dashboard and its ports page (the
 *  Library view's iframe loads both, and a frame's load carries no token, so
 *  these are `open`), the engine's ping, manifest and state reads, and its
 *  file listing, which stays inside the root. Every other Library GET needs
 *  `admin`: `/open`
 *  launches an editor, a terminal or a dev server, and a path the engine
 *  reads differently from this table (`/open;x` is `/open` to Python's
 *  urlparse) must not slip past it. */
const LIBRARY_READS: ReadonlySet<string> = new Set([
  "/api/library",
  "/api/library/sync",
  "/api/library/sync/status",
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
  if (isLibrary) return method === "GET" && libraryRead(path) ? "open" : "admin";
  const clean = path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
  if (method === "GET") {
    if (clean === "/api/term") return "shell";
    if (clean === "/api/helper") return "helper";
    // outside the API a GET is one of the page's own files, which hold
    // nothing a sign-in guards
    if (!clean.startsWith("/api/")) return "open";
    // an API GET reads unless the table says otherwise
    return ruled(method, clean.slice("/api/".length)) ?? "read";
  }
  if (!clean.startsWith("/api/")) return "admin";
  return ruled(method, clean.slice("/api/".length)) ?? "admin";
}
