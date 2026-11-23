import { describe, expect, test } from "bun:test";
import {
  ARCHIFY_COMMANDS,
  ARCHIFY_TYPES,
  archifyFolder,
  archifyHead,
  archifyLine,
  archifySpec,
  archifyTask,
  archifyTools,
  checksWord,
  isArchifyPick,
  isPageName,
  isPlainName,
  parseFinalizeSummary,
  slugOf,
  titleOfPage,
  typeOfFolder,
  type ArchifyDiagram,
} from "./archify";

const SKILL = "/app/lib/archify/skills/archify";
const ROOT = "/home/eric/dev/shop";
const FOLDER = "architecture-shop-20261121-101500";

describe("names", () => {
  test("a plain name is one safe part, never a way out", () => {
    expect(isPlainName(FOLDER)).toBe(true);
    expect(isPlainName("review-2")).toBe(true);
    for (const bad of ["", ".", "..", "../x", "a/b", "a\\b", ".hidden", "a..b", "x\0y", "a b", "x".repeat(129)]) expect(isPlainName(bad)).toBe(false);
    expect(isPageName("shop.html")).toBe(true);
    expect(isPageName("shop.json")).toBe(false);
  });

  test("a slug is short, lowercase and cut at a dash", () => {
    expect(slugOf("The checkout's request path!")).toBe("the-checkout-s-request-path");
    expect(slugOf("Ünïcode  café")).toBe("unicode-cafe");
    expect(slugOf("how the landing queue rebases a branch and runs the gates")).toBe("how-the-landing-queue-rebases-a");
    expect(slugOf("x".repeat(40))).toBe("x".repeat(32));
    expect(slugOf("!!!")).toBe("");
  });

  test("a new folder is the type, a slug and the local time, as the skill names one", () => {
    const at = new Date(2026, 10, 21, 9, 5, 7);
    expect(archifyFolder("sequence", "login request", "shop", at)).toBe("sequence-login-request-20261121-090507");
    expect(archifyFolder("auto", "", "Shop App", at)).toBe("diagram-shop-app-20261121-090507");
    expect(archifyFolder("architecture", "  ", "###", at)).toBe("architecture-repo-20261121-090507");
  });

  test("a folder's name gives its type back", () => {
    expect(typeOfFolder(FOLDER)).toBe("architecture");
    expect(typeOfFolder("erd-orders-20261121-090507")).toBe("erd");
    expect(typeOfFolder("diagram-shop-20261121-090507")).toBeNull();
  });

  test("a pick is auto or one of the eleven types", () => {
    expect(ARCHIFY_TYPES).toHaveLength(11);
    expect(isArchifyPick("auto")).toBe(true);
    expect(isArchifyPick("waterfall")).toBe(true);
    expect(isArchifyPick("mindmap")).toBe(false);
    expect(isArchifyPick(3)).toBe(false);
  });
});

describe("parseFinalizeSummary", () => {
  const summary = (over: Record<string, unknown>) => ({
    schemaVersion: 1,
    command: "finalize",
    status: "pass",
    type: "architecture",
    artifact: { path: "/home/eric/dev/shop/.archify/x/shop.html", sha256: "ab", bytes: 9 },
    gates: { validate: "pass", deliver: "pass", check: "pass", "browser-check": "pass" },
    ...over,
  });

  test("every gate passed", () => {
    expect(parseFinalizeSummary(summary({}))).toEqual({ type: "architecture", checks: "pass", file: "shop.html" });
  });

  test("no Chrome here: delivered and checked, the browser check skipped", () => {
    const raw = summary({ status: "skipped", gates: { validate: "pass", deliver: "pass", check: "pass", "browser-check": "skipped" } });
    expect(parseFinalizeSummary(raw)?.checks).toBe("browser-skipped");
  });

  test("a skip before delivery, or any other status, is a failure", () => {
    expect(parseFinalizeSummary(summary({ status: "skipped", gates: { validate: "pass", deliver: "fail" } }))?.checks).toBe("fail");
    expect(parseFinalizeSummary(summary({ status: "fail" }))?.checks).toBe("fail");
  });

  test("only the artifact's file name is kept, and only a page's", () => {
    expect(parseFinalizeSummary(summary({ artifact: { path: "C:\\x\\y\\page.html" } }))?.file).toBe("page.html");
    expect(parseFinalizeSummary(summary({ artifact: { path: "/etc/passwd" } }))?.file).toBeNull();
    expect(parseFinalizeSummary(summary({ artifact: "nope" }))?.file).toBeNull();
  });

  test("a type it does not know is null, and anything not a finalize receipt is nothing", () => {
    expect(parseFinalizeSummary(summary({ type: "mindmap" }))?.type).toBeNull();
    expect(parseFinalizeSummary({ command: "deliver", status: "pass" })).toBeNull();
    expect(parseFinalizeSummary(null)).toBeNull();
    expect(parseFinalizeSummary([1])).toBeNull();
  });
});

