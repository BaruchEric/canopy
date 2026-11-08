/**
 * The clipboard (FR-054): the top bar's ⎘ chip and its popup, whose body a
 * tab in a shell window (FR-030) and a card in the dock (FR-047) draw as
 * well. Every copy canopy hears, from every backend the page shows and from
 * tailchan's #clipboard, newest first. The clip picked (the newest until
 * another is) is drawn large as what it is: a link split into its host and
 * the rest, a color as a swatch, a hash with its short form standing out, a
 * path with its name standing out, JSON laid out, a command after its
 * prompt, code with its line numbers, prose as prose; a picture as itself
 * on a checkerboard, a PDF in the browser's reader, a video or a sound with
 * its controls, a text file as its text, any other file as its name. Below
 * or beside it, the list, one line a clip, its source in its own color.
 * Pictures and files come in by a paste or a drop on the body, "add files",
 * and "take in", which reads a picture off this device's clipboard too.
 */
import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from "react";
import { agoWord, clipKind, clipLine, fileKind, lineCount, looksSecret, sizeWord, swatchOf, textFile, textFileKind, CLIP_FILE_MAX, type ClipKind } from "../../../src/core/clips";
import type { ChanMessage } from "../../../src/core/types";
import { api } from "../api";
import { clientId, myDeviceName } from "../client";
import { clipBytes, copyPicture, opensInTab, pasteable, pictureName, saveBytes } from "../clipfiles";
import { SOURCE_WHAT, commandText, filterClips, headLines, linkParts, pathParts, pinnedFirst, prettyJson, shownClips, shownFile, sourceCounts, type ShownClip, type ShownSource } from "../clips";
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
  image: "picture",
  pdf: "PDF",
  video: "video",
  audio: "sound",
  file: "file",
};

/** the file kinds the viewer draws from their bytes, read as soon as one is picked */
const DRAWN: ReadonlySet<ClipKind> = new Set(["image", "pdf", "video", "audio"]);

/** a file's bytes as the viewer holds them: an object URL to draw from, and
 *  its text when it reads as text */
interface Bytes {
  key: string;
  blob: Blob;
  url: string;
  text: string | null;
}

/** Reads a picked file's bytes when `want`, its text too when `asText`;
 *  the URL is let go when the pick moves on. */
function useBytes(clip: ShownClip, want: boolean, asText: boolean): { bytes: Bytes | null; error: string } {
  const [bytes, setBytes] = useState<Bytes | null>(null);
  const [error, setError] = useState("");
  const clipRef = useRef(clip);
  clipRef.current = clip;
  useEffect(() => {
    setError("");
    if (!want) return;
    let live = true;
    let url: string | null = null;
    const key = clipRef.current.key;
    clipBytes(clipRef.current)
      .then(async (blob) => {
        const text = asText ? await blob.text() : null;
        if (!live) return;
        url = URL.createObjectURL(blob);
        setBytes({ key, blob, url, text });
      })
      .catch((e: unknown) => {
        if (live) setError(errText(e));
      });
    return () => {
      live = false;
      if (url) URL.revokeObjectURL(url);
    };
  }, [clip.key, want, asText]);
  return { bytes: bytes?.key === clip.key ? bytes : null, error };
}

/** a file the viewer has no drawing for: its name, its extension large */
function FileCard({ name }: { name: string }) {
  const dot = name.lastIndexOf(".");
  const ext = dot > 0 && name.length - dot <= 8 ? name.slice(dot) : "";
  return (
    <div className="clip-filecard">
      <span className="clip-ext" aria-hidden="true">
        {ext || "file"}
      </span>
      <span className="clip-fname">{name}</span>
    </div>
  );
}

