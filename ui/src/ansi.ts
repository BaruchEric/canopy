/**
 * A pane's screen as tmux captures it (`capture-pane -p -e`), escape codes
 * and all, read into lines of styled runs for a peek: the board draws a
 * shell it does not join this way, so a tile never sizes the shell it
 * shows. Only SGR is read (colours, bold, dim, italic, underline,
 * inverse); every other escape is dropped. The 16 ANSI colours map onto
 * the same tokens the xterm theme paints them with (TermDock's
 * `xtermTheme`), so a peek and a live shell agree. Pure; tested in
 * ansi.test.ts.
 */

export interface AnsiRun {
  text: string;
  fg?: string;
  bg?: string;
  bold?: true;
  dim?: true;
  italic?: true;
  under?: true;
  inverse?: true;
}

export type AnsiLine = AnsiRun[];

/** ANSI 0 to 15 as the xterm theme paints them */
const ANSI16 = [
  "--bark3",
  "--rust",
  "--moss",
  "--lichen",
  "--sky",
  "--term-magenta",
  "--term-cyan",
  "--ink-dim",
  "--ink-faint",
  "--rust",
  "--moss-pale",
  "--lichen",
  "--sky",
  "--term-magenta",
  "--term-cyan",
  "--ink",
].map((v) => `var(${v})`);

const CUBE = [0, 95, 135, 175, 215, 255];

/** one of xterm's 256 colours as CSS */
export function color256(n: number): string | undefined {
  if (!Number.isInteger(n) || n < 0 || n > 255) return undefined;
  if (n < 16) return ANSI16[n];
  if (n < 232) {
    const i = n - 16;
    return `rgb(${CUBE[Math.floor(i / 36)]} ${CUBE[Math.floor(i / 6) % 6]} ${CUBE[i % 6]})`;
  }
  const g = 8 + (n - 232) * 10;
  return `rgb(${g} ${g} ${g})`;
}

type Style = Omit<AnsiRun, "text">;

/** the style after one SGR sequence's parameters */
export function applySgr(style: Style, params: string): Style {
  // "38:2::r:g:b" (colons) and "38;2;r;g;b" read the same
  const p = params === "" ? [0] : params.split(/[;:]/).map((x) => (x === "" ? NaN : Number(x)));
  let s: Style = { ...style };
  for (let i = 0; i < p.length; i++) {
    const n = p[i]!;
    // an empty field is a 0; the empty one inside a colour is read there
    if (n === 0 || Number.isNaN(n)) s = {};
    else if (n === 1) s.bold = true;
    else if (n === 2) s.dim = true;
    else if (n === 3) s.italic = true;
    else if (n === 4) s.under = true;
    else if (n === 7) s.inverse = true;
    else if (n === 22) {
      delete s.bold;
      delete s.dim;
    } else if (n === 23) delete s.italic;
    else if (n === 24) delete s.under;
    else if (n === 27) delete s.inverse;
    else if (n >= 30 && n <= 37) s.fg = ANSI16[n - 30];
    else if (n >= 90 && n <= 97) s.fg = ANSI16[n - 90 + 8];
    else if (n === 39) delete s.fg;
    else if (n >= 40 && n <= 47) s.bg = ANSI16[n - 40];
    else if (n >= 100 && n <= 107) s.bg = ANSI16[n - 100 + 8];
    else if (n === 49) delete s.bg;
    else if (n === 38 || n === 48) {
      const key = n === 38 ? "fg" : "bg";
      // the colour space field the colon form may carry is empty: skip it
      let j = i + 1;
      const mode = p[j];
      if (mode === 5) {
        const c = color256(p[j + 1] ?? NaN);
        if (c) s[key] = c;
        i = j + 1;
      } else if (mode === 2) {
        const rest = p.slice(j + 1).filter((x) => !Number.isNaN(x));
        const [r, g, b] = rest;
        if (r !== undefined && g !== undefined && b !== undefined) s[key] = `rgb(${r} ${g} ${b})`;
        // skip the empty colour space field when there is one
        while (j + 1 < p.length && Number.isNaN(p[j + 1]!)) j++;
        i = j + 3;
      } else i = j;
    }
  }
  return s;
}

const same = (a: Style, b: Style): boolean =>
  a.fg === b.fg && a.bg === b.bg && a.bold === b.bold && a.dim === b.dim && a.italic === b.italic && a.under === b.under && a.inverse === b.inverse;

/** The text as lines of runs. A line's trailing blanks are kept as tmux
 *  sends them; the last line, empty after the final newline, is not. */
export function ansiLines(text: string): AnsiLine[] {
  const lines: AnsiLine[] = [];
  let line: AnsiLine = [];
  let style: Style = {};
  let buf = "";
  const flush = () => {
    if (!buf) return;
    const last = line[line.length - 1];
    if (last && same(last, style)) last.text += buf;
    else line.push({ text: buf, ...style });
    buf = "";
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (ch === "\n") {
      flush();
      lines.push(line);
      line = [];
      continue;
    }
    if (ch === "\r") continue;
    if (ch !== "\x1b") {
      buf += ch;
      continue;
    }
    const next = text[i + 1];
    if (next === "[") {
      // CSI: parameters, then one final byte from @ to ~
      let j = i + 2;
      while (j < text.length && !/[@-~]/.test(text[j]!)) j++;
      if (text[j] === "m") {
        flush();
        style = applySgr(style, text.slice(i + 2, j));
      }
      i = j;
    } else if (next === "]") {
      // OSC: up to BEL or ST
      let j = i + 2;
      while (j < text.length && text[j] !== "\x07" && !(text[j] === "\x1b" && text[j + 1] === "\\")) j++;
      i = text[j] === "\x1b" ? j + 1 : j;
    } else if (next !== undefined && "()*+".includes(next)) {
      // a charset pick: ESC, the slot, the set
      i += 2;
    } else i += 1;
  }
  flush();
  if (line.length > 0) lines.push(line);
  return lines;
}

/** the lines with nothing on them dropped from the end */
export function trimTail(lines: readonly AnsiLine[]): AnsiLine[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]!.every((r) => r.text.trim() === "" && r.bg === undefined && r.inverse === undefined)) end--;
  return lines.slice(0, end);
}
