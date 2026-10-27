import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { CostLine } from "../costs";
import { Lines } from "./Costs";

const line: CostLine = { key: "b:r", label: "Recorded work", detail: "repo", usd: 1, est: 0, tokens: 10, seconds: 0, unpriced: 0, at: 1, run: { backend: "b", id: "r" } };

test("a run cost line is a button while service, repo and archive lines remain labels", () => {
  const html = renderToStaticMarkup(<Lines title="By run and chat" lines={[line, { ...line, key: "archive", label: "Archive session", run: undefined }]} empty="none" onOpen={() => {}} />);
  expect(html).toContain('class="landing-branch landing-open">Recorded work</button>');
  expect(html).toContain("Archive session");
  expect(html.match(/<button/g)).toHaveLength(1);
  const readOnly = renderToStaticMarkup(<Lines title="By service" lines={[line]} empty="none" />);
  expect(readOnly).not.toContain("<button");
});
