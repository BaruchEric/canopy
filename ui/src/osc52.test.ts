import { expect, test } from "bun:test";
import { osc52Text } from "./osc52";

const b64 = (s: string) => Buffer.from(s, "utf8").toString("base64");

test("the clipboard's text, from any selection a program names", () => {
  expect(osc52Text(`c;${b64("hello")}`)).toBe("hello");
  expect(osc52Text(`p;${b64("primary")}`)).toBe("primary");
  expect(osc52Text(`cp;${b64("both")}`)).toBe("both");
  // tmux's own Ms names none
  expect(osc52Text(`;${b64("from tmux")}`)).toBe("from tmux");
});

test("UTF-8 and line breaks come through", () => {
  expect(osc52Text(`c;${b64("héllo → wörld\nline two")}`)).toBe("héllo → wörld\nline two");
});

test("a query is never answered", () => {
  expect(osc52Text("c;?")).toBeNull();
});

test("a clear, a malformed body or bad bytes is nothing", () => {
  expect(osc52Text("c;")).toBeNull();
  expect(osc52Text("no semicolon")).toBeNull();
  expect(osc52Text(`x;${b64("bad target")}`)).toBeNull();
  expect(osc52Text("c;!!not base64!!")).toBeNull();
  // valid base64 of bytes that are not UTF-8
  expect(osc52Text(`c;${Buffer.from([0xff, 0xfe, 0x80]).toString("base64")}`)).toBeNull();
});