test("titleOfPage reads the first <title> and decodes it", () => {
  expect(titleOfPage("<!doctype html><head><title>Sample Web App Diagram</title></head><title>later</title>")).toBe("Sample Web App Diagram");
  expect(titleOfPage("<title>Auth &amp; tokens &#8212; &#x2192; &lt;api&gt; &bogus;</title>")).toBe("Auth & tokens — → <api> &bogus;");
  expect(titleOfPage("<title>  a\n  b </title>")).toBe("a b");
  expect(titleOfPage("<title></title>")).toBeNull();
  expect(titleOfPage("no title")).toBeNull();
});

describe("a diagram run", () => {
  test("may write its own folder by an absolute Edit rule and run the CLI by its path", () => {
    const tools = archifyTools(SKILL, ROOT, FOLDER);
    expect(tools).toContain(`Edit(//home/eric/dev/shop/.archify/${FOLDER}/**)`);
    // Claude matches file rules on Edit only: a Write rule would be refused
    expect(tools.some((t) => t.startsWith("Write("))).toBe(false);
    expect(tools).toContain(`Bash(node ${SKILL}/bin/archify.mjs finalize:*)`);
    expect(tools).toContain(`Bash(node ${SKILL}/bin/archify.mjs browser-check:*)`);
    expect(tools).toContain("Read");
    expect(tools).toContain("Bash(git rev-parse:*)");
  });

  test("runs only the CLI's drawing and checking commands unasked", () => {
    const cli = `Bash(node ${SKILL}/bin/archify.mjs`;
    const rules = archifyTools(SKILL, ROOT, FOLDER).filter((t) => t.startsWith(cli));
    expect(rules).toEqual(ARCHIFY_COMMANDS.map((c) => `${cli} ${c}:*)`));
    // the whole CLI under one rule would let these run too: a local server,
    // other toolchains and a config file's program, and a post to a pull request
    expect(rules).not.toContain(`${cli}:*)`);
    for (const asks of ["start", "code-analysis", "pr", "preview", "demo"]) {
      expect(rules.some((r) => `${cli} ${asks} x`.startsWith(r.slice(0, -3)))).toBe(false);
    }
  });

  test("a new diagram's task names the skill, the type, the folder and where canopy differs", () => {
    const task = archifyTask({ skillDir: SKILL, root: ROOT, folder: FOLDER, origin: true, type: "sequence" });
    expect(task).toContain("draw an Archify diagram of this repository with the archify:archify skill");
    expect(task).toContain("Make it a sequence diagram.");
    expect(task).toContain(`node ${SKILL}/bin/archify.mjs`);
    expect(task).toContain(`meta.output is .archify/${FOLDER}/<slug>.html`);
    expect(task).toContain(`--repo-root ${ROOT}`);
    expect(task).toContain("no cd, no shell variables, no &&, ; or pipes");
    expect(task).toContain("with the Write and Edit tools, never sed, python or a shell redirect");
    expect(task).toContain("browser-check skipped (viewer/chrome-unavailable)");
    expect(task).toContain("Do not open, preview or serve the HTML");
    expect(task).toContain("Skip the update notice");
    expect(task).toContain("no explainer page beside it");
    expect(task).toContain("never write an [archify explainer: …] line");
    expect(task).toContain("Leave the Architecture Diagnosis section out");
    expect(task).toContain("do not run the CLI's start, code-analysis or pr commands unless the user's note asks for one");
    expect(task).toContain(`Write only inside .archify/${FOLDER}/`);
    expect(task).toContain("draw the repository's architecture");
  });

  test("a checkout with no origin remote draws without checked sources and never asks for a remote", () => {
    const task = archifyTask({ skillDir: SKILL, root: ROOT, folder: FOLDER, origin: false, type: "architecture" });
    expect(task).not.toContain(`--repo-root ${ROOT}`);
    expect(task).toContain("has no origin remote");
    expect(task).toContain("leave meta.repository and every sources entry out");
    expect(task).toContain("Do not add a remote, and do not ask about it.");
    expect(archifyTask({ skillDir: SKILL, root: ROOT, folder: FOLDER, origin: false, revise: "shop.html" })).toContain("finalize without --repo-root");
  });

  test("auto lets the run choose, and an explainer answers as a page", () => {
    expect(archifyTask({ skillDir: SKILL, root: ROOT, folder: FOLDER, origin: true, type: "auto" })).toContain("Choose the diagram type with the skill's Type router.");
    const page = archifyTask({ skillDir: SKILL, root: ROOT, folder: FOLDER, origin: true, type: "explainer" });
    expect(page).toContain("Answer as one page");
    expect(page).not.toContain("Type router");
  });

  test("a revise edits the folder's candidate and follows the review-<n> rule", () => {
    const task = archifyTask({ skillDir: SKILL, root: ROOT, folder: FOLDER, origin: true, revise: "shop.html" });
    expect(task).toContain(`revise the Archify diagram in .archify/${FOLDER}/ (its page is shop.html)`);
    expect(task).toContain(`--out-dir .archify/${FOLDER}/review-<n>`);
    expect(task).not.toContain("meta.output is");
    expect(task).toContain(`Write only inside .archify/${FOLDER}/`);
  });

  test("its spec is a read-mostly ask; a revise needs its note", () => {
    const draw = archifySpec({ skillDir: SKILL, root: ROOT, folder: FOLDER, origin: true, type: "auto" });
    expect(draw).toMatchObject({ mode: "ask", verb: "diagram", noteRequired: false, expectsChange: false, progress: "drawing" });
    expect(draw.task).toBe(archifyTask({ skillDir: SKILL, root: ROOT, folder: FOLDER, origin: true, type: "auto" }));
    const revise = archifySpec({ skillDir: SKILL, root: ROOT, folder: FOLDER, origin: true, revise: "shop.html" });
    expect(revise).toMatchObject({ verb: "revise", noteRequired: true, label: "revise the diagram" });
  });
});

