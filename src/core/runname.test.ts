import { describe, expect, test } from "bun:test";
import { cleanName, nameFailure, nameFromModel, nameFromWords, namePrompt, NAME_TEXT_MAX, RUN_NAME_MAX, runSubject, runTitle, uniqueName } from "./runname";

describe("nameFromWords", () => {
  test("keeps the first words of the first line, lower case at the front", () => {
    expect(nameFromWords("Fix the phone top bar overflow on small screens\nmore below")).toBe("fix the phone top bar overflow");
    expect(nameFromWords("why is the build slow?")).toBe("why is the build slow");
  });

  test("drops an opener that says nothing about the task", () => {
    expect(nameFromWords("please can you rename the store helper")).toBe("rename the store helper");
    expect(nameFromWords("Hey, I want you to add a dark theme")).toBe("add a dark theme");
    expect(nameFromWords("ok so let's ship it")).toBe("ship it");
  });

  test("stops at the first sentence and never ends on a joining word", () => {
    expect(nameFromWords("Add retries. Then write the docs for it")).toBe("add retries");
    expect(nameFromWords("look at the flaky test and the one in peers")).toBe("look at the flaky test");
    expect(nameFromWords("Please tell me in one short sentence what the README says")).toBe("tell me in one short sentence");
    expect(nameFromWords("runner.ts: it throws on a second start")).toBe("runner.ts");
  });

  test("keeps a path's last part, a number that starts the line, and drops links", () => {
    expect(nameFromWords("fix /Users/me/dev/canopy/src/core/runner.ts start")).toBe("fix runner.ts start");
    expect(nameFromWords("read src/store.ts and/or the tests")).toBe("read store.ts and/or the tests");
    expect(nameFromWords("3 tests fail on linux")).toBe("3 tests fail on linux");
    expect(nameFromWords("see https://example.com/a/b for the bug in login")).toBe("see for the bug in login");
  });

  test("skips list marks, headings and fenced code to reach the words", () => {
    expect(nameFromWords("## Goal\n- make the pill smaller")).toBe("goal");
    expect(nameFromWords("```\nconst a = 1\n```\n1. Tidy the imports")).toBe("tidy the imports");
    expect(nameFromWords("- [ ] check the deploy")).toBe("check the deploy");
  });

  test("leaves an acronym or a cased name at the front as written", () => {
    expect(nameFromWords("API keys rotate too often")).toBe("API keys rotate too often");
    expect(nameFromWords("TopBar loses its second row")).toBe("TopBar loses its second row");
  });

  test("has nothing to say for text without words", () => {
    expect(nameFromWords("")).toBe("");
    expect(nameFromWords("   \n ... \n")).toBe("");
  });

  test("never passes the longest name", () => {
    const long = nameFromWords(`${"supercalifragilistic".repeat(2)} ${"antidisestablishment".repeat(2)} word`);
    expect(long.length).toBeLessThanOrEqual(RUN_NAME_MAX);
    expect(nameFromWords("x".repeat(200)).length).toBe(RUN_NAME_MAX);
  });
});

describe("cleanName", () => {
  test("is one line with single spaces and nothing around it", () => {
    expect(cleanName('  "top   bar fix."  ')).toBe("top bar fix");
    expect(cleanName("**landing queue**\nsecond line")).toBe("landing queue");
    expect(cleanName("`peer sync`")).toBe("peer sync");
    expect(cleanName(" \n ")).toBe("");
  });

  test("cuts at a word once it is too long", () => {
    const name = cleanName("word ".repeat(40));
    expect(name.length).toBeLessThanOrEqual(RUN_NAME_MAX);
    expect(name.endsWith("word")).toBe(true);
  });
});

describe("uniqueName", () => {
  test("numbers a name another run holds, whatever its case", () => {
    expect(uniqueName("fix top bar", [])).toBe("fix top bar");
    expect(uniqueName("fix top bar", ["Fix Top Bar"])).toBe("fix top bar 2");
    expect(uniqueName("fix top bar", ["fix top bar", "fix top bar 2"])).toBe("fix top bar 3");
  });

  test("makes room for the number in a name at full length", () => {
    const full = "a".repeat(RUN_NAME_MAX);
    expect(uniqueName(full, [full]).length).toBeLessThanOrEqual(RUN_NAME_MAX);
  });
});

describe("nameFromModel", () => {
  test("takes a short answer, less its label, quotes and full stop", () => {
    expect(nameFromModel("fix phone top bar overflow\n")).toBe("fix phone top bar overflow");
    expect(nameFromModel('Name: "Landing queue retries."')).toBe("landing queue retries");
  });

  test("refuses a paragraph, an apology and nothing", () => {
    expect(nameFromModel("This task is about fixing the top bar on a phone so it fits")).toBeNull();
    expect(nameFromModel("I cannot name this")).toBeNull();
    expect(nameFromModel("Sorry, no task given")).toBeNull();
    expect(nameFromModel("  ")).toBeNull();
  });
});

test("the namer's prompt carries the task, cut to what it is shown", () => {
  const prompt = namePrompt(`  ${"a".repeat(NAME_TEXT_MAX + 50)}  `);
  expect(prompt).toContain("Task:\n");
  expect(prompt.split("Task:\n")[1]?.length).toBe(NAME_TEXT_MAX);
});

test("a run goes by its name, else its note's first line, else its verb", () => {
  expect(runTitle({ name: "peer sync", note: "look at peers", verb: "ask" })).toBe("peer sync");
  expect(runTitle({ note: "look at peers\nand more", verb: "ask" })).toBe("look at peers");
  expect(runTitle({ note: "", verb: "chat" })).toBe("chat");
  expect(runSubject({ name: "peer sync", note: "x" })).toBe("peer sync");
  expect(runSubject({ note: "" })).toBe("");
});

test("an older backend's bare 404 on a rename says what it means; any other message stays", () => {
  expect(nameFailure("not found")).toBe("this backend runs a canopy from before run names; deploy the current one to it and try again");
  expect(nameFailure("unknown run: ab12cd34")).toBe("unknown run: ab12cd34");
  expect(nameFailure("the run has ended")).toBe("the run has ended");
});
