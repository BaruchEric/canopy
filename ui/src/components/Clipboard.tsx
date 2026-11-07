/**
 * The clipboard (FR-054): the top bar's ⎘ chip and its popup, whose body a
 * tab in a shell window (FR-030) and a card in the dock (FR-047) draw as
 * well. Every copy canopy hears, from every backend the page shows and from
 * tailchan's #clipboard, newest first. The clip picked (the newest until
 * another is) is drawn large as what it is: a link split into its host and
 * the rest, a color as a swatch, a hash with its short form standing out, a
 * path with its name standing out, JSON laid out, a command after its
 * prompt, code with its line numbers, prose as prose. Below or beside it,
 * the list, one line a clip, its source in its own color.
 */
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import { agoWord, clipKind, clipLine, lineCount, looksSecret, swatchOf, type ClipKind } from "../../../src/core/clips";
import type { ChanMessage } from "../../../src/core/types";
import { clientId, myDeviceName } from "../client";
import { SOURCE_WHAT, commandText, filterClips, headLines, linkParts, pathParts, pinnedFirst, prettyJson, shownClips, sourceCounts, type ShownClip, type ShownSource } from "../clips";
import { lastShell, typeInto } from "../liveTerms";
import { HANGS_RIGHT, leavesPop, useFitPop } from "../pop";
import { say } from "../said";
import { POPUP_WORD } from "../sectiontabs";
import { canReadClipboard, copyText, readText } from "../share";
import { useStore, type CanopyState } from "../store";
import { escapeCloses, keepKeys } from "../surface";
import { useNow } from "./Inbox";
import { PopGrip, type PopSpec } from "./PopGrip";

/** its mark, on the chip, a dock card's head and a tab */
export const CLIPS_GLYPH = "⎘";

const CLIPS_POP: PopSpec = { name: "clips", anchor: HANGS_RIGHT, tab: { kind: "popup", ref: "clips", label: POPUP_WORD.clips } };

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

/** the kinds a machine reads a character at a time, set in the mono */
const MONO: ReadonlySet<ClipKind> = new Set(["link", "color", "hash", "path", "json", "command", "code"]);

const KIND_WORD: Readonly<Record<ClipKind, string>> = {
  link: "link",
  color: "color",
  hash: "hash",
  path: "path",
  json: "JSON",
  command: "command",
  code: "code",
  text: "text",
};

/** the most lines a well draws before it says how many more there are */
const WELL_LINES = 400;

let shownIn: { clips: CanopyState["clips"]; chan: ChanMessage[] | undefined } | null = null;
let shownOut: ShownClip[] = [];

/** every shown backend's clips and tailchan's #clipboard as one list, worked
 *  out once per change of either, so a selector over it settles */
function allShown(s: CanopyState): ShownClip[] {
  const chan = s.chanMsgs["clipboard"];
  if (shownIn && shownIn.clips === s.clips && shownIn.chan === chan) return shownOut;
  shownIn = { clips: s.clips, chan };
  shownOut = shownClips(s.clips, chan ?? []);
  return shownOut;
}

