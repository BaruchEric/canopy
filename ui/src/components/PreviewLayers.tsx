import { useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import type { Rect } from "../designmode";
import { COLORS, arrowHead, colorName, penPath, tooSmall, type Point, type Shape, type Tool } from "../markup";

/** the least a dragged box must span to be a picture */
const CLIP_LEAST = 8;

/** a pointer's place inside `el`, CSS pixels from its top left */
function inside(el: HTMLElement | null, e: ReactPointerEvent): Point {
  const r = el?.getBoundingClientRect();
  return r ? { x: e.clientX - r.left, y: e.clientY - r.top } : { x: e.clientX, y: e.clientY };
}

const span = (a: Point, b: Point): Rect => ({
  x: Math.round(Math.min(a.x, b.x)),
  y: Math.round(Math.min(a.y, b.y)),
  width: Math.round(Math.abs(a.x - b.x)),
  height: Math.round(Math.abs(a.y - b.y)),
});

/**
 * The clip tool's layer over the frame (FR-029): a drag draws a box, and
 * letting go hands the box over for its picture. The box is cleared before
 * that, so the picture shows the page alone. The layer covers the frame,
 * so the page sees none of the pointer.
 */
export function ClipLayer({ onClip }: { onClip: (rect: Rect) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [from, setFrom] = useState<Point | null>(null);
  const [to, setTo] = useState<Point | null>(null);
  const rect = from && to ? span(from, to) : null;
  return (
    <div
      ref={box}
      className="preview-clip-layer"
      role="application"
      aria-label="Drag a box on the page to take its picture"
      onPointerDown={(e) => {
        if (e.button !== 0) return;
        e.currentTarget.setPointerCapture(e.pointerId);
        const p = inside(box.current, e);
        setFrom(p);
        setTo(p);
      }}
      onPointerMove={(e) => {
        if (from) setTo(inside(box.current, e));
      }}
      onPointerUp={(e) => {
        if (!from) return;
        const r = span(from, inside(box.current, e));
        setFrom(null);
        setTo(null);
        if (r.width >= CLIP_LEAST && r.height >= CLIP_LEAST) onClip(r);
      }}
      onPointerCancel={() => {
        setFrom(null);
        setTo(null);
      }}
    >
      {rect && <div className="preview-clip-box" style={{ left: rect.x, top: rect.y, width: rect.width, height: rect.height }} />}
    </div>
  );
}

/** one mark as SVG */
function ShapeView({ s }: { s: Shape }) {
  const stroke = { stroke: s.color, strokeWidth: 3, fill: "none", strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (s.kind) {
    case "pen":
      return <path d={penPath(s.points)} {...stroke} />;
    case "arrow": {
      const [a, b] = arrowHead(s.from, s.to, 12);
      return (
        <g {...stroke}>
          <line x1={s.from.x} y1={s.from.y} x2={s.to.x} y2={s.to.y} />
          <polyline points={`${a.x},${a.y} ${s.to.x},${s.to.y} ${b.x},${b.y}`} />
        </g>
      );
    }
    case "box": {
      const x = Math.min(s.from.x, s.to.x);
      const y = Math.min(s.from.y, s.to.y);
      return <rect x={x} y={y} width={Math.abs(s.from.x - s.to.x)} height={Math.abs(s.from.y - s.to.y)} rx={2} {...stroke} />;
    }
    case "text":
      return (
        <text x={s.at.x} y={s.at.y} fill={s.color} className="preview-draw-word">
          {s.text}
        </text>
      );
  }
}

/**
 * The draw tool's layer over the frame (FR-029): pen, arrow, box and text
 * marks in the colour chosen, kept as shapes so undo is a pop. A click
 * with the text tool opens a box to type in; Enter keeps the words, Esc
 * drops them. The marks are on screen when the picture is taken, so they
 * are in it.
 */
export function DrawLayer({ shapes, onChange, tool, color }: { shapes: readonly Shape[]; onChange: (next: Shape[]) => void; tool: Tool; color: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [draft, setDraft] = useState<Shape | null>(null);
  const [typing, setTyping] = useState<Point | null>(null);
  const [words, setWords] = useState("");
  const keepWords = () => {
    if (typing) {
      const s: Shape = { kind: "text", color, at: typing, text: words };
      if (!tooSmall(s)) onChange([...shapes, s]);
    }
    setTyping(null);
    setWords("");
  };
  return (
    <div
      ref={box}
      className="preview-draw-layer"
      role="application"
      aria-label="Draw on the page"
      onPointerDown={(e) => {
        if (e.button !== 0 || typing) return;
        const p = inside(box.current, e);
        if (tool === "text") {
          // the mousedown that would follow moves focus off the input the
          // moment it opens (its blur closes it), so there is no mousedown
          e.preventDefault();
          setTyping(p);
          return;
        }
        e.currentTarget.setPointerCapture(e.pointerId);
        setDraft(tool === "pen" ? { kind: "pen", color, points: [p] } : { kind: tool, color, from: p, to: p });
      }}
      onPointerMove={(e) => {
        // a text mark is typed, not dragged
        if (!draft || draft.kind === "text") return;
        const p = inside(box.current, e);
        setDraft(draft.kind === "pen" ? { ...draft, points: [...draft.points, p] } : { ...draft, to: p });
      }}
      onPointerUp={() => {
        if (!draft) return;
        setDraft(null);
        if (!tooSmall(draft)) onChange([...shapes, draft]);
      }}
      onPointerCancel={() => setDraft(null)}
    >
      <svg className="preview-draw-svg" aria-hidden="true">
        {shapes.map((s, i) => (
          <ShapeView key={i} s={s} />
        ))}
        {draft && <ShapeView s={draft} />}
      </svg>
      {typing && (
        <input
          className="preview-draw-text"
          style={{ left: typing.x, top: typing.y, color }}
          aria-label="Words to put on the page"
          placeholder="type, then Enter"
          autoFocus
          value={words}
          onChange={(e) => setWords(e.target.value)}
          onPointerDown={(e) => e.stopPropagation()}
          onKeyDown={(e) => {
            e.stopPropagation();
            if (e.key === "Enter") keepWords();
            else if (e.key === "Escape") {
              setTyping(null);
              setWords("");
            }
          }}
          onBlur={keepWords}
        />
      )}
    </div>
  );
}

const TOOLS: { tool: Tool; glyph: string; word: string }[] = [
  { tool: "pen", glyph: "✎", word: "pen" },
  { tool: "arrow", glyph: "➚", word: "arrow" },
  { tool: "box", glyph: "▭", word: "box" },
  { tool: "text", glyph: "T", word: "text" },
];

/**
 * The draw mode's bar, over the frame's top edge: the tool, the colour,
 * undo and clear, then "snap" for a picture of the page with the marks on
 * it and a note to go with it, or "done" to stop without one.
 */
export function DrawBar({
  tool,
  setTool,
  color,
  setColor,
  marks,
  onUndo,
  onClear,
  onSnap,
  onDone,
  busy,
}: {
  tool: Tool;
  setTool: (t: Tool) => void;
  color: string;
  setColor: (c: string) => void;
  /** how many marks there are, for undo and clear */
  marks: number;
  onUndo: () => void;
  onClear: () => void;
  onSnap: () => void;
  onDone: () => void;
  busy: boolean;
}) {
  return (
    <div className="preview-draw-bar" role="toolbar" aria-label="Draw on the page">
      <div role="radiogroup" aria-label="Tool" className="preview-draw-group">
        {TOOLS.map((t) => (
          <button key={t.tool} type="button" role="radio" aria-checked={tool === t.tool} className={`mini${tool === t.tool ? " on" : ""}`} title={t.word} aria-label={t.word} onClick={() => setTool(t.tool)}>
            {t.glyph}
          </button>
        ))}
      </div>
      <div role="radiogroup" aria-label="Colour" className="preview-draw-group">
        {COLORS.map((c) => (
          <button
            key={c.hex}
            type="button"
            role="radio"
            aria-checked={color === c.hex}
            className={`preview-draw-swatch${color === c.hex ? " on" : ""}`}
            style={{ background: c.hex }}
            title={colorName(c.hex)}
            aria-label={colorName(c.hex)}
            onClick={() => setColor(c.hex)}
          />
        ))}
      </div>
      <button type="button" className="mini" disabled={marks === 0} onClick={onUndo} title="Undo the last mark" aria-label="Undo the last mark">
        ↶
      </button>
      <button type="button" className="mini" disabled={marks === 0} onClick={onClear} title="Clear the marks">
        clear
      </button>
      <button type="button" className="mini" disabled={busy || marks === 0} onClick={onSnap} title="Take a picture of the page with the marks on it, and write a note to go with it">
        snap
      </button>
      <button type="button" className="mini" disabled={busy} onClick={onDone} title="Stop drawing (Esc)">
        done
      </button>
    </div>
  );
}
