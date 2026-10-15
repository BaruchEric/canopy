/** One good act of every kind and one way to break it, for the wire test
 *  and the service's walk over every gated act. Test data only. */

import { LIMITS, type ActKind, type SecretAct } from "./secretwire";

const R = "age1xtc4cftnu55fn3enurt9jexnrenmru3w0xl93uz5q20e34mefs6stg2vra";

/** one good act of every kind, and one way to break it */
export const SAMPLES: Record<ActKind, { good: SecretAct; bad: Record<string, unknown> }> = {
  reveal: { good: { a: "reveal", name: "cf_token" }, bad: { a: "reveal", name: "../x" } },
  add: { good: { a: "add", name: "cf_token", value: "v", description: "d", tags: ["dns"] }, bad: { a: "add", name: "cf_token", value: "", description: "d", tags: [] } },
  edit: { good: { a: "edit", name: "cf_token", description: "d", tags: [] }, bad: { a: "edit", name: "cf_token", description: "d", tags: ["Not A Tag"] } },
  rotate: { good: { a: "rotate", name: "cf_token", value: "v2" }, bad: { a: "rotate", name: "cf_token", value: "x".repeat(LIMITS.value + 1) } },
  delete: { good: { a: "delete", name: "cf_token" }, bad: { a: "delete" } },
  allow: { good: { a: "allow", name: "cf_token", allow: ["sink:dns"] }, bad: { a: "allow", name: "cf_token", allow: ["*"] } },
  "sink-set": {
    good: { a: "sink-set", id: "dns", machine: "mini", path: "/opt/stacks/dns/.env", format: "dotenv", keys: { CF_TOKEN: "cf_token" } },
    bad: { a: "sink-set", id: "dns", machine: "mini", path: "relative/.env", format: "dotenv", keys: {} },
  },
  "sink-remove": { good: { a: "sink-remove", id: "dns" }, bad: { a: "sink-remove", id: "DNS" } },
  "sink-write": { good: { a: "sink-write", id: "dns", key: "CF_TOKEN" }, bad: { a: "sink-write", id: "dns" } },
  take: { good: { a: "take", id: "dns", key: "CF_TOKEN" }, bad: { a: "take", id: "dns", key: 5 } },
  "import-scan": { good: { a: "import-scan" }, bad: { a: "import-scans" } },
  approve: {
    good: { a: "approve", proposal: "p1", name: "cf_token", description: "", tags: [], value: null, sink: null },
    bad: { a: "approve", proposal: "p1", name: "cf_token", description: "", tags: [], value: null, sink: { id: "Bad Id" } },
  },
  reject: { good: { a: "reject", proposal: "p1" }, bad: { a: "reject", proposal: "" } },
  "machine-key": { good: { a: "machine-key", machine: "mac", recipient: R }, bad: { a: "machine-key", machine: "mini", recipient: R } },
  "mcp-allow": {
    good: {
      a: "mcp-allow", server: "github", hash: "a".repeat(64),
      def: { command: "bunx", args: ["-y", "@modelcontextprotocol/server-github"], url: null, env: ["GITHUB_PERSONAL_ACCESS_TOKEN"], headers: [] },
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "gh_token" }, headers: {}, homes: { mac: "/Users/ericbaruch", mini: "/home/eric" },
    },
    bad: { a: "mcp-allow", server: "github", hash: "a".repeat(64), def: { command: "bunx", args: [], url: null, env: [], headers: [] }, env: { NOT_IN_DEF: "gh_token" }, headers: {}, homes: { mini: "/home/eric" } },
  },
  "mcp-revoke": { good: { a: "mcp-revoke", server: "github" }, bad: { a: "mcp-revoke", server: "Git Hub" } },
  "passkey-remove": { good: { a: "passkey-remove", id: "abc" }, bad: { a: "passkey-remove", id: "" } },
  "passkey-label": { good: { a: "passkey-label", id: "abc", label: "roboform" }, bad: { a: "passkey-label", id: "abc", label: "  " } },
};
