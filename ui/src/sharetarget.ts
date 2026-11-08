/** The share target: what a phone's share sheet hands canopy, from the
 * manifest's `share_target` to a clip. The worker takes the POST to
 * `/share`, holds the form in a cache of its own named for the moment and a
 * random word, and sends the window on to `/?share=<id>`; the page reads that
 * cache once it has loaded, keeps each part on home's clipboard with its own
 * token and deletes the cache. The worker never holds a token. ESNext only:
 * the worker imports this module too. Pure and tested (sharetarget.test.ts). */

/** the manifest's `share_target.action`, posted as multipart form data */
export const SHARE_PATH = "/share";
/** a share's cache is this and its id */
export const SHARE_PREFIX = "canopy-share-";
/** inside a share's cache: the words, then file `i` at `${SHARE_FILE}${i}` */
export const SHARE_META = "/share/meta";
export const SHARE_FILE = "/share/file/";
/** a share no page took is dropped after this, ms */
export const SHARE_KEEP = 60 * 60 * 1000;
/** `?share=` when the worker could not read or hold the form */
export const SHARE_FAILED = "failed";

export interface SharedFile {
  name: string;
  type: string;
  size: number;
}

/** what the share sheet sent, as the worker keeps it beside the files */
export interface ShareMeta {
  title: string;
  text: string;
  url: string;
  files: SharedFile[];
}

const ID = /^\d{13}-[a-z0-9]{8}$/;

/** a share's id: the moment it came in and eight random letters or digits */
export const shareId = (at: number, rand: string): string => `${at}-${rand}`;
export const shareCache = (id: string): string => `${SHARE_PREFIX}${id}`;
export const isShareCache = (name: string): boolean => name.startsWith(SHARE_PREFIX);

/** `?share=`'s id when it is one, else null (an absent or a made-up value) */
export function shareIdOf(value: string | null): string | null {
  return value !== null && ID.test(value) ? value : null;
}

/** the share caches no page took within `SHARE_KEEP`, and any not named as ours */
export function staleShares(names: readonly string[], now: number): string[] {
  return names.filter((name) => {
    if (!isShareCache(name)) return false;
    const id = name.slice(SHARE_PREFIX.length);
    return !ID.test(id) || now - Number(id.split("-")[0]) > SHARE_KEEP;
  });
}

/** an object's field, or undefined for anything that is not an object */
function field(o: unknown, key: string): unknown {
  if (o === null || typeof o !== "object") return undefined;
  const v: unknown = Reflect.get(o, key);
  return v;
}
const str = (v: unknown): string => (typeof v === "string" ? v : "");

/** the worker's words read back; anything malformed reads as nothing shared */
export function parseShareMeta(raw: unknown): ShareMeta {
  const files: unknown = field(raw, "files");
  return {
    title: str(field(raw, "title")),
    text: str(field(raw, "text")),
    url: str(field(raw, "url")),
    files: (Array.isArray(files) ? files : []).flatMap((f: unknown) => {
      if (f === null || typeof f !== "object") return [];
      const size = field(f, "size");
      return [{ name: str(field(f, "name")), type: str(field(f, "type")), size: typeof size === "number" && size >= 0 ? size : 0 }];
    }),
  };
}

/**
 * The one text a share becomes. Android puts a shared link in `text` (with
 * the page's title as `title`), some apps send "words and a link" there, and
 * a few use `url`. The link stays a link: the title is dropped beside it, and
 * `url` is added only when `text` does not already carry it. A title alone is
 * kept as itself.
 */
export function sharedText(m: Pick<ShareMeta, "title" | "text" | "url">): string {
  const text = m.text.trim();
  const url = m.url.trim();
  if (url && !text.includes(url)) return text ? `${text}\n${url}` : url;
  return text || m.title.trim();
}
