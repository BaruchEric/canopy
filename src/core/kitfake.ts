/** A stand-in for the claude CLI, for tests only: it appends its argv to
 *  $FAKE_CLAUDE_LOG as one JSON line and edits $HOME/.claude.json the way
 *  `claude mcp add-json --scope user` and `remove --scope user` do,
 *  refusing an add over an existing name with claude's own words.
 *  FAKE_CLAUDE_FAIL=add-once makes the first add fail with an error that
 *  echoes its JSON, as a CLI might; a marker file beside the script makes
 *  every later add (a rollback's re-add) go through. FAKE_CLAUDE_FAIL=add
 *  makes every add fail that way, the rollback's included. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

const script = (marker: string): string => `#!/usr/bin/env bun
const fs = require("node:fs");
const args = process.argv.slice(2);
if (process.env.FAKE_CLAUDE_LOG) fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + "\\n");
const file = process.env.HOME + "/.claude.json";
const j = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
j.mcpServers ??= {};
const at = args.indexOf("--scope");
if (args[0] !== "mcp" || at < 0 || args[at + 1] !== "user") { console.error("usage"); process.exit(2); }
const rest = args.filter((_, i) => i > 1 && i !== at && i !== at + 1);
if (args[1] === "add-json") {
  const fail = process.env.FAKE_CLAUDE_FAIL;
  if (fail === "add" || (fail === "add-once" && !fs.existsSync(${JSON.stringify(marker)}))) {
    fs.writeFileSync(${JSON.stringify(marker)}, "");
    console.error("Invalid configuration: " + rest[1]);
    process.exit(1);
  }
  if (j.mcpServers[rest[0]]) { console.error("MCP server " + rest[0] + " already exists in user config"); process.exit(1); }
  j.mcpServers[rest[0]] = JSON.parse(rest[1]);
} else if (args[1] === "remove") {
  if (!j.mcpServers[rest[0]]) { console.error("No user-scoped MCP server found with name: " + rest[0]); process.exit(1); }
  delete j.mcpServers[rest[0]];
} else { console.error("usage"); process.exit(2); }
fs.writeFileSync(file, JSON.stringify(j, null, 2));
`;

export function fakeClaude(dir: string): string {
  const path = join(dir, "fake-claude");
  writeFileSync(path, script(join(dir, "fake-claude-failed")), { mode: 0o755 });
  return path;
}
