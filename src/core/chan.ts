/**
 * The tailchan client the server uses: one method per broker call canopy
 * makes, over an injected fetch so tests can hand it a stand-in broker, and
 * a stream that reconnects the way the CLI's `watch` does. Reads its address
 * the way the CLI does, so a machine with the CLI set up needs nothing new.
 */
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { asAsk, asChanMessage, asPresence, parseSse, readQuery, type ChanTarget } from "./tailchan";
import type { AgentCard, Ask, AskAnswer, ChanChannel, ChanMessage, ChanWho, Presence, ScanBody } from "./types";

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
  // No answer token here: answering takes the answering browser's own key,
  // which canopy forwards and never holds (server/asks.ts says why).
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

  private async call<T>(
    as: string,
    method: string,
    path: string,
    body?: unknown,
    raw?: { data: Uint8Array; type: string; name: string },
    token?: string,
  ): Promise<T> {
    const headers: Record<string, string> = { "x-tailchan-as": as };
    if (token) headers["authorization"] = `Bearer ${token}`;
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

  /** the registry's cards: `state` is `live` (the broker's default),
   *  `all`, or one state; newest beat first */
  listAgents(as: string, query: { state?: string; node?: string; repo?: string; harness?: string; cap?: string[] } = {}): Promise<AgentCard[]> {
    const q = new URLSearchParams();
    for (const k of ["state", "node", "repo", "harness"] as const) {
      const v = query[k];
      if (v) q.set(k, v);
    }
    for (const c of query.cap ?? []) q.append("cap", c);
    const qs = q.toString();
    return this.call(as, "GET", `/v1/agents${qs ? `?${qs}` : ""}`);
  }

  getAgent(as: string, id: string): Promise<AgentCard> {
    return this.call(as, "GET", `/v1/agents/${encodeURIComponent(id)}`);
  }

  /** replaces the caller node's scan cards in the body's pid namespace */
  scanAgents(as: string, body: ScanBody): Promise<{ cards: number; ended: number }> {
    return this.call(as, "POST", "/v1/agents/scan", body);
  }

  /** asks, oldest first: `open` (the broker's default), `all`, or one state */
  async listAsks(as: string, state = "open"): Promise<Ask[]> {
    const rows = await this.call<unknown[]>(as, "GET", `/v1/asks?state=${encodeURIComponent(state)}`);
    return (Array.isArray(rows) ? rows : []).map(asAsk).filter((a): a is Ask => a !== null);
  }

  async getAsk(as: string, id: string): Promise<Ask> {
    const a = asAsk(await this.call(as, "GET", `/v1/asks/${encodeURIComponent(id)}`));
    if (!a) throw new ChanError(502, "tailchan answered with something that is not an ask");
    return a;
  }

  /** answers an open ask with the answering browser's key; `by` is who,
   *  which the broker writes as `<by>@<key name>` (a 409 when the ask is no
   *  longer open) */
  async answerAsk(as: string, token: string, id: string, answer: AskAnswer & { by: string }): Promise<Ask> {
    const a = asAsk(await this.call(as, "POST", `/v1/asks/${encodeURIComponent(id)}/answer`, answer, undefined, token));
    if (!a) throw new ChanError(502, "tailchan answered with something that is not an ask");
    return a;
  }

  async presence(as: string): Promise<Presence> {
    const p = asPresence(await this.call(as, "GET", "/v1/presence"));
    if (!p) throw new ChanError(502, "tailchan answered with something that is not a presence");
    return p;
  }

  /** sets presence outright; a pinned away holds until it is set again */
  async setPresence(as: string, token: string, state: Presence["state"], pinned: boolean): Promise<Presence> {
    const p = asPresence(await this.call(as, "PUT", "/v1/presence", { state, pinned }, undefined, token));
    if (!p) throw new ChanError(502, "tailchan answered with something that is not a presence");
    return p;
  }

  /** here now, unless a pinned away holds */
  async beatPresence(as: string, token: string): Promise<Presence> {
    const p = asPresence(await this.call(as, "POST", "/v1/presence/beat", {}, undefined, token));
    if (!p) throw new ChanError(502, "tailchan answered with something that is not a presence");
    return p;
  }

  async guards(as: string): Promise<string[]> {
    const g = await this.call<{ rules?: unknown }>(as, "GET", "/v1/guards");
    return Array.isArray(g?.rules) ? g.rules.filter((r): r is string => typeof r === "string") : [];
  }

  async setGuards(as: string, token: string, rules: string[]): Promise<string[]> {
    const g = await this.call<{ rules?: unknown }>(as, "PUT", "/v1/guards", { rules }, undefined, token);
    return Array.isArray(g?.rules) ? g.rules.filter((r): r is string => typeof r === "string") : [];
  }

  /** the broker's own response, streamed through as it is */
  async getBlob(as: string, id: string): Promise<Response> {
    const res = await this.fetcher(`${this.url}/v1/blobs/${encodeURIComponent(id)}`, { headers: { "x-tailchan-as": as } });
    if (!res.ok) throw new ChanError(res.status === 404 ? 404 : 502, "no such blob (expired?)");
    return res;
  }

  /**
   * Follows what `as` hears (its subscriptions and DMs, or only `channels`
   * when given, which pins the stream to them), calling `onMessage` for
   * each post, until the returned stop is called. A dropped stream is
   * dialed again at doubling waits up to 30s and resumes after the last id
   * it saw, so a broker restart loses nothing. `onState` says whether it is
   * connected, for the UI's word on it.
   */
  follow(as: string, onMessage: (m: ChanMessage) => void, onState: (up: boolean) => void = () => {}, channels?: readonly string[]): () => void {
    let stopped = false;
    let last = 0;
    let wait = 1000;
    let ctrl: AbortController | null = null;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const dial = async () => {
      if (stopped) return;
      ctrl = new AbortController();
      try {
        const params = new URLSearchParams();
        if (channels?.length) params.set("channels", channels.join(","));
        if (last) params.set("since", String(last));
        const qs = params.toString();
        const q = qs ? `?${qs}` : "";
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
