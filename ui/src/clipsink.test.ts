import { describe, expect, test } from "bun:test";
import { NO_CLIP, noteCopied, onCopied, pageCopyText, type Copied, type CopyTarget } from "./clipsink";

const el = (over: CopyTarget & { inside?: string } = {}): CopyTarget => ({
  closest: (sel: string) => (over.inside && sel === NO_CLIP ? {} : null),
  tagName: "DIV",
  ...over,
});

describe("noteCopied and onCopied", () => {
  test("every listener hears a copy until it stops", () => {
    const heard: Copied[] = [];
    const stop = onCopied((c) => heard.push(c));
    noteCopied({ text: "one", source: "canopy", from: "history" });
    stop();
    noteCopied({ text: "two", source: "canopy" });
    expect(heard).toEqual([{ text: "one", source: "canopy", from: "history" }]);
  });
});

describe("pageCopyText", () => {
  test("the document's selection, or nothing for whitespace", () => {
    expect(pageCopyText(el(), el(), "main\n")).toBe("main\n");
    expect(pageCopyText(null, null, "  \n ")).toBeNull();
  });
  test("a text box's selection is its value between the marks", () => {
    expect(pageCopyText(el({ tagName: "INPUT", type: "text", value: "hello world", selectionStart: 6, selectionEnd: 11 }), null, "")).toBe("world");
    expect(pageCopyText(el({ tagName: "textarea", value: "abc", selectionStart: 1, selectionEnd: 1 }), null, "abc")).toBeNull();
  });
  test("never a password box, a shell, the secrets view or anything marked", () => {
    expect(pageCopyText(el({ tagName: "INPUT", type: "password", value: "hunter2", selectionStart: 0, selectionEnd: 7 }), null, "")).toBeNull();
    expect(pageCopyText(el({ inside: ".secrets-view" }), null, "a value")).toBeNull();
    expect(pageCopyText(el(), el({ inside: ".xterm" }), "screen text")).toBeNull();
  });
});