describe("the words", () => {
  const diagram = (builtAt: number): ArchifyDiagram => ({ id: FOLDER, file: "shop.html", title: "Shop", type: "architecture", bytes: 1, builtAt, checks: "pass" });
  const ago = (ms: number) => `${ms}ms ago`;

  test("the line counts the diagrams and dates the newest", () => {
    expect(archifyLine({ diagrams: [] }, ago)).toBe("no diagrams yet");
    expect(archifyLine({ diagrams: [diagram(5)] }, ago)).toBe("1 diagram, built 5ms ago");
    expect(archifyLine({ diagrams: [diagram(9), diagram(5)] }, ago)).toBe("2 diagrams; the newest built 9ms ago");
  });

  test("the head says drawing while a run goes, else the count", () => {
    expect(archifyHead(null)).toBe("");
    expect(archifyHead({ diagrams: [], run: null })).toBe("");
    expect(archifyHead({ diagrams: [diagram(1)], run: "r1" })).toBe("drawing");
    expect(archifyHead({ diagrams: [diagram(1), diagram(2)], run: null })).toBe("2 diagrams");
  });

  test("a verdict in a few words", () => {
    expect(checksWord("pass")).toBe("checked");
    expect(checksWord("browser-skipped")).toBe("checked, no browser check");
    expect(checksWord("fail")).toBe("a check failed");
    expect(checksWord(null)).toBe("not checked");
  });
});
