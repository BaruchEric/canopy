/**
 * The in-app browser's pure parts: the address a preview port is shown
 * at, what the path box accepts, which ports belong to a repo, and the
 * per-browser memory of what each repo previews. Tested in preview.test.ts.
 */
import type { ListeningPort } from "../../src/core/types";
import { publicPreviewOrigin } from "../../src/core/previewPublic";
import { clamp } from "./util";

/** where each repo's preview was left, by repo id (localStorage) */
export const PREVIEWS_KEY = "canopy.previews";

/** the framed app's height in place, in px, which its grip drags */
export const PREVIEW_H = { min: 160, max: 2400, initial: 600 };

/** a saved preview height, clamped, or the default for anything else */
export const previewHeightOf = (v: unknown): number =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(clamp(v, PREVIEW_H.min, PREVIEW_H.max)) : PREVIEW_H.initial;

export interface PreviewChoice {
  port: number;
  path: string;
}

/**
 * Where a preview frame points, or why this page cannot frame one.
 *
 * - An https page on the public names' own site takes the slot's public
 *   name. Those names sit behind the site's sign-in gate, whose cookie is
 *   `SameSite=Lax`: a frame carries it only inside a page on that same
 *   site, so anywhere else the frame shows the gate's sign-in and a sign-in
 *   there never sticks.
 * - A plain http page (or a loopback one, for this backend's own ports)
 *   takes the slot's port over http: this page's host for the backend that
 *   served it, the other backend's tailnet IP (`host`) for a checkout there.
 * - Anything else cannot frame it: an https page may not frame http, and
 *   off the public names' site their gate turns the frame away.
 */
export type PreviewTarget =
  | { kind: "public"; origin: (slot: number) => string }
  | { kind: "http"; host: string }
  | { kind: "blocked"; why: string };

export function previewTarget(
  loc: { protocol?: string; hostname: string },
  publicTemplate?: string | null,
  home = true,
  host?: string | null,
): PreviewTarget {
  if (publicTemplate && loc.protocol === "https:" && sameSite(loc.hostname, templateHost(publicTemplate))) {
    return { kind: "public", origin: (slot) => publicPreviewOrigin(publicTemplate, slot) };
  }
  if (loc.protocol !== "https:" || (home && isLoopback(loc.hostname))) {
    if (home) return { kind: "http", host: loc.hostname };
    if (host) return { kind: "http", host };
    return {
      kind: "blocked",
      why: publicTemplate
        ? `This checkout is on another machine. Its preview names (${templateHost(publicTemplate)}) only open inside a page on that site, and it names no tailnet address (CANOPY_PREVIEW_HOST) for an http page like this one.`
        : "This checkout is on another machine, whose preview ports are its own. Its public preview names (CANOPY_PREVIEW_PUBLIC) or its tailnet address (CANOPY_PREVIEW_HOST) on that backend would show it here.",
    };
  }
  return {
    kind: "blocked",
    why: publicTemplate
      ? `The preview names (${templateHost(publicTemplate)}) sign in through their site's gate, whose cookie a frame only carries inside a page on that site. Open canopy there, or at a plain http address, to preview.`
      : "Previews are served on the backend's own ports over http, which this https address does not reach. Open canopy at its tailnet address to preview.",
  };
}

/** why this page cannot show a preview, or null when it can */
export function previewBlocked(
  loc: { protocol?: string; hostname: string },
  publicTemplate?: string | null,
  home = true,
  host?: string | null,
): string | null {
  const t = previewTarget(loc, publicTemplate, home, host);
  return t.kind === "blocked" ? t.why : null;
}

/** the template's hostname, with `{slot}` still in it */
function templateHost(template: string): string {
  return template.replace(/^https:\/\//, "");
}

/** a hostname's site, as a cookie scoped to it sees it: its last two
 *  labels, which is right for the one-label suffixes canopy is served under */
function siteOf(hostname: string): string {
  return hostname.toLowerCase().split(".").slice(-2).join(".");
}

function sameSite(a: string, b: string): boolean {
  return a.includes(".") && siteOf(a) === siteOf(b);
}

function isLoopback(hostname: string): boolean {
  return ["localhost", "127.0.0.1", "[::1]"].includes(hostname);
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

/** the address a preview port shows a path at, per `previewTarget`; null
 *  when this page cannot frame it */
export function previewUrl(
  loc: { protocol?: string; hostname: string },
  slot: number,
  path: string,
  publicTemplate?: string | null,
  home = true,
  host?: string | null,
): string | null {
  const t = previewTarget(loc, publicTemplate, home, host);
  if (t.kind === "public") return `${t.origin(slot)}${previewPath(path)}`;
  if (t.kind === "http") return `http://${t.host}:${slot}${previewPath(path)}`;
  return null;
}

/** a repo's own ports first (the ones whose process runs in it), then the
 *  ones no repo claims; another repo's are left out */
export function portsFor(ports: ListeningPort[], repoId: string): { mine: ListeningPort[]; loose: ListeningPort[] } {
  return {
    mine: ports.filter((p) => p.repo === repoId),
    loose: ports.filter((p) => p.repo === undefined),
  };
}

/** the port a repo previews before anyone picks one: its lowest, which is
 *  the app when a kiosk or a second server runs beside it (5173 before
 *  5178); null when nothing listens in it */
export function defaultPort(mine: ListeningPort[]): number | null {
  return mine.length ? Math.min(...mine.map((p) => p.port)) : null;
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