/** a file drawn as what it is, once its bytes are in */
function FileView({ name, type, kind, bytes, error, onSize }: { name: string; type: string; kind: ClipKind; bytes: Bytes | null; error: string; onSize: (w: number, h: number) => void }) {
  if (error) return <p className="settings-hint error">{error}</p>;
  if (bytes?.text != null) return <ClipView text={bytes.text} kind={textFileKind({ name, type }, bytes.text)} />;
  if (!DRAWN.has(kind)) return <FileCard name={name} />;
  if (!bytes) return <p className="clip-loading">Reading {name}</p>;
  switch (kind) {
    case "image":
      return <img className="clip-img" src={bytes.url} alt={name} onLoad={(e) => onSize(e.currentTarget.naturalWidth, e.currentTarget.naturalHeight)} />;
    case "pdf":
      return <iframe className="clip-pdf" src={bytes.url} title={name} />;
    case "video":
      return <video className="clip-video" src={bytes.url} controls preload="metadata" onLoadedMetadata={(e) => onSize(e.currentTarget.videoWidth, e.currentTarget.videoHeight)} />;
    case "audio":
      return <audio className="clip-audio" src={bytes.url} controls preload="metadata" />;
    default:
      return <FileCard name={name} />;
  }
}

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

/** Copies a clip back to this device: text as text, a picture as a picture,
 *  any other file saved. Called straight from a press: a picture's item is
 *  made before any await, or the browser forgets the press. */
function takeAgain(c: ShownClip): Promise<string> {
  const file = shownFile(c);
  const took = () => (c.id !== undefined ? useStore.getState().tookClip(c.id) : Promise.resolve());
  if (file && fileKind(file.type) === "image") return copyPicture(clipBytes(c)).then(took).then(() => `copied the picture ${clipLine(file.name, 40)}`);
  if (file)
    return clipBytes(c)
      .then((blob) => saveBytes(blob, file.name))
      .then(took)
      .then(() => `saved ${clipLine(file.name, 40)}`);
  const copied = c.id !== undefined ? useStore.getState().copyClip(c.id) : copyText(c.text, { keep: false });
  return copied.then(() => `copied: ${clipLine(c.text, 48)}`);
}

