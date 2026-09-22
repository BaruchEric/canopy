/**
 * The helper daemon: `canopy helper` on a client machine. It dials the
 * backend's `/api/helper` websocket with its name, platform and openers in
 * the query, then runs each intent the backend sends through the same
 * openers the server uses on a Mac (`openIn`, `openFile`, `openGroup`) and
 * answers under the intent's id. The socket is kept up for as long as the
 * process runs: a drop is retried at doubling waits up to 30s. Bun-only; the
 * protocol it speaks is `helper.ts`, pure and tested.
 */
import { hostname } from "node:os";
import { helperOpeners, parseHelperIntent, type HelperIntent, type HelperReply } from "./helper";
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
  let ws: WebSocket | null = null;
  let stopped = false;
  let wait = 1_000;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let connected = false;

  const reply = (r: HelperReply) => {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(r));
  };

  const dial = () => {
    if (stopped) return;
    const sock = new WebSocket(url);
    ws = sock;
    sock.onopen = () => {
      connected = true;
      wait = 1_000;
      log(`registered with ${opts.backend} as ${name} (${openers.join(", ") || "no openers"})`);
    };
    sock.onmessage = (ev) => {
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
      const was = connected;
      connected = false;
      if (ws === sock) ws = null;
      if (stopped) return;
      const why = ev.reason ? `: ${ev.reason}` : "";
      log(was ? `lost the backend${why}, retrying in ${wait / 1000}s` : `cannot reach ${opts.backend}${why}, retrying in ${wait / 1000}s`);
      timer = setTimeout(dial, wait);
      wait = Math.min(wait * 2, 30_000);
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
      ws?.close();
      ws = null;
    },
    get connected() {
      return connected;
    },
  };
}
