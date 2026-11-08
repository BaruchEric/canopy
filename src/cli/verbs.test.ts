import { expect, test } from "bun:test";
import { verbHelp } from "../core/help";
import { COMMANDS } from "./index";

/** the words that ask for the help or the version rather than name a command */
const META = new Set(["help", "--help", "-h", "--version", "-V"]);

test("every command the CLI takes has its lines in the help, so --help after it never falls back to the whole text", () => {
  expect([...COMMANDS].filter((c) => !META.has(c) && verbHelp(c) === undefined)).toEqual([]);
});
