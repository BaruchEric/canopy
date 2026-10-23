import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { WORKING_TREE, type Note } from "../reviewnotes";
import { DiffView, NotedLines } from "./DiffView";

const DIFF = "--- a/f\n+++ b/f\n@@ -1,2 +1,2 @@\n keep\n-old\n+new\n";
const at = { repoId: "canopy", path: "f", where: WORKING_TREE };

const note = (over: Partial<Note> = {}): Note => ({ id: "n1", ...at, side: "new", line: 2, snippet: "+new", text: "say why", ...over });

const noop = () => {};

describe("DiffView", () => {
  test("without a note prop it paints as it always has", () => {
    expect(renderToStaticMarkup(<DiffView diff={"@@ -1 +1 @@\n-a\n+b"} />)).toBe(
      '<pre class="diff"><span class="dl hunk">@@ -1 +1 @@\n</span><span class="dl del">-a\n</span><span class="dl add">+b\n</span></pre>',
    );
    expect(renderToStaticMarkup(<DiffView diff="  " note={at} />)).toContain("No textual changes.");
  });

  test("with one, every numbered line has a gutter button and the headers none", () => {
    const html = renderToStaticMarkup(<DiffView diff={DIFF} note={at} />);
    expect(html.match(/<button[^>]*class="dl-gut/g)).toHaveLength(3);
    expect(html).toContain('aria-label="Leave a note on removed line 2"');
    expect(html).toContain('aria-label="Leave a note on line 2"');
  });

  test("a saved note shows under its line; one whose line is gone, at the foot", () => {
    const all = [note(), note({ id: "n2", line: 9, snippet: "+moved", text: "lost one" }), note({ id: "n3", path: "other" })];
    const html = renderToStaticMarkup(<NotedLines diff={DIFF} at={at} all={all} addNote={noop} removeNote={noop} />);
    expect(html.indexOf("+new")).toBeLessThan(html.indexOf("say why"));
    expect(html).toContain('class="dl-gut has"');
    expect(html).toContain("notes on lines this diff no longer shows");
    expect(html.indexOf("no longer shows")).toBeLessThan(html.indexOf("lost one"));
    expect(html).toContain("line 9: +moved");
    // another file's note stays with that file
    expect(html.match(/say why/g)).toHaveLength(1);
  });
});
