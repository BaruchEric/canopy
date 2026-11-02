import { afterEach, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { registry, setRegistry } from "../registry";
import { IdLabel } from "./IdLabel";

const originalRegistry = registry();

afterEach(() => {
  setRegistry(originalRegistry.home, [...originalRegistry.names]);
});

test("a label shows the id bare at home, the backend's word elsewhere, and a name in the id's place when given", () => {
  setRegistry("a", ["a", "b"]);
  expect(renderToStaticMarkup(<IdLabel id="web-apps/ripe" />)).toBe("web-apps/ripe");
  expect(renderToStaticMarkup(<IdLabel id="b|web-apps/ripe" />)).toBe('web-apps/ripe<span class="backend-word">b</span>');
  expect(renderToStaticMarkup(<IdLabel id="b|trees:a-abc/feat-x" name="a ⑂ feat/x" />)).toBe('a ⑂ feat/x<span class="backend-word">b</span>');
});
