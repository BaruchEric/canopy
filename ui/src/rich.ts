/**
 * The files viewer's rich half: syntax colours for source and markdown
 * drawn as a page. Loaded on first use, so the libraries stay out of the
 * main bundle until a file is opened.
 *
 * Both hand back HTML that is safe to put in the page: highlight.js escapes
 * the text it wraps, and rendered markdown goes through DOMPurify. A
 * relative image in markdown keeps its address in `data-src` rather than
 * `src`, since this page's origin is canopy's and not the repo's; the
 * viewer fetches it from the repo itself.
 */
import { baseName, isRelative } from "./finder";
import { extOf } from "../../src/core/filekind";

/** files highlight.js would know by name rather than by extension */
const BY_NAME: Record<string, string> = {
  makefile: "makefile",
  gnumakefile: "makefile",
  gemfile: "ruby",
  rakefile: "ruby",
  ".bashrc": "bash",
  ".zshrc": "bash",
  ".profile": "bash",
  ".gitconfig": "ini",
  ".editorconfig": "ini",
};

/** past this the text is drawn plain: colouring a huge file stalls the page */
export const HIGHLIGHT_MAX = 400_000;

export type Rich = {
  highlight: (text: string, path: string) => string | null;
  markdown: (text: string) => string;
};

let loading: Promise<Rich> | null = null;

export function loadRich(): Promise<Rich> {
  loading ??= (async () => {
    const [{ default: hljs }, { Marked }, { default: DOMPurify }] = await Promise.all([
      import("highlight.js/lib/common"),
      import("marked"),
      import("dompurify"),
    ]);
    const langOf = (path: string): string | null => {
      const ext = extOf(path);
      if (ext && hljs.getLanguage(ext)) return ext;
      return BY_NAME[baseName(path).toLowerCase()] ?? null;
    };
    const highlight = (text: string, path: string): string | null => {
      const lang = langOf(path);
      if (!lang || text.length > HIGHLIGHT_MAX) return null;
      return hljs.highlight(text, { language: lang, ignoreIllegals: true }).value;
    };
    const marked = new Marked({ gfm: true, async: false });
    marked.use({
      renderer: {
        code({ text, lang }) {
          const name = (lang ?? "").split(/\s/)[0] ?? "";
          const body = name && hljs.getLanguage(name) ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value : hljs.highlightAuto(text).value;
          return `<pre><code class="hljs">${body}</code></pre>\n`;
        },
      },
    });
    const purify = DOMPurify(window);
    purify.addHook("afterSanitizeAttributes", (node) => {
      if (node.tagName === "IMG") {
        const src = node.getAttribute("src");
        if (src && isRelative(src)) {
          node.removeAttribute("src");
          node.setAttribute("data-src", src);
        }
      }
    });
    const markdown = (text: string): string => purify.sanitize(marked.parse(text, { async: false }));
    return { highlight, markdown };
  })();
  return loading;
}
