/**
 * The helper daemon: `canopy helper` on a client machine. It dials the
 * backend's `/api/helper` websocket with its name, platform and openers in
 * the query, then runs each intent the backend sends through the same
 * openers the server uses on a Mac (`openIn`, `openFile`, `openGroup`) and
 * answers under the intent's id. The socket is kept up for as long as the
 * process runs: a drop is retried at doubling waits up to 30s, and a backend
 * that goes without closing (its host reboots) is found by the ping every
 * `HELPER_PING`, since nothing else would ever fire. Bun-only; the protocol
 * it speaks is `helper.ts`, pure and tested.
 */
import { hostname } from "node:os";
import { HELPER_DEAD, HELPER_PING, helperOpeners, parseHelperIntent, type HelperIntent, type HelperReply } from "./helper";
import { openFile, openGroup, openIn } from "./openers";
import { DEFAULT_AGENT, type OpenerId } from "./types";

export interface HelperOptions {
  /** the backend's http(s) origin, e.g. `http://macmini-2018:7850` */
  backend: string;
  /** what this machine registers as; the hostname by default */
  name?: string;
  /** the openers to offer; what is installed here by default */
  openers?: OpenerId[];
  /** where a line of progress goes */
  log?: (line: string) => void;
  /** runs one intent; the real openers by default, a fake in tests */
  run?: (intent: HelperIntent) => Promise<void>;
  /** how often to ping the backend; `HELPER_PING` by default, short in tests */
  ping?: number;
  /** how long unanswered before the backend counts as gone; `HELPER_DEAD` */
  dead?: number;
}

/** the backend origin as the websocket url the helper dials */
export function helperUrl(backend: string, name: string, platform: string, openers: OpenerId[]): string {
  const u = new URL("/api/helper", backend);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.searchParams.set("name", name);
  u.searchParams.set("platform", platform);
  u.searchParams.set("openers", openers.join(","));
  return u.toString();
}

/** a name the backend takes: the hostname's first label, in its character set */
export function helperName(host = hostname()): string {
  const first = host.split(".")[0] ?? host;
  const safe = first.replace(/[^\w.-]/g, "-").slice(0, 64);
  return safe || "helper";
}

/** the openers this machine has, by what is on PATH (and, on a Mac, in
 *  /Applications for the apps whose CLI is not there) */
export function localOpeners(platform = process.platform): OpenerId[] {
  const has = (name: string): boolean => {
    if (Bun.which(name)) return true;
    if (platform !== "darwin") return false;
    const apps: Record<string, string> = { kitty: "/Applications/kitty.app", herdr: "/Applications/herdr.app" };
    const app = apps[name];
    return app !== undefined && Bun.file(`${app}/Contents/Info.plist`).size > 0;
  };
  return helperOpeners(platform, has);
}

/** run one intent through the openers here */
export async function runIntent(intent: HelperIntent): Promise<void> {
  if ("open" in intent) {
    const { app, path, agent, tab } = intent.open;
    await openIn(app, path, agent, { tab });
    return;
  }
  if ("file" in intent) {
    const { path, file, line } = intent.file;
    await openFile(path, file, line);
    return;
  }
  const { app, name, repos, agents } = intent.group;
  await openGroup(app, name, repos, (p) => agents[p] ?? DEFAULT_AGENT);
}

/** Keep one helper connected until `stop()` is called. Resolves the handle
 *  at once; the first connection (or its failure) is logged, not awaited,
 *  so the CLI can sit on this for the life of the process. */
export function runHelper(opts: HelperOptions): { stop: () => void; readonly connected: boolean } {
  const name = opts.name ?? helperName();
  const openers = opts.openers ?? localOpeners();
  const log = opts.log ?? (() => {});
  const run = opts.run ?? runIntent;
  const url = helperUrl(opts.backend, name, process.platform, openers);
  const every = opts.ping ?? HELPER_PING;
  const dead = opts.dead ?? HELPER_DEAD;
  let ws: WebSocket | null = null;
  let stopped = false;
  let wait = 1_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let heart: ReturnType<typeof setInterval> | null = null;
  let connected = false;

  const reply = (r: HelperReply) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(r));
  };

  const stopHeart = () => {
    if (heart) clearInterval(heart);
    heart = null;
  };

  /** This socket is done, however it ended: the retry is armed here and
   *  nowhere else, and the socket's own close cannot arm a second one. */
  const retire = (sock: WebSocket, why: string) => {
    if (ws !== sock) return;
    const was = connected;
    connected = false;
    ws = null;
    stopHeart();
    sock.onclose = null;
    sock.onmessage = null;
    sock.onerror = null;
    sock.terminate();
    if (stopped) return;
    log(was ? `lost the backend${why}, retrying in ${wait / 1000}s` : `cannot reach ${opts.backend}${why}, retrying in ${wait / 1000}s`);
    timer = setTimeout(dial, wait);
    wait = Math.min(wait * 2, 30_000);
  };

  const dial = () => {
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    // Anything from the other end, a pong included, is proof its host is
    // still up; without one inside the deadline the socket is half-open and
    // no close event is ever coming, so this is what ends it.
    let seen = Date.now();
    const alive = () => {
      seen = Date.now();
    };
    sock.addEventListener("pong", alive);
    sock.addEventListener("ping", alive);
    sock.onopen = () => {
      connected = true;
      wait = 1_000;
      seen = Date.now();
      stopHeart();
      heart = setInterval(() => {
        if (ws !== sock) return;
        if (Date.now() - seen > dead) {
          retire(sock, ": it stopped answering");
          return;
        }
        if (sock.readyState === WebSocket.OPEN) sock.ping();
      }, every);
      log(`registered with ${opts.backend} as ${name} (${openers.join(", ") || "no openers"})`);
    };
    sock.onmessage = (ev) => {
      alive();
      if (typeof ev.data !== "string") return;
      const intent = parseHelperIntent(ev.data);
      if (intent === null) {
        log(`ignored a frame the helper does not read: ${ev.data.slice(0, 120)}`);
        return;
      }
      const what = "open" in intent ? `${intent.open.app} at ${intent.open.path}`
        : "file" in intent ? `${intent.file.file}:${intent.file.line} in ${intent.file.path}`
        : `${intent.group.app} for ${intent.group.repos.length} repos`;
      run(intent).then(
        () => {
          log(`opened ${what}`);
          reply({ id: intent.id, ok: true });
        },
        (e: unknown) => {
          const error = e instanceof Error ? e.message : String(e);
          log(`could not open ${what}: ${error}`);
          reply({ id: intent.id, error });
        },
      );
    };
    sock.onclose = (ev) => {
      retire(sock, ev.reason ? `: ${ev.reason}` : "");
    };
    sock.onerror = () => {
      // onclose follows with the retry; nothing to add here
    };
  };

  dial();
  return {
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      stopHeart();
      connected = false;
      ws?.close();
      ws = null;
    },
    get connected() {
      return connected;
    },
  };
}
