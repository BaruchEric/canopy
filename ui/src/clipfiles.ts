/**
 * A clipboard file in the page (FR-054): its bytes, read once and held for
 * the last few clips looked at; a picture put back on this device's
 * clipboard as a PNG; a picture handed to a shell the way a pasted one is;
 * a file saved. What may open in a tab of its own is `openable` in
 * core/clips.ts: never SVG or HTML, whose blob URL would run in canopy's
 * origin. Browser only.
 */
import { openable, servedType } from "../../src/core/clips";
import { api } from "./api";
import { shownFile, type ShownClip } from "./clips";

/** how many clips' bytes the page holds on to */
const HELD = 8;
const held = new Map<string, Promise<Blob>>();

/** a shown clip's file's bytes, a kept one's through the api with the page's
 *  token, tailchan's through home's link to it; read once while held. The
 *  bytes carry the type canopy would serve them as, whatever the sender's
 *  server said: a tailnet "PDF" served as HTML must never reach a frame as
 *  HTML, where it would run in canopy's origin. */
export function clipBytes(c: ShownClip): Promise<Blob> {
  const got = held.get(c.key);
  if (got) {
    // the newest looked at goes to the back of the line
    held.delete(c.key);
    held.set(c.key, got);
    return got;
  }
  const file = shownFile(c);
  const raw = !file ? Promise.reject(new Error("that clip is not a file")) : c.id !== undefined ? api.clipFile(c.id) : c.chanFile ? api.chanBlob(c.chanFile.blob) : Promise.reject(new Error("that clip is not a file"));
  const type = servedType(file?.type ?? "");
  const read = raw.then((b) => (b.type === type ? b : new Blob([b], { type })));
  held.set(c.key, read);
  read.catch(() => held.delete(c.key));
  for (const key of held.keys()) {
    if (held.size <= HELD) break;
    held.delete(key);
  }
  return read;
}

/** the picture as a PNG, the one picture type every clipboard takes */
export async function pngOf(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const url = URL.createObjectURL(blob);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const canvas = document.createElement("canvas");
    canvas.width = img.naturalWidth || 1;
    canvas.height = img.naturalHeight || 1;
    canvas.getContext("2d")?.drawImage(img, 0, 0);
    return await new Promise<Blob>((done, fail) => canvas.toBlob((b) => (b ? done(b) : fail(new Error("the picture could not be drawn as a PNG"))), "image/png"));
  } finally {
    URL.revokeObjectURL(url);
  }
}

/** Puts a picture on this device's clipboard. Call it straight from the
 *  click, before any await: the browser keeps the press's permission only
 *  while the item is made in it, so the bytes go in as a promise. */
export function copyPicture(bytes: Promise<Blob>): Promise<void> {
  if (typeof ClipboardItem === "undefined" || !navigator.clipboard?.write) return Promise.reject(new Error("this browser cannot put a picture on the clipboard"));
  return navigator.clipboard.write([new ClipboardItem({ "image/png": bytes.then(pngOf) })]);
}

/** the picture types a shell's paste takes as they are; any other goes as a PNG */
const PASTED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** a picture as a shell's paste takes it */
export const pasteable = async (blob: Blob): Promise<Blob> => (PASTED.has(blob.type) ? blob : pngOf(blob));

/** saves the bytes as `name`, the way a link with download does */
export function saveBytes(blob: Blob, name: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.rel = "noopener";
  document.body.append(a);
  a.click();
  a.remove();
  // the download has its bytes by the next turn; a minute is room to spare
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

/** whether bytes as served may open in a tab of their own */
export const opensInTab = (blob: Blob): boolean => openable(blob.type);

/** a name for a picture taken from a clipboard: the time it was taken, local */
export function pictureName(type: string, now: Date = new Date()): string {
  const ext = type === "image/jpeg" ? "jpg" : (type.split("/")[1] ?? "png").replace(/[^a-z0-9]/g, "") || "png";
  const two = (n: number) => String(n).padStart(2, "0");
  return `picture ${now.getFullYear()}-${two(now.getMonth() + 1)}-${two(now.getDate())} ${two(now.getHours())}.${two(now.getMinutes())}.${two(now.getSeconds())}.${ext}`;
}
