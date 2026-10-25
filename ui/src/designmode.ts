/* The preview's design mode, the pure part: what the element picker in a
   framed page (src/core/pickscript.ts) may say, read as untrusted, and the
   prompt the picks, the pictures and the notes become for the repo's agent. */
import { fence } from "../../src/core/pr";

/** a box in CSS pixels */
export interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** how the page came to report an element: a click on it, or the C (copy)
 *  or S (picture) key while the pointer was over it (FR-029) */
export type PickVia = "click" | "copy" | "shot";

/** one element the user picked in the preview, every field from the page */
export interface Pick {
  selector: string;
  html: string;
  text: string;
  /** the page's own path and query when it reported one */
  path: string;
  styles: Record<string, string>;
  rect: Rect;
  via: PickVia;
}

/** the most of each field kept: the page is anyone's code, so it is cut
 *  here whatever the script promised */
export const PICK_MAX = { selector: 300, html: 2000, text: 300, path: 300, styles: 16, style: 120 } as const;

/** the page's word that the picker turned on, or that Esc turned it off */
export type PickSignal = "ready" | "off";

const record = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown, max: number): string => (typeof v === "string" ? v.slice(0, max) : "");
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? Math.round(v) : 0);
const via = (v: unknown): PickVia => (v === "copy" || v === "shot" ? v : "click");

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
    via: via(data.via),
  };
}

/** the dev server's own address for a page, which the agent can open */
export const devUrl = (port: number, path: string): string => `http://localhost:${port}${path.startsWith("/") ? path : `/${path}`}`;

/** what a note asks for: a change, or only an answer */
export type Intent = "change" | "question";

/** A picture of part of the page (FR-029), saved on the backend where the
 *  repo's agent can read it. */
export interface Clip {
  /** what the picture is of: one element, a box dragged on the page, or
   *  the page with marks drawn over it */
  kind: "element" | "region" | "markup";
  /** the saved file on the backend, as the agent's file reader wants it;
   *  null when this browser could not take the picture */
  path: string | null;
  /** the box in the page's viewport */
  rect: Rect;
  /** the marks drawn over it, in words (markupWords), else empty */
  marks: string;
  /** the picture as this page shows it, an object URL; never sent */
  thumb: string | null;
}

/** a note waiting with the others to be sent: on an element, on a
 *  picture, or on both (an element's own picture) */
export interface Annotation {
  pick: Pick | null;
  clip: Clip | null;
  note: string;
  intent: Intent;
}

/** what the page reported about a picked element, as text: what the
 *  prompt fences and what the C key copies */
export function pickText(pick: Pick): string {
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

const boxWords = ({ x, y, width, height }: Rect): string => `${width}x${height} at ${x},${y} of the page's viewport`;

/** what a picture is of, in words that follow "Picture n:" or "is about" */
function clipOf(clip: Clip): string {
  const box = boxWords(clip.rect);
  if (clip.kind === "element") return `the element, ${box}`;
  if (clip.kind === "markup") return `the page, ${box}, with my marks drawn over it`;
  return `the box ${box}`;
}

function clipLines(clip: Clip, n: number): string {
  const where = clip.path
    ? `Picture ${n}: ${clip.path}, ${clipOf(clip)}. Read that file to see it.`
    : `No picture could be taken on this browser; note ${n} is about ${clipOf(clip)}.`;
  return clip.marks ? `${where}\nThe marks: ${clip.marks}` : where;
}

/** What the agent is told about a batch of notes (FR-027, FR-029): each
 *  note numbered with what it asks for, in the user's words; the picture
 *  that goes with it, by the file's path; and what the page reported about
 *  its element fenced as data under it, since a page's class names and
 *  text are anyone's words. Several notes are organized by the agent
 *  before it acts; questions are to be answered, not acted on. */
export function annotationsPrompt(list: readonly Annotation[], pageUrl: string): string {
  const one = list.length === 1;
  const head = one ? `In the preview of ${pageUrl} I left a note on the page.` : `In the preview of ${pageUrl} I left ${list.length} notes on the page.`;
  const items = list.map((a, i) => {
    const n = i + 1;
    const parts = [`${n}. ${INTENT_WORD[a.intent]}: ${a.note.trim()}`];
    if (a.clip) parts.push(clipLines(a.clip, n));
    if (a.pick) parts.push(fence(`What the page reported about element ${n}`, pickText(a.pick)));
    return parts.join("\n\n");
  });
  const pictures = list.filter((a) => a.clip?.path).length;
  const elements = list.every((a) => a.pick);
  const what = one ? (elements ? "it" : "what the note is about") : elements ? "each element" : "what each note is about";
  const changes = list.some((a) => a.intent === "change");
  const questions = list.some((a) => a.intent === "question");
  const ask =
    changes && questions
      ? `Find the code that renders ${what}. Make the changes the notes ask for, and answer the questions without changing anything for them.`
      : questions
        ? `Find the code that renders ${what} and answer the questions. Change nothing for them.`
        : `Find the code that renders ${what} and make the ${one ? "change" : "changes"} the ${one ? "note asks" : "notes ask"} for.`;
  const steps: string[] = [];
  if (!one) steps.push("Organize the notes first: group the ones that touch the same component or file, keep their numbers, and open with that plan in a few lines.");
  if (pictures) steps.push(`Read ${pictures === 1 ? "the picture file" : "each picture file"} before acting on its note.`);
  steps.push(ask);
  return `${head}\n\n${items.join("\n\n")}\n\n${steps.join(" ")}`;
}

/** what the page's picker is told to mark: each note's element, numbered
 *  in this order, a blank where a note is on a picture alone */
export const marksMessage = (list: readonly Annotation[]) => ({ canopy: "marks", list: list.map((a) => a.pick?.selector ?? "") });
