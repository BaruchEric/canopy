/** The page's half of the share target (sharetarget.ts has the rest). At
 * start, before the app reads the address, it takes `?share=<id>` off it
 * (and the bare `/share` a POST lands on when no worker caught it), then
 * waits for the first load, keeps what was shared on home's clipboard as a
 * copy from this device "shared", deletes the share's cache, opens the
 * clipboard on it and says what it kept or why not. */
import { clipKind, clipLine, looksSecret, sizeWord, CLIP_FILE_MAX } from "../../src/core/clips";
import { pictureName } from "./clipfiles";
import { say } from "./said";
import { parseShareMeta, shareCache, shareIdOf, sharedText, SHARE_FAILED, SHARE_FILE, SHARE_META, SHARE_PATH } from "./sharetarget";
import { useStore } from "./store";

const errText = (err: unknown) => String(err instanceof Error ? err.message : err);

type Arrived = { kind: "share"; id: string } | { kind: "lost" } | { kind: "failed" };

/** what the address says arrived, with the address put back to the page's own */
function arrived(): Arrived | null {
  const url = new URL(location.href);
  const value = url.searchParams.get("share");
  const lost = url.pathname === SHARE_PATH;
  if (value === null && !lost) return null;
  url.searchParams.delete("share");
  if (lost) url.pathname = "/";
  history.replaceState(history.state, "", url.pathname + url.search + url.hash);
  if (lost) return { kind: "lost" };
  if (value === SHARE_FAILED) return { kind: "failed" };
  const id = shareIdOf(value);
  return id === null ? null : { kind: "share", id };
}

function loaded(): Promise<void> {
  return new Promise((resolve) => {
    if (useStore.getState().loaded) {
      resolve();
      return;
    }
    const off = useStore.subscribe((s) => {
      if (!s.loaded) return;
      off();
      resolve();
    });
  });
}

/** keeps each part of a share; the words for the quiet line, and whether any failed */
async function take(id: string): Promise<{ text: string; bad: boolean }> {
  const name = shareCache(id);
  const cache = await caches.open(name);
  try {
    const metaRes = await cache.match(SHARE_META);
    if (!metaRes) return { text: "the share was gone before canopy could keep it", bad: true };
    const meta = parseShareMeta(await metaRes.json().catch(() => null));
    const store = useStore.getState();
    const kept: string[] = [];
    const failed: string[] = [];
    const text = sharedText(meta);
    if (text) {
      if (looksSecret(text)) failed.push("the text looks like a key or a password, so it is not kept");
      else if (await store.keepClip({ text, source: "device", from: "shared" })) kept.push(clipKind(text) === "link" ? "the link" : "the text");
      else failed.push("home's clipboard did not keep the text");
    }
    for (const [i, f] of meta.files.entries()) {
      const fileName = f.name || pictureName(f.type || "application/octet-stream");
      if (f.size > CLIP_FILE_MAX) {
        failed.push(`${fileName} is ${sizeWord(f.size)}, past the ${sizeWord(CLIP_FILE_MAX)} a clip keeps`);
        continue;
      }
      const res = await cache.match(`${SHARE_FILE}${i}`);
      if (!res) {
        failed.push(`${fileName} did not arrive`);
        continue;
      }
      try {
        await store.keepFile(await res.blob(), fileName, "shared");
        kept.push(clipLine(fileName, 40));
      } catch (e) {
        failed.push(`${fileName}: ${errText(e)}`);
      }
    }
    if (kept.length > 0) store.openClips();
    if (failed.length > 0) return { text: failed.join("; "), bad: true };
    if (kept.length === 0) return { text: "the share held nothing to keep", bad: true };
    return { text: kept.length === 1 ? `kept ${kept[0] ?? ""}` : `kept ${kept.length} shared items`, bad: false };
  } finally {
    await caches.delete(name).catch(() => false);
  }
}

/** Called once from main.tsx before the first render. */
export function startShareIn(): void {
  if (typeof window === "undefined") return;
  const what = arrived();
  if (what === null) return;
  void loaded().then(async () => {
    if (what.kind === "lost") {
      say("the share did not reach canopy: open canopy once so its worker can take shares, then share again", true);
      return;
    }
    if (what.kind === "failed") {
      say("canopy could not read what was shared", true);
      return;
    }
    if (!("caches" in window)) {
      say("this browser cannot hand a share over", true);
      return;
    }
    const { text, bad } = await take(what.id).catch((e: unknown) => ({ text: `the share was not kept: ${errText(e)}`, bad: true }));
    say(text, bad);
  });
}
