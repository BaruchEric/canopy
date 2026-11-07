import { expect, test } from "bun:test";
import { editBytes } from "./softinput";

const DEL = "\x7f";

test("editBytes: a composition growing a letter sends the letter", () => {
  expect(editBytes("", "h")).toBe("h");
  expect(editBytes("h", "he")).toBe("e");
  expect(editBytes("cat ", "cat w")).toBe("w");
});

test("editBytes: nothing changed sends nothing", () => {
  expect(editBytes("", "")).toBe("");
  expect(editBytes("hello", "hello")).toBe("");
});

test("editBytes: a backspace sends a DEL", () => {
  expect(editBytes("helo", "hel")).toBe(DEL);
  expect(editBytes("a", "")).toBe(DEL);
});

test("editBytes: a correction deletes back to where it differs and types the rest", () => {
  expect(editBytes("teh", "the ")).toBe(`${DEL}${DEL}he `);
  expect(editBytes("wor", "world ")).toBe("ld ");
  expect(editBytes("ls -la", "ls -l")).toBe(DEL);
});

test("editBytes: an edit before the end retypes the tail", () => {
  expect(editBytes("abcdef", "abcxdef")).toBe(`${DEL.repeat(3)}xdef`);
});

test("editBytes: an emoji is one character", () => {
  expect(editBytes("hi 👍", "hi ")).toBe(DEL);
  expect(editBytes("hi ", "hi 👍")).toBe("👍");
});

test("editBytes: a line break is Enter", () => {
  expect(editBytes("ls", "ls\n")).toBe("\r");
  expect(editBytes("", "a\r\nb")).toBe("a\rb");
});
