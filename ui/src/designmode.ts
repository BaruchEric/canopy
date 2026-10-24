/* The preview's design mode, the pure part: what the element picker in a
   framed page (src/core/pickscript.ts) may say, read as untrusted, and the
   prompt a pick and a note become for the repo's agent. */
import { fence } from "../../src/core/pr";

/** one element the user picked in the preview, every field from the page */
export interface Pick {
  selector: string;
  html: string;
  text: string;
  /** the page's own path and query when it reported one */
  path: string;
  styles: Record<string, string>;
  rect: { x: number; y: number; width: number; height: number };
}

/** the most of each field kept: the page is anyone's code, so it is cut
 *  here whatever the script promised */
export const PICK_MAX = { selector: 300, html: 2000, text: 300, path: 300, styles: 16, style: 120 } as const;

/** the page's word that the picker turned on, or that Esc turned it off */
export type PickSignal = "ready" | "off";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);

/** `{canopy:"pick-ready"}` or `{canopy:"pick-off"}` as a signal, else null */
export function pickSignal(data: unknown): PickSignal | null {
  if (!record(data)) return null;
  if (data.canopy === "pick-ready") return "ready";
  if (data.canopy === "pick-off") return "off";
  return null;
}

/** A `{canopy:"picked"}` message as a `Pick`, every string cut to its
 *  limit and anything of the wrong type dropped; null when it is not one or
 *  names no element. */
export function readPick(data: unknown): Pick | null {
  if (!record(data) || data.canopy !== "picked") return null;
  const selector = str(data.selector, PICK_MAX.selector).trim();
  if (!selector) return null;
  const styles: Record<string, string> = {};
  if (record(data.styles)) {
    for (const [k, v] of Object.entries(data.styles)) {
      if (Object.keys(styles).length >= PICK_MAX.styles) break;
      if (/^[a-z-]{1,40}$/.test(k) && typeof v === "string" && v.trim()) styles[k] = v.slice(0, PICK_MAX.style);
    }
  }
  const r = record(data.rect) ? data.rect : {};
  return {
    selector,
    html: str(data.html, PICK_MAX.html),
    text: str(data.text, PICK_MAX.text).trim(),
    path: str(data.path, PICK_MAX.path),
    styles,
    rect: { x: num(r.x), y: num(r.y), width: num(r.width), height: num(r.height) },
  };
}

/** the dev server's own address for a page, which the agent can open */
export const devUrl = (port: number, path: string): string => `http://localhost:${port}${path.startsWith("/") ? path : `/${path}`}`;

/** what a note on an element asks for: a change, or only an answer */
export type Intent = "change" | "question";

/** a note left on one picked element, waiting with the others to be sent */
export interface Annotation {
  pick: Pick;
  note: string;
  intent: Intent;
}

function reported(pick: Pick): string {
  const styles = Object.entries(pick.styles)
    .map(([k, v]) => `${k}: ${v}`)
    .join("; ");
  const { x, y, width, height } = pick.rect;
  return [
    `selector: ${pick.selector}`,
    pick.path && `page path: ${pick.path}`,
    `box: ${width}x${height} at ${x},${y}`,
    styles && `computed styles: ${styles}`,
    pick.text && `text: ${pick.text}`,
    pick.html && `html:\n${pick.html}`,
  ]
    .filter(Boolean)
    .join("\n");
}

const INTENT_WORD: Record<Intent, string> = { change: "Change", question: "Question" };

/** What the agent is told about a batch of notes (FR-027): each note
 *  numbered with what it asks for, in the user's words, and what the page
 *  reported about its element fenced as data under it, since a page's class
 *  names and text are anyone's words. Questions are to be answered, not
 *  acted on. */
export function annotationsPrompt(list: readonly Annotation[], pageUrl: string): string {
  const one = list.length === 1;
  const head = one ? `In the preview of ${pageUrl} I left a note on an element of the page.` : `In the preview of ${pageUrl} I left ${list.length} notes on elements of the page.`;
  const items = list.map((a, i) => {
    const n = i + 1;
    return `${n}. ${INTENT_WORD[a.intent]}: ${a.note.trim()}\n\n${fence(`What the page reported about element ${n}`, reported(a.pick))}`;
  });
  const changes = list.some((a) => a.intent === "change");
  const questions = list.some((a) => a.intent === "question");
  const ask =
    changes && questions
      ? "Find the code that renders each element. Make the changes the notes ask for, and answer the questions without changing anything for them."
      : questions
        ? "Find the code that renders each element and answer the questions. Change nothing for them."
        : `Find the code that renders ${one ? "it" : "each element"} and make the ${one ? "change" : "changes"} the ${one ? "note asks" : "notes ask"} for.`;
  return `${head}\n\n${items.join("\n\n")}\n\n${ask}`;
}

/** what the page's picker is told to mark: each note's element, numbered
 *  in this order */
export const marksMessage = (list: readonly Annotation[]) => ({ canopy: "marks", list: list.map((a) => a.pick.selector) });
