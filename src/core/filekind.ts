/**
 * What a file in a repo is, by its name: how the files section shows it and
 * the type the server sends its bytes under. Browser-safe, since the UI
 * picks a viewer from the same table the server picks a type from.
 */

/** how the viewer shows a file: text with line numbers, an image, a player,
 *  the browser's PDF viewer, or nothing but its name and size */
export type FileKind = "text" | "image" | "video" | "audio" | "pdf" | "binary";

const TABLE: Record<string, [FileKind, string]> = {
  png: ["image", "image/png"],
  jpg: ["image", "image/jpeg"],
  jpeg: ["image", "image/jpeg"],
  gif: ["image", "image/gif"],
  webp: ["image", "image/webp"],
  avif: ["image", "image/avif"],
  bmp: ["image", "image/bmp"],
  ico: ["image", "image/x-icon"],
  svg: ["image", "image/svg+xml"],
  mp4: ["video", "video/mp4"],
  m4v: ["video", "video/mp4"],
  webm: ["video", "video/webm"],
  mov: ["video", "video/quicktime"],
  mp3: ["audio", "audio/mpeg"],
  m4a: ["audio", "audio/mp4"],
  wav: ["audio", "audio/wav"],
  ogg: ["audio", "audio/ogg"],
  flac: ["audio", "audio/flac"],
  pdf: ["pdf", "application/pdf"],
};

/** names whose bytes are no use as text, so the viewer does not fetch them */
const BINARY = new Set(
  "zip gz tgz bz2 xz zst 7z rar tar dmg iso pkg exe dll so dylib a o obj class jar war wasm node bin dat db sqlite sqlite3 woff woff2 ttf otf eot psd ai sketch fig xcf heic tif tiff raw cr2 nef mkv avi wmv doc docx xls xlsx ppt pptx key numbers pages lockb pyc".split(" "),
);

/** a file name's extension, lower case, or "" for none (a dotfile's name is
 *  not its extension) */
export function extOf(name: string): string {
  const base = name.slice(name.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot > 0 ? base.slice(dot + 1).toLowerCase() : "";
}

/** How a file is shown. Anything not known to be media or binary is tried as
 *  text, which covers source, config and extensionless files like Makefile;
 *  the viewer falls back to binary when the bytes turn out not to be. */
export function fileKind(name: string): FileKind {
  const ext = extOf(name);
  const known = TABLE[ext];
  if (known) return known[0];
  return BINARY.has(ext) ? "binary" : "text";
}

/** The type the server sends a file's bytes under. Text goes as plain text
 *  whatever it holds, so an HTML or script file is never a page. */
export function mimeOf(name: string): string {
  const known = TABLE[extOf(name)];
  if (known) return known[1];
  return fileKind(name) === "binary" ? "application/octet-stream" : "text/plain; charset=utf-8";
}
