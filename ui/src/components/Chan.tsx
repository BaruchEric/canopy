import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { escapeCloses } from "../surface";
import { chanBlobUrl } from "../api";
import { convName, convOf, convOrder, latestClip, messageText } from "../chan";
import { useFitPop } from "../pop";
import { canReadClipboard, copyText, readText } from "../share";
import { useStore } from "../store";
import type { ChanMessage } from "../../../src/core/types";

/** "now", "4m", "3h", "2d" since a unix ms time */
function ago(ts: number, now: number): string {
  const s = Math.max(0, Math.round((now - ts) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

const EMPTY: ChanMessage[] = [];

/** one message: who and when, then the text, a file's link, or a clip */
function Message({ m, me, now, onError }: { m: ChanMessage; me: string; now: number; onError: (e: string) => void }) {
  const blob = typeof m.meta["blob"] === "string" ? m.meta["blob"] : null;
  return (
    <li className={m.handle === me ? "chan-msg mine" : "chan-msg"}>
      <span className="chan-who" title={`${m.handle}@${m.node}, message ${m.id}`}>
        {m.handle === me ? "you" : m.handle}
        <span className="chan-when">{ago(m.ts, now)}</span>
      </span>
      {m.kind === "object" && blob ? (
        <a className="chan-text" href={chanBlobUrl(blob)} download>
          {messageText(m)}
        </a>
      ) : m.kind === "clip" ? (
        <button type="button" className="chan-text chan-clip" title="Copy to this device's clipboard" onClick={() => void copyText(m.body).catch((e: unknown) => onError(e instanceof Error ? e.message : String(e)))}>
          {messageText(m)} · copy
        </button>
      ) : (
        <span className="chan-text">{m.body}</span>
      )}
    </li>
  );
}

/**
 * tailchan in the top bar: `✉ n` counts what arrived while no one was
 * looking. Open, it lists the conversations the backend's handle is in, the
 * open one's messages with a composer, who has been around (a click opens
 * the DM), the clipboard both ways, and the switch that has canopy post its
 * own runs, flows and fleets. Nothing shows when the backend knows no broker.
 */
export function ChanChip() {
  const chan = useStore((s) => s.chan);
  const open = useStore((s) => s.chanOpen);
  const conv = useStore((s) => s.chanConv);
  const unread = useStore((s) => s.chanUnread);
  const live = useStore((s) => s.chanMsgs);
  const msgs = useStore((s) => (s.chanConv ? (s.chanMsgs[s.chanConv] ?? EMPTY) : EMPTY));
  const { openChan, closeChan, showConv, sendChan, putChan, setChanNotify } = useStore.getState();
  const [draft, setDraft] = useState("");
  const [to, setTo] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const ref = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLUListElement>(null);
  const file = useRef<HTMLInputElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    setNow(Date.now());
    const tick = setInterval(() => setNow(Date.now()), 30_000);
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) closeChan();
    };
    const onKey = (e: KeyboardEvent) => {
      escapeCloses(e, () => closeChan());
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      clearInterval(tick);
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closeChan]);

  // the newest message in view, as a chat would
  useLayoutEffect(() => {
    const el = list.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [msgs, conv, open]);

  if (!chan?.ready) return null;
  const me = chan.as;
  const convs = convOrder(chan.channels, live);
  const target = conv ? convName(conv, me) : null;

  const act = async (fn: () => Promise<void>) => {
    setErr(null);
    try {
      await fn();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };
  const send = () => {
    const body = draft.trim();
    if (!target || !body) return;
    void act(async () => {
      await sendChan(target, body);
      setDraft("");
    });
  };
  const start = () => {
    const t = to.trim();
    if (!/^[@#]?[a-z0-9][a-z0-9._-]*$/i.test(t)) {
      setErr("a conversation is #channel or @handle");
      return;
    }
    setTo("");
    void showConv(convOf(t.startsWith("@") || t.startsWith("#") ? t : `#${t}`, me));
  };
  // A secure page reads the clipboard itself; over the tailnet's plain http
  // the browser will not, so what is in the box goes as the clip instead.
  const pushClip = () =>
    void act(async () => {
      const reads = canReadClipboard();
      const text = reads ? await readText() : draft;
      if (!text) throw new Error(reads ? "the clipboard is empty" : "this page cannot read the clipboard: paste into the message box, then send clipboard");
      await sendChan("#clipboard", text, "clip");
      if (!reads) setDraft("");
    });
  const clip = latestClip(live);

  return (
    <div className="settings chan" ref={ref}>
      <button
        type="button"
        className={open ? "mini on" : unread ? "mini chan-unread" : "mini"}
        aria-label="tailchan messages"
        aria-expanded={open}
        title={unread ? `${unread} new on tailchan` : "tailchan: channels, DMs and the clipboard"}
        onClick={() => (open ? closeChan() : openChan())}
      >
        <span aria-hidden="true">✉</span> {unread || ""}
      </button>
      {open && (
        <div className="settings-pop chan-pop" role="dialog" aria-label="tailchan">
          <section className="settings-row">
            <h3 className="panel-label">tailchan · as {me}</h3>
            <div className="chan-convs">
              {convs.map((c) => (
                <button key={c} type="button" className={c === conv ? "mini on" : "mini"} onClick={() => void showConv(c)}>
                  {convName(c, me)}
                </button>
              ))}
              <input
                className="settings-input chan-to"
                placeholder="#channel or @handle"
                value={to}
                onChange={(e) => setTo(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") start();
                }}
              />
            </div>
          </section>
          {target && (
            <section className="settings-row">
              <ul className="chan-msgs" ref={list} aria-label={`messages in ${target}`}>
                {msgs.length === 0 && <li className="settings-hint">Nothing here yet.</li>}
                {msgs.map((m) => (
                  <Message key={m.id} m={m} me={me} now={now} onError={setErr} />
                ))}
              </ul>
              <textarea
                className="settings-input chan-draft"
                rows={2}
                placeholder={`to ${target}; Enter sends, Shift+Enter a new line`}
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault();
                    send();
                  }
                }}
              />
              <div className="kept-acts">
                <button type="button" className="mini strong" disabled={!draft.trim()} onClick={send}>
                  send
                </button>
                <button type="button" className="mini" onClick={() => file.current?.click()}>
                  file…
                </button>
                <input
                  ref={file}
                  type="file"
                  hidden
                  onChange={(e) => {
                    const f = e.target.files?.[0];
                    e.target.value = "";
                    if (f) void act(() => putChan(target, f, draft.trim()).then(() => setDraft("")));
                  }}
                />
              </div>
            </section>
          )}
          <section className="settings-row">
            <h3 className="panel-label">clipboard</h3>
            <div className="kept-acts">
              <button type="button" className="mini" onClick={pushClip} title="Share this device's clipboard to #clipboard">
                send clipboard
              </button>
              {clip && clip.kind === "clip" && (
                <button type="button" className="mini" onClick={() => void act(() => copyText(clip.body))} title={`from ${clip.handle}@${clip.node}`}>
                  copy the latest ({ago(clip.ts, now)})
                </button>
              )}
            </div>
          </section>
          <section className="settings-row">
            <h3 className="panel-label">around</h3>
            <ul className="chan-who-list">
              {chan.who
                .filter((w) => w.handle !== me)
                .map((w) => (
                  <li key={w.handle}>
                    <button type="button" className="chan-who-row" onClick={() => void showConv(convOf(`@${w.handle}`, me))} title={`DM ${w.handle}`}>
                      <span className={w.live ? "chan-dot live" : "chan-dot"} aria-label={w.live ? "listening" : "not listening"} />
                      {w.handle}
                      <span className="chan-when">
                        {w.node} · {ago(w.last_seen, now)}
                      </span>
                    </button>
                  </li>
                ))}
            </ul>
            <label className="settings-line">
              <input type="checkbox" checked={chan.notify} onChange={(e) => void act(() => setChanNotify(e.target.checked))} />
              post runs, flows and fleets to #{chan.channel}; a prompt or gate waiting on you pings as a DM
            </label>
            {err && <p className="settings-hint error">{err}</p>}
          </section>
        </div>
      )}
    </div>
  );
}