/** the clip picked, drawn large, with what it is and what can be done with it */
function Specimen({ clip, now, busy, act }: { clip: ShownClip; now: number; busy: boolean; act: (go: () => Promise<unknown>) => void }) {
  const { pinClip, deleteClip } = useStore.getState();
  const file = shownFile(clip);
  const kind = file ? fileKind(file.type) : clipKind(clip.text);
  const link = kind === "link" ? linkParts(clip.text) : null;
  const shell = lastShell();
  const mine = clip.device?.id === clientId();
  const picture = kind === "image";
  const { bytes, error } = useBytes(clip, !!file && (DRAWN.has(kind) || textFile(file)), !!file && textFile(file));
  const [size, setSize] = useState<{ key: string; w: number; h: number } | null>(null);
  const dims = size?.key === clip.key && size.w > 0 ? `${size.w.toLocaleString()} × ${size.h.toLocaleString()}` : "";
  const again = () => act(() => takeAgain(clip).then(say));
  const save = () =>
    act(async () => {
      if (!file) return;
      saveBytes(bytes?.blob ?? (await clipBytes(clip)), file.name);
      if (clip.id !== undefined) await useStore.getState().tookClip(clip.id);
      say(`saved ${clipLine(file.name, 40)}`);
    });
  const toShell = (s: { id: string; name: string }) =>
    act(async () => {
      if (!file) {
        typeInto(s.id, clip.text);
        return;
      }
      // a picture goes where the shell can read it, and its path is typed in, as a pasted one is
      const r = await api.pasteImage(s.id, await pasteable(bytes?.blob ?? (await clipBytes(clip))));
      typeInto(s.id, r.text);
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
      <div key={`${clip.key}@${clip.at}`} className={`clip-view k-${kind}${file && !(bytes?.text != null) ? " is-file" : ""}`}>
        {file ? <FileView name={file.name} type={file.type} kind={kind} bytes={bytes} error={error} onSize={(w, h) => setSize({ key: clip.key, w, h })} /> : <ClipView text={clip.text} kind={kind} />}
      </div>
      <p className="clip-facts">
        <span>{KIND_WORD[kind]}</span>
        {file ? (
          <>
            {dims && <span>{dims}</span>}
            <span>{sizeWord(file.size)}</span>
            <span className="clip-type">{file.type}</span>
          </>
        ) : (
          <>
            {lineCount(clip.text) > 1 && <span>{plural(lineCount(clip.text), "line")}</span>}
            <span>{plural(clip.text.length, "character")}</span>
          </>
        )}
        {clip.count > 1 && <span>copied {plural(clip.count, "time")}</span>}
        {clip.cut && <span className="clip-cut">cut at {clip.text.length.toLocaleString()} characters</span>}
      </p>
      <div className="clip-acts">
        {(!file || picture) && (
          <button type="button" className="mini strong" disabled={busy} title={picture ? "Put the picture on this device's clipboard" : undefined} onClick={again}>
            copy
          </button>
        )}
        {file && (
          <button type="button" className={picture ? "mini" : "mini strong"} disabled={busy} title={`Save ${file.name} to this device`} onClick={save}>
            save
          </button>
        )}
        {shell && (!file || picture) && (
          <button
            type="button"
            className="mini"
            disabled={busy}
            title={
              picture
                ? `Hand the picture to ${shell.name}, the shell the keyboard was last in: saved where it can read it, its path typed in for Claude Code to attach`
                : `Paste into ${shell.name}, the shell the keyboard was last in, as a paste: a shell with bracketed paste waits for your Enter`
            }
            onClick={() => toShell(shell)}
          >
            paste into {shell.name}
          </button>
        )}
        {link && (
          <a className="mini" href={link.href} target="_blank" rel="noreferrer noopener">
            open
          </a>
        )}
        {bytes && opensInTab(bytes.blob) && (
          <a className="mini" href={bytes.url} target="_blank" rel="noreferrer noopener" title={`Open ${file?.name ?? "it"} in a tab of its own`}>
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
  const [dropping, setDropping] = useState(false);
  const pickRef = useRef<HTMLInputElement>(null);

  const act = (go: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    go()
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setBusy(false));
  };

  /** files kept one after another, each as one from this device; a refusal names the file */
  const keepFiles = (files: readonly Blob[], how: string, names: readonly string[] = []) =>
    act(async () => {
      const failed: string[] = [];
      for (const [i, f] of files.entries()) {
        const name = names[i] ?? (f instanceof File && f.name ? f.name : pictureName(f.type));
        if (f.size > CLIP_FILE_MAX) {
          failed.push(`${name} is ${sizeWord(f.size)}, past the ${sizeWord(CLIP_FILE_MAX)} a clip keeps`);
          continue;
        }
        try {
          await useStore.getState().keepFile(f, name, how);
        } catch (e) {
          failed.push(`${name}: ${errText(e)}`);
        }
      }
      setPick(null);
      if (failed.length > 0) throw new Error(failed.join("; "));
      say(files.length === 1 ? `kept ${clipLine(names[0] ?? (files[0] instanceof File ? files[0].name : "the picture"), 40)}` : `kept ${files.length} files`);
    });

  /** a text kept as one from this device, the way a paste or a take-in does */
  const keepText = (text: string, from: string) => {
    if (!text.trim()) throw new Error("this device's clipboard holds no text");
    if (looksSecret(text)) throw new Error("that looks like a key or a password, so it is not kept");
    return useStore.getState().keepClip({ text, source: "device", from });
  };

  const takeIn = () =>
    act(async () => {
      // a picture first, where the browser hands one over; then text. The
      // text comes from the same read where there was one: a second ask can
      // prompt again, or fail once the press is spent (Safari, Firefox)
      const items = navigator.clipboard?.read ? await navigator.clipboard.read().catch(() => null) : null;
      let text: string | null = null;
      for (const item of items ?? []) {
        const type = item.types.find((t) => t.startsWith("image/"));
        if (type) {
          const blob = await item.getType(type);
          await useStore.getState().keepFile(blob, pictureName(blob.type || type), myDeviceName(device));
          setPick(null);
          say("kept the picture on this device's clipboard");
          return;
        }
        if (text === null && item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
      }
      await keepText((items ? text : await readText()) ?? "", myDeviceName(device));
      setPick(null);
    });

  const onPaste = (e: ClipboardEvent<HTMLDivElement>) => {
    const files = [...e.clipboardData.files];
    if (files.length > 0) {
      e.preventDefault();
      keepFiles(files, "pasted");
      return;
    }
    // text pasted into the find box is the search; anywhere else in here it is kept
    if (e.target instanceof HTMLInputElement) return;
    const text = e.clipboardData.getData("text/plain");
    if (!text) return;
    e.preventDefault();
    act(async () => {
      await keepText(text, "pasted");
      setPick(null);
    });
  };
  const hasFiles = (e: DragEvent) => [...e.dataTransfer.types].includes("Files");
  const onDragOver = (e: DragEvent<HTMLDivElement>) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "copy";
    setDropping(true);
  };
  const onDragLeave = (e: DragEvent<HTMLDivElement>) => {
    // leaving for a child is not leaving
    if (e.relatedTarget instanceof Node && e.currentTarget.contains(e.relatedTarget)) return;
    setDropping(false);
  };
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDropping(false);
    if (!hasFiles(e)) return;
    e.preventDefault();
    keepFiles([...e.dataTransfer.files], "dropped");
  };

  const copyRow = (c: ShownClip) => act(() => takeAgain(c).then(say));

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
    <div className={`clips${dropping ? " dropping" : ""}`} tabIndex={-1} onPaste={onPaste} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}>
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
          <button type="button" className="mini" disabled={busy} title="Keep what this device's clipboard holds now: a picture, else its text" onClick={takeIn}>
            take in
          </button>
        )}
        <button type="button" className="mini" disabled={busy} title={`Keep pictures, PDFs or any files from this device, up to ${sizeWord(CLIP_FILE_MAX)} each`} onClick={() => pickRef.current?.click()}>
          add files
        </button>
        <input
          ref={pickRef}
          type="file"
          multiple
          hidden
          onChange={(e) => {
            const files = [...(e.currentTarget.files ?? [])];
            e.currentTarget.value = "";
            if (files.length > 0) keepFiles(files, "added");
          }}
        />
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
            Copy in a shell, press a copy button or y then a letter, or select text on the page and copy it. Paste or drop a picture or a file here, or send one from any shell with <code>canopy clip --file path</code>. Every page and device shows it here.
          </p>
        </div>
      ) : (
        <div className="clips-main">
          {picked ? <Specimen clip={picked} now={now} busy={busy} act={act} /> : <p className="settings-hint clips-none">No clip matches.</p>}
          {shown.length > 0 && (
            <ol className="clip-list" ref={listRef} aria-label="Clips, newest first">
              {shown.map((c, i) => {
                const file = shownFile(c);
                const kind = file ? fileKind(file.type) : clipKind(c.text);
                const on = c.key === picked?.key;
                const quick = !file ? "Copy" : kind === "image" ? "Copy the picture" : "Save";
                return (
                  <li key={c.key} className={c.pinned ? "pinned" : undefined}>
                    <button
                      type="button"
                      className={`clip-row${on ? " on" : ""}`}
                      data-key={c.key}
                      aria-current={on ? "true" : undefined}
                      title={`Enter: ${quick.toLowerCase()}; the arrows move through the list`}
                      onClick={() => setPick(c.key === matching[0]?.key ? null : c.key)}
                      onDoubleClick={() => copyRow(c)}
                      onKeyDown={(e) => onRowKey(e, c, i)}
                    >
                      <span className={`clip-src s-${c.source}`}>{c.source}</span>
                      <span className={`clip-line${MONO.has(kind) ? " mono" : ""}`}>{clipLine(c.text)}</span>
                      {file && <span className="clip-size">{sizeWord(file.size)}</span>}
                      {c.pinned && <span className="clip-pin">pinned</span>}
                      <time className="clip-when">{agoWord(c.at, now)}</time>
                    </button>
                    <button type="button" className="mini clip-quick" disabled={busy} aria-label={`${quick} ${clipLine(c.text, 40)}`} title={quick} onClick={() => copyRow(c)} onKeyDown={keepKeys}>
                      <span className="chip-icon" aria-hidden="true">
                        {quick === "Save" ? "↓" : CLIPS_GLYPH}
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
        <p className="settings-hint">Paste, drop or add pictures and files here, up to {sizeWord(CLIP_FILE_MAX)} each. Text and files shaped like a key or a password are never kept, and nothing pasted anywhere else is.</p>
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

  // the body takes the focus, so a paste right after `v` lands in it
  useEffect(() => {
    if (open) ref.current?.querySelector<HTMLElement>(".clips")?.focus({ preventScroll: true });
  }, [open]);

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
