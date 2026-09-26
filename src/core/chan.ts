/**
 * The tailchan client the server uses: one method per broker call canopy
 * makes, over an injected fetch so tests can hand it a stand-in broker, and
 * a stream that reconnects the way the CLI's `watch` does. Reads its address
 * the way the CLI does, so a machine with the CLI set up needs nothing new.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asChanMessage, parseSse, readQuery, type ChanTarget } from "./tailchan";
import type { ChanChannel, ChanMessage, ChanWho } from "./types";

export interface ChanConfig {
  url: string;
  /** the handle the UI speaks as */
  as: string;
  /** canopy's own handle and the channel it posts to */
  bot: string;
  channel: string;
}

/** KEY=value lines, as the CLI's config file has them; quotes stripped */
export function parseEnvFile(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of text.split("\n")) {
    const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)=(.*)$/.exec(line);
    if (!m) continue;
    const [, key = "", raw = ""] = m;
    out[key] = raw.trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

/**
 * The broker's address and the handles, or null when there is no address:
 * `CANOPY_TAILCHAN_URL`, else `TAILCHAN_URL`, else the CLI's config file.
 * The UI's handle is `CANOPY_TAILCHAN_AS`, else `TAILCHAN_HUMAN` from the
 * env or that file, else `canopy-user`.
 */
export function chanConfig(env: Record<string, string | undefined>, file: Record<string, string>): ChanConfig | null {
  const url = (env.CANOPY_TAILCHAN_URL || env.TAILCHAN_URL || file.TAILCHAN_URL || "").replace(/\/+$/, "");
  if (!/^https?:\/\/\S+$/.test(url)) return null;
  return {
    url,
    as: (env.CANOPY_TAILCHAN_AS || env.TAILCHAN_HUMAN || file.TAILCHAN_HUMAN || "canopy-user").toLowerCase(),
    bot: (env.CANOPY_TAILCHAN_BOT || "canopy").toLowerCase(),
    channel: (env.CANOPY_TAILCHAN_CHANNEL || "canopy").replace(/^#/, "").toLowerCase(),
  };
}

/** chanConfig off this process's env and the CLI's config file. Under
 *  `bun test` the file is not read, so a test server never dials the real
 *  broker because the machine running the tests has the CLI set up. */
export function loadChanConfig(env: Record<string, string | undefined> = process.env): ChanConfig | null {
  let file: Record<string, string> = {};
  if (env.NODE_ENV !== "test") try {
    const dir = env.XDG_CONFIG_HOME || join(homedir(), ".config");
    file = parseEnvFile(readFileSync(join(dir, "tailchan", "env"), "utf8"));
  } catch {
    // no CLI config here; the env alone decides
  }
  return chanConfig(env, file);
}

export class ChanError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

/** how long a plain call waits; a stream has no limit */
const CALL_TIMEOUT = 10_000;

export class Chan {
  constructor(
    readonly url: string,
    private readonly fetcher: Fetch = (i, init) => fetch(i, init),
  ) {}

  private async call<T>(as: string, method: string, path: string, body?: unknown, raw?: { data: Uint8Array; type: string; name: string }): Promise<T> {
    const headers: Record<string, string> = { "x-tailchan-as": as };
    let payload: string | Uint8Array | undefined;
    if (raw) {
      headers["content-type"] = raw.type;
      headers["x-filename"] = raw.name;
      payload = raw.data;
    } else if (body !== undefined) {
      headers["content-type"] = "application/json";
      payload = JSON.stringify(body);
    }
    let res: Response;
    try {
      res = await this.fetcher(`${this.url}${path}`, { method, headers, body: payload, signal: AbortSignal.timeout(CALL_TIMEOUT) });
    } catch (e) {
      throw new ChanError(502, `tailchan unreachable at ${this.url}: ${e instanceof Error ? e.message : String(e)}`);
    }
    const text = await res.text();
    let data: unknown = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = text;
    }
    if (!res.ok) {
      const err = data && typeof data === "object" && "error" in data ? String((data as { error: unknown }).error) : text;
      throw new ChanError(res.status, `tailchan: ${err}`);
    }
    return data as T;
  }

  who(as: string): Promise<ChanWho[]> {
    return this.call(as, "GET", "/v1/who");
  }

  channels(as: string): Promise<ChanChannel[]> {
    return this.call(as, "GET", "/v1/channels");
  }

  async read(as: string, target: string, n: number): Promise<ChanMessage[]> {
    const q = readQuery(target);
    if (!q) throw new ChanError(400, `not a channel or a handle: ${target}`);
    const rows = await this.call<unknown[]>(as, "GET", `/v1/messages?${q}&limit=${Math.max(1, Math.min(500, n))}`);
    return rows.map(asChanMessage).filter((m): m is ChanMessage => m !== null);
  }

  async send(as: string, target: ChanTarget, kind: string, body: string, meta: Record<string, unknown> = {}): Promise<ChanMessage> {
    const m = asChanMessage(await this.call(as, "POST", "/v1/messages", { ...target, kind, body, meta }));
    if (!m) throw new ChanError(502, "tailchan answered a post with something that is not a message");
    return m;
  }

  async sub(as: string, channel: string): Promise<void> {
    await this.call(as, "POST", "/v1/subs", { channel });
  }

  putBlob(as: string, data: Uint8Array, type: string, name: string): Promise<{ id: string; name: string; mime: string; size: number }> {
    return this.call(as, "PUT", "/v1/blobs", undefined, { data, type, name });
  }

  /** the broker's own response, streamed through as it is */
  async getBlob(as: string, id: string): Promise<Response> {
    const res = await this.fetcher(`${this.url}/v1/blobs/${encodeURIComponent(id)}`, { headers: { "x-tailchan-as": as } });
    if (!res.ok) throw new ChanError(res.status === 404 ? 404 : 502, "no such blob (expired?)");
    return res;
  }

  /**
   * Follows what `as` hears (its subscriptions and DMs), calling `onMessage`
   * for each post, until the returned stop is called. A dropped stream is
   * dialed again at doubling waits up to 30s and resumes after the last id
   * it saw, so a broker restart loses nothing. `onState` says whether it is
   * connected, for the UI's word on it.
   */
  follow(as: string, onMessage: (m: ChanMessage) => void, onState: (up: boolean) => void = () => {}): () => void {
    let stopped = false;
    let last = 0;
    let wait = 1000;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dial = async () => {
      if (stopped) return;
      ctrl = new AbortController();
      try {
        const q = last ? `?since=${last}` : "";
        const res = await this.fetcher(`${this.url}/v1/stream${q}`, { headers: { "x-tailchan-as": as, accept: "text/event-stream" }, signal: ctrl.signal });
        if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
        onState(true);
        wait = 1000;
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const { events, rest } = parseSse(buf);
          buf = rest;
          for (const ev of events) {
            if (ev.event !== "message") continue;
            let parsed: unknown = null;
            try {
              parsed = JSON.parse(ev.data);
            } catch {
              continue;
            }
            const m = asChanMessage(parsed);
            if (!m) continue;
            if (m.id > last) last = m.id;
            onMessage(m);
          }
        }
      } catch {
        // dropped or refused; dialed again below
      }
      if (stopped) return;
      onState(false);
      timer = setTimeout(() => void dial(), wait);
      wait = Math.min(wait * 2, 30_000);
    };
    void dial();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
    };
  }
}
