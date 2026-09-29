/**
 * The in-app browser's pure parts: the address a preview port is shown
 * at, what the path box accepts, which ports belong to a repo, and the
 * per-browser memory of what each repo previews. Tested in preview.test.ts.
 */
import type { ListeningPort } from "../../src/core/types";
import { publicPreviewOrigin } from "../../src/core/previewPublic";

/** where each repo's preview was left, by repo id (localStorage) */
export const PREVIEWS_KEY = "canopy.previews";

export interface PreviewChoice {
  port: number;
  path: string;
}

/**
 * Why this page cannot show a preview, or null when it can. A preview is
 * plain http on its own port of the backend's host, so a page served over
 * https from somewhere that is not this machine (the public tunnel) can
 * neither reach that port nor frame http inside https.
 */
export function previewBlocked(loc: { protocol: string; hostname: string }, publicTemplate?: string | null): string | null {
  if (!onPublicPage(loc) || publicTemplate) return null;
  return "Previews are served on the backend's own ports over http, which this https address does not reach. Open canopy at its tailnet address to preview.";
}

/** what the path box holds as a path: `about`, `/about?x` or a whole URL
 *  on the dev server all come back as the path from the first slash */
export function previewPath(input: string): string {
  const s = input.trim();
  if (s === "") return "/";
  const m = /^[a-z][a-z0-9+.-]*:\/\/[^/?#]*(.*)$/i.exec(s);
  const rest = m ? (m[1] ?? "") : s;
  if (rest === "") return "/";
  return rest.startsWith("/") ? rest : `/${rest}`;
}

/** an https page off this machine, which cannot frame an http port */
function onPublicPage(loc: { protocol?: string; hostname: string }): boolean {
  return loc.protocol === "https:" && !["localhost", "127.0.0.1", "[::1]"].includes(loc.hostname);
}

/** the address a preview port shows a path at: the slot's public name for
 *  an https page when the backend has them, else the slot's port on the
 *  host this page came from */
export function previewUrl(loc: { protocol?: string; hostname: string }, slot: number, path: string, publicTemplate?: string | null): string {
  if (publicTemplate && onPublicPage(loc)) return `${publicPreviewOrigin(publicTemplate, slot)}${previewPath(path)}`;
  return `http://${loc.hostname}:${slot}${previewPath(path)}`;
}

/** a repo's own ports first (the ones whose process runs in it), then the
 *  ones no repo claims; another repo's are left out */
export function portsFor(ports: ListeningPort[], repoId: string): { mine: ListeningPort[]; loose: ListeningPort[] } {
  return {
    mine: ports.filter((p) => p.repo === repoId),
    loose: ports.filter((p) => p.repo === undefined),
  };
}

/** a stored choice read back, anything malformed dropped */
export function readChoices(raw: string | null): Record<string, PreviewChoice> {
  const out: Record<string, PreviewChoice> = {};
  if (!raw) return out;
  try {
    const v: unknown = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v)) return out;
    for (const [id, c] of Object.entries(v as Record<string, unknown>)) {
      if (!c || typeof c !== "object") continue;
      const { port, path } = c as { port?: unknown; path?: unknown };
      if (typeof port === "number" && Number.isInteger(port) && port > 0 && port < 65536) {
        out[id] = { port, path: typeof path === "string" ? previewPath(path) : "/" };
      }
    }
  } catch {
    // unreadable: start over
  }
  return out;
}

export function loadChoice(repoId: string): PreviewChoice | null {
  try {
    return readChoices(localStorage.getItem(PREVIEWS_KEY))[repoId] ?? null;
  } catch {
    return null;
  }
}

export function saveChoice(repoId: string, choice: PreviewChoice | null) {
  try {
    const all = readChoices(localStorage.getItem(PREVIEWS_KEY));
    if (choice) all[repoId] = choice;
    else delete all[repoId];
    localStorage.setItem(PREVIEWS_KEY, JSON.stringify(all));
  } catch {
    // storage off: the choice lasts the page
  }
}
