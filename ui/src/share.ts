/** A gear's share row: copy a surface's text, capture it as a picture,
 *  paste into it. The clipboard API needs a secure page, which canopy over
 *  the tailnet's plain http is not, so each has a way round it there. */
import { captureName } from "./surface";

/** whether this page may read the clipboard */
export const canReadClipboard = (): boolean =>
  typeof window !== "undefined" && window.isSecureContext && typeof navigator.clipboard?.readText === "function";

/** The old copy command with `text` handed to its copy event, which needs
 *  no selection and moves no focus (a shell keeps its keyboard); false
 *  where the browser would not run it, outside a click or a key. Capture on
 *  the window, so xterm's own copy handler never sees the event. */
function copyByCommand(text: string): boolean {
  let put = false;
  const onCopy = (e: ClipboardEvent) => {
    if (!e.clipboardData) return;
    e.clipboardData.setData("text/plain", text);
    e.preventDefault();
    e.stopImmediatePropagation();
    put = true;
  };
  window.addEventListener("copy", onCopy, true);
  try {
    document.execCommand("copy");
  } finally {
    window.removeEventListener("copy", onCopy, true);
  }
  return put;
}

/** Puts `text` on the clipboard: through the clipboard API where the page
 *  may, else through the old copy command, which any page may run inside a
 *  click or a key, and a hidden textarea as the last way round. */
export async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (err) {
      // refused (a page without focus, Firefox outside a click): the old
      // command may still be allowed
      if (copyByCommand(text)) return;
      throw err;
    }
  }
  if (copyByCommand(text)) return;
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.append(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  if (!ok) throw new Error("the browser would not copy");
}

/** the clipboard's text, or null where the page may not read it */
export async function readText(): Promise<string | null> {
  if (!canReadClipboard()) return null;
  return navigator.clipboard.readText();
}

/** What a surface says, as text: every child but its head and gear, so a
 *  copy of the history section is the log, not the word "history". */
export function surfaceText(el: HTMLElement): string {
  const parts: string[] = [];
  for (const child of Array.from(el.children)) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.matches(".section-head, .focus-grip, .term-grip, .gear")) continue;
    const t = child.innerText.trim();
    if (t) parts.push(t);
  }
  return parts.join("\n\n");
}

/** what never goes into a capture: the gears and the drag handles */
const skip = (node: Node): boolean =>
  !(node instanceof Element && node.matches(".gear, .focus-grip, .term-grip, .panel-resizer"));

/**
 * A picture of `el` as it shows now. On the clipboard where the page may
 * write images to it, else saved as a png download; the answer says which.
 * The library is fetched on first use so the page does not carry it.
 */
export async function capture(el: HTMLElement, label: string): Promise<"clipboard" | "download"> {
  const { domToBlob } = await import("modern-screenshot");
  const background = getComputedStyle(document.body).backgroundColor;
  const shot = () =>
    domToBlob(el, {
      scale: Math.min(2, window.devicePixelRatio || 1),
      backgroundColor: background,
      filter: skip,
      type: "image/png",
    });
  if (window.isSecureContext && typeof ClipboardItem !== "undefined" && navigator.clipboard?.write) {
    try {
      // the promise goes in the item, so Safari still counts the write as
      // part of the click that asked for it
      await navigator.clipboard.write([new ClipboardItem({ "image/png": shot() })]);
      return "clipboard";
    } catch {
      // a browser that refuses image writes still gets the file
    }
  }
  const blob = await shot();
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = captureName(label, new Date());
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return "download";
}