/** whether the newest clip came from somewhere other than this browser since a clipboard last showed */
function freshElsewhere(s: CanopyState): boolean {
  const newest = allShown(s)[0];
  return !!newest && newest.at > s.clipsSeen && newest.device?.id !== clientId();
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

/** a well of lines, numbered for code, cut at WELL_LINES */
function Well({ text, numbered }: { text: string; numbered: boolean }) {
  const { lines, more } = headLines(text, WELL_LINES);
  return (
    <>
      <pre className={`clip-well${numbered ? " numbered" : ""}`}>
        {numbered
          ? lines.map((l, i) => (
              <span key={i} className="clip-ln">
                {l}
                {"\n"}
              </span>
            ))
          : lines.join("\n")}
      </pre>
      {more > 0 && <p className="clip-more">{plural(more, "more line")}</p>}
    </>
  );
}

/** a clip's text drawn as what it is */
function ClipView({ text, kind }: { text: string; kind: ClipKind }) {
  const t = text.trim();
  switch (kind) {
    case "link": {
      const l = linkParts(t);
      if (!l) break;
      return (
        <a className="clip-link" href={l.href} target="_blank" rel="noreferrer noopener">
          <span className="clip-host">{l.host}</span>
          <span className="clip-rest">{l.rest}</span>
        </a>
      );
    }
    case "color": {
      const c = swatchOf(t);
      if (!c) break;
      return (
        <div className="clip-color">
          <span className="clip-swatch" style={{ background: c }} aria-hidden="true" />
          <code>{c}</code>
        </div>
      );
    }
    case "hash":
      return (
        <code className="clip-hash">
          <span className="clip-short">{t.slice(0, 7)}</span>
          {t.slice(7)}
        </code>
      );
    case "path": {
      const p = pathParts(t);
      // a folder a piece, so a long path wraps after a slash and not at a dash in a name
      const dirs = p.dir.match(/[^/\\]*[/\\]+/g) ?? [];
      return (
        <code className="clip-path">
          {dirs.map((d, i) => (
            <span key={i} className="clip-dir">
              {d}
            </span>
          ))}
          <span className="clip-base">{p.base}</span>
        </code>
      );
    }
    case "json":
      return <Well text={prettyJson(t) ?? text} numbered={false} />;
    case "command":
      return (
        <pre className="clip-well clip-cmd">
          <span className="clip-prompt" aria-hidden="true">
            $
          </span>
          {commandText(text)}
        </pre>
      );
    case "code":
      return <Well text={text} numbered />;
    case "text":
      break;
  }
  return <p className="clip-prose">{text}</p>;
}

/** the clip picked, drawn large, with what it is and what can be done with it */
function Specimen({ clip, now, busy, act }: { clip: ShownClip; now: number; busy: boolean; act: (go: () => Promise<unknown>) => void }) {
  const { copyClip, pinClip, deleteClip } = useStore.getState();
  const kind = clipKind(clip.text);
  const link = kind === "link" ? linkParts(clip.text) : null;
  const shell = lastShell();
  const mine = clip.device?.id === clientId();
  const copy = () =>
    act(async () => {
      if (clip.id) await copyClip(clip.id);
      else await copyText(clip.text, { keep: false });
      say(`copied ${KIND_WORD[kind]}: ${clipLine(clip.text, 48)}`);
    });
  return (
    <section className="clip-specimen" aria-label="The clip picked">
      <p className="clip-label">
        <span className={`clip-src s-${clip.source}`} title={SOURCE_WHAT[clip.source]}>
          {clip.source}
        </span>
        {clip.from && <span className="clip-from">{clip.from}</span>}
        {clip.device && !mine && (
          <span className="clip-device" title={`Copied on ${clip.device.name}`}>
            {clip.device.name}
          </span>
        )}
        <time className="clip-when" dateTime={new Date(clip.at).toISOString()} title={new Date(clip.at).toLocaleString()}>
          {agoWord(clip.at, now)}
        </time>
      </p>
      <div key={`${clip.key}@${clip.at}`} className={`clip-view k-${kind}`}>
        <ClipView text={clip.text} kind={kind} />
      </div>
      <p className="clip-facts">
        <span>{KIND_WORD[kind]}</span>
        {lineCount(clip.text) > 1 && <span>{plural(lineCount(clip.text), "line")}</span>}
        <span>{plural(clip.text.length, "character")}</span>
        {clip.count > 1 && <span>copied {plural(clip.count, "time")}</span>}
        {clip.cut && <span className="clip-cut">cut at {clip.text.length.toLocaleString()} characters</span>}
      </p>
      <div className="clip-acts">
        <button type="button" className="mini strong" disabled={busy} onClick={copy}>
          copy
        </button>
        {shell && (
          <button type="button" className="mini" title={`Paste into ${shell.name}, the shell the keyboard was last in, as a paste: a shell with bracketed paste waits for your Enter`} onClick={() => typeInto(shell.id, clip.text)}>
            paste into {shell.name}
          </button>
        )}
        {link && (
          <a className="mini" href={link.href} target="_blank" rel="noreferrer noopener">
            open
          </a>
        )}
        {clip.id !== undefined && (
          <>
            <button
              type="button"
              className="mini"
              disabled={busy}
              title={clip.pinned ? "Let it go with the rest after 14 days or 200 newer clips" : "Keep it past 14 days and 200 newer clips"}
              onClick={() => {
                const id = clip.id;
                if (id) act(() => pinClip(id, !clip.pinned));
              }}
            >
              {clip.pinned ? "unpin" : "pin"}
            </button>
            <button
              type="button"
              className="mini"
              disabled={busy}
              onClick={() => {
                const id = clip.id;
                if (id) act(() => deleteClip(id));
              }}
            >
              drop
            </button>
          </>
        )}
      </div>
    </section>
  );
}

/**
 * The popup's body: find and take in, the sources with their counts, the
 * clip picked, the list. `onDone` is unused; a popover stays open after a
 * copy so the next can follow.
 */
export function ClipsPopBody({ onDone: _onDone }: { onDone?: () => void } = {}) {
  const list = useStore(allShown);
  const device = useStore((s) => s.settings.device);
  const [source, setSource] = useState<ShownSource | null>(null);
  const [query, setQuery] = useState("");
  const [pick, setPick] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [clearing, setClearing] = useState(false);
  const now = useNow(true, 20_000);
  const listRef = useRef<HTMLOListElement>(null);

  // tailchan's #clipboard, shown beside canopy's own; and what shows here is seen
  useEffect(() => useStore.getState().loadChanClips(), []);
  const newest = list[0]?.at ?? 0;
  useEffect(() => useStore.getState().seeClips(newest), [newest]);

  const counts = sourceCounts(list);
  const matching = filterClips(list, source, query);
  const shown = pinnedFirst(matching);
  // the pick, else the newest (not the first pinned): a new copy takes the
  // stage until another is picked
  const picked = shown.find((c) => c.key === pick) ?? matching[0];
  const unpinned = list.filter((c) => c.id !== undefined && !c.pinned).length;
  const canTake = canReadClipboard();

  const act = (go: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    go()
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(false));
  };

  const takeIn = () =>
    act(async () => {
      const text = await readText();
      if (!text?.trim()) throw new Error("this device's clipboard holds no text");
      if (looksSecret(text)) throw new Error("that looks like a key or a password, so it is not kept");
      await useStore.getState().keepClip({ text, source: "clipboard", from: myDeviceName(device) });
      setPick(null);
    });

  const copyRow = (c: ShownClip) =>
    act(async () => {
      if (c.id) await useStore.getState().copyClip(c.id);
      else await copyText(c.text, { keep: false });
      say(`copied: ${clipLine(c.text, 48)}`);
    });

  /** moves the pick along the list and the focus with it */
  const step = (to: number) => {
    const c = shown[Math.max(0, Math.min(shown.length - 1, to))];
    if (!c) return;
    setPick(c.key);
    listRef.current?.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(c.key)}"]`)?.focus();
  };
  const onRowKey = (e: KeyboardEvent<HTMLButtonElement>, c: ShownClip, i: number) => {
    keepKeys(e);
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      e.preventDefault();
      step(i + (e.key === "ArrowDown" ? 1 : -1));
    } else if (e.key === "Home" || e.key === "End") {
      e.preventDefault();
      step(e.key === "Home" ? 0 : shown.length - 1);
    } else if (e.key === "Enter") {
      e.preventDefault();
      copyRow(c);
    } else if ((e.key === "Delete" || e.key === "Backspace") && c.id) {
      e.preventDefault();
      const id = c.id;
      act(() => useStore.getState().deleteClip(id));
      // the pick and the focus go to the row that takes its place
      const next = shown[i + 1] ?? shown[i - 1];
      setPick(next && next.key !== matching[0]?.key ? next.key : null);
      if (next) listRef.current?.querySelector<HTMLButtonElement>(`[data-key="${CSS.escape(next.key)}"]`)?.focus();
    }
  };

  return (
    <div className="clips">
      <div className="settings-row clips-tools">
        <input
          className="settings-input clips-find"
          type="search"
          placeholder="find in clips"
          aria-label="Find in clips"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            keepKeys(e);
            if (e.key === "ArrowDown") {
              e.preventDefault();
              step(0);
            }
          }}
        />
        {canTake && (
          <button type="button" className="mini" disabled={busy} title="Keep what this device's clipboard holds now" onClick={takeIn}>
            take in
          </button>
        )}
      </div>
      {counts.length > 1 && (
        <div className="clips-sources" role="group" aria-label="Show clips from">
          <button type="button" className="clips-source" aria-pressed={source === null} onClick={() => setSource(null)}>
            every source <span className="clips-n">{list.length}</span>
          </button>
          {counts.map(({ source: s, n }) => (
            <button key={s} type="button" className={`clips-source s-${s}`} aria-pressed={source === s} title={SOURCE_WHAT[s]} onClick={() => setSource(source === s ? null : s)}>
              {s} <span className="clips-n">{n}</span>
            </button>
          ))}
        </div>
      )}
      {error && <p className="settings-hint error clips-error">{error}</p>}
      {list.length === 0 ? (
        <div className="clips-empty">
          <p>Nothing copied yet.</p>
          <p className="settings-hint">
            Copy in a shell, press a copy button or y then a letter, select text on the page and copy it, or send text from any shell with <code>canopy clip "text"</code>. Every page and device shows it here.
          </p>
        </div>
      ) : (
        <div className="clips-main">
          {picked ? <Specimen clip={picked} now={now} busy={busy} act={act} /> : <p className="settings-hint clips-none">No clip matches.</p>}
          {shown.length > 0 && (
            <ol className="clip-list" ref={listRef} aria-label="Clips, newest first">
              {shown.map((c, i) => {
                const kind = clipKind(c.text);
                const on = c.key === picked?.key;
                return (
                  <li key={c.key} className={c.pinned ? "pinned" : undefined}>
                    <button
                      type="button"
                      className={`clip-row${on ? " on" : ""}`}
                      data-key={c.key}
                      aria-current={on ? "true" : undefined}
                      title="Enter copies it, the arrows move through the list"
                      onClick={() => setPick(c.key === matching[0]?.key ? null : c.key)}
                      onDoubleClick={() => copyRow(c)}
                      onKeyDown={(e) => onRowKey(e, c, i)}
                    >
                      <span className={`clip-src s-${c.source}`}>{c.source}</span>
                      <span className={`clip-line${MONO.has(kind) ? " mono" : ""}`}>{clipLine(c.text)}</span>
                      {c.pinned && <span className="clip-pin">pinned</span>}
                      <time className="clip-when">{agoWord(c.at, now)}</time>
                    </button>
                    <button type="button" className="mini clip-quick" disabled={busy} aria-label={`Copy ${clipLine(c.text, 40)}`} title="Copy" onClick={() => copyRow(c)} onKeyDown={keepKeys}>
                      <span className="chip-icon" aria-hidden="true">
                        {CLIPS_GLYPH}
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
          )}
        </div>
      )}
      <div className="settings-row clips-foot">
        <p className="settings-hint">Text shaped like a key or a password is never kept, and neither is anything pasted.</p>
        {unpinned > 0 &&
          (clearing ? (
            <span className="clips-clear">
              <button
                type="button"
                className="mini confirm"
                disabled={busy}
                onClick={() =>
                  act(async () => {
                    await useStore.getState().clearClips();
                    setClearing(false);
                    setPick(null);
                  })
                }
              >
                drop {plural(unpinned, "clip")}
              </button>
              <button type="button" className="mini" onClick={() => setClearing(false)}>
                keep them
              </button>
            </span>
          ) : (
            <button type="button" className="mini" title="Drop every clip but the pinned ones, on every backend" onClick={() => setClearing(true)}>
              clear
            </button>
          ))}
      </div>
    </div>
  );
}

/** The top bar's ⎘: the clipboard in a popover. A dot when a copy came
 *  from somewhere else (another device, a shell's CLI, an agent) since a
 *  clipboard last showed. `v` opens it too. */
export function ClipsChip() {
  const open = useStore((s) => s.clipsOpen);
  const fresh = useStore(freshElsewhere);
  const { openClips, closeClips } = useStore.getState();
  const ref = useRef<HTMLDivElement>(null);
  useFitPop(ref, open);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      // the gear's menu sits in a portal outside the popup; a click in it stays in
      if (e.target instanceof Element && e.target.closest(".gear-pop")) return;
      if (leavesPop(e.target, ref)) closeClips();
    };
    const onKey = (e: globalThis.KeyboardEvent) => {
      escapeCloses(e, () => closeClips());
    };
    document.addEventListener("pointerdown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open, closeClips]);

  return (
    <div className="settings clips-chip" ref={ref}>
      <button
        type="button"
        className={`mini clips-btn${open ? " on" : ""}`}
        aria-label={fresh ? "Clipboard, with a new copy from elsewhere" : "Clipboard"}
        aria-expanded={open}
        aria-keyshortcuts="v"
        title="Clipboard (v): every copy from the shells, canopy, the page, the CLI and your devices"
        onClick={() => (open ? closeClips() : openClips())}
      >
        <span className="chip-icon" aria-hidden="true">
          {CLIPS_GLYPH}
        </span>
        {fresh && <span className="dot clips-fresh" aria-hidden="true" />}
      </button>
      {open && (
        <div className="settings-pop clips-pop" role="dialog" aria-label="Clipboard">
          <ClipsPopBody onDone={closeClips} />
          <PopGrip {...CLIPS_POP} gear />
        </div>
      )}
    </div>
  );
}
