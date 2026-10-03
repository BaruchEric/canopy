/**
 * scripts/stages-fence.sh itself, run under sh against fixture files: the
 * rules it prints, the block --persist writes into ufw's after.rules, and
 * --apply's idempotence through a stand-in iptables. The script is tested
 * rather than a TS copy of its text, so the two cannot drift apart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../../scripts/stages-fence.sh", import.meta.url).pathname;
const NET = "10.250.13.0/24";
const RETURN = `-s ${NET} -m conntrack --ctstate ESTABLISHED,RELATED -j RETURN`;
const DROPS = ["10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "100.64.0.0/10", "169.254.0.0/16"].map(
  (d) => `-s ${NET} -d ${d} -j DROP`,
);

// what Ubuntu and Arch ship, cut down: ufw's own *filter table and COMMIT
const UFW_AFTER = `#
# rules.input-after
#
*filter
:ufw-after-input - [0:0]
:ufw-after-output - [0:0]
-A ufw-after-input -p udp --dport 137 -j ufw-skip-to-policy-input
# don't delete the 'COMMIT' line or these rules won't be processed
COMMIT
`;

const BLOCK = [
  "# canopy-stages begin",
  "*filter",
  ":DOCKER-USER - [0:0]",
  `-A DOCKER-USER ${RETURN}`,
  ...[...DROPS].reverse().map((r) => `-A DOCKER-USER ${r}`),
  "COMMIT",
  "# canopy-stages end",
  "",
].join("\n");

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stages-fence-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

function run(args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["sh", SCRIPT, ...args], {
    env: { PATH: process.env["PATH"] ?? "/usr/bin:/bin", CANOPY_FENCE_AFTER_RULES: join(dir, "after.rules"), ...env },
  });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}

describe("stages-fence.sh", () => {
  test("with no arguments it prints the rules in insert order and touches nothing", () => {
    const r = run([]);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([...DROPS, RETURN].map((x) => `-I DOCKER-USER ${x}`));
    expect(existsSync(join(dir, "after.rules"))).toBe(false);
  });

  test("refuses a word it does not know", () => {
    expect(run(["--aply"]).code).not.toBe(0);
  });

  describe("--persist", () => {
    test("appends the block after ufw's own table, the -A rules in reverse so the RETURN comes first", () => {
      writeFileSync(join(dir, "after.rules"), UFW_AFTER);
      const r = run(["--persist"]);
      expect(r.code).toBe(0);
      expect(readFileSync(join(dir, "after.rules"), "utf8")).toBe(`${UFW_AFTER}\n${BLOCK}`);
    });

    test("a rerun leaves the file byte for byte as it was", () => {
      writeFileSync(join(dir, "after.rules"), UFW_AFTER);
      run(["--persist"]);
      const once = readFileSync(join(dir, "after.rules"), "utf8");
      expect(run(["--persist"]).code).toBe(0);
      expect(readFileSync(join(dir, "after.rules"), "utf8")).toBe(once);
    });

    test("replaces an older block in place and keeps what comes after it", () => {
      const old = "# canopy-stages begin\n*filter\n:DOCKER-USER - [0:0]\n-A DOCKER-USER -s 10.9.9.0/24 -j DROP\nCOMMIT\n# canopy-stages end\n";
      writeFileSync(join(dir, "after.rules"), `${UFW_AFTER}${old}# a line of the admin's own\n`);
      expect(run(["--persist"]).code).toBe(0);
      expect(readFileSync(join(dir, "after.rules"), "utf8")).toBe(`${UFW_AFTER}${BLOCK}# a line of the admin's own\n`);
    });

    test("keeps a backup of the file it replaced, and leaves no temp file behind", () => {
      writeFileSync(join(dir, "after.rules"), UFW_AFTER);
      run(["--persist"]);
      expect(readFileSync(join(dir, "after.rules.canopy-stages.bak"), "utf8")).toBe(UFW_AFTER);
      expect(readdirSync(dir).sort()).toEqual(["after.rules", "after.rules.canopy-stages.bak"]);
    });

    test("a begin marker with no end refuses and changes nothing", () => {
      const broken = `${UFW_AFTER}# canopy-stages begin\n*filter\nCOMMIT\n# ufw's own lines that follow\n`;
      writeFileSync(join(dir, "after.rules"), broken);
      const r = run(["--persist"]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("canopy-stages");
      expect(readFileSync(join(dir, "after.rules"), "utf8")).toBe(broken);
      expect(readdirSync(dir)).toEqual(["after.rules"]);
    });

    test("two blocks, or an end before its begin, refuse too", () => {
      for (const text of [
        `${UFW_AFTER}${BLOCK}${BLOCK}`,
        `${UFW_AFTER}# canopy-stages end\n# canopy-stages begin\n`,
      ]) {
        writeFileSync(join(dir, "after.rules"), text);
        expect(run(["--persist"]).code).not.toBe(0);
        expect(readFileSync(join(dir, "after.rules"), "utf8")).toBe(text);
      }
    });

    test("refuses when there is no after.rules to write into", () => {
      expect(run(["--persist"]).code).not.toBe(0);
      expect(existsSync(join(dir, "after.rules"))).toBe(false);
    });
  });

  describe("--apply", () => {
    // a stand-in iptables over one chain kept as lines in a file, top first
    function fakeIptables(): { env: Record<string, string>; chain: () => string[]; calls: () => string[] } {
      const state = join(dir, "chain");
      const log = join(dir, "calls");
      writeFileSync(state, "");
      writeFileSync(log, "");
      const bin = join(dir, "iptables");
      writeFileSync(
        bin,
        `#!/bin/sh
op=$1; shift; chain=$1; shift; rule="$*"
echo "$op $rule" >> "${log}"
[ "$chain" = DOCKER-USER ] || exit 2
case $op in
  -C) grep -qxF -- "$rule" "${state}" ;;
  -I) { printf '%s\\n' "$rule"; cat "${state}"; } > "${state}.new" && mv "${state}.new" "${state}" ;;
  -D) awk -v r="$rule" '!done && $0 == r { done = 1; next } { print }' "${state}" > "${state}.new" && mv "${state}.new" "${state}" ;;
  *) exit 2 ;;
esac
`,
      );
      chmodSync(bin, 0o755);
      const lines = (f: string) => readFileSync(f, "utf8").split("\n").filter(Boolean);
      return { env: { CANOPY_FENCE_IPTABLES: bin }, chain: () => lines(state), calls: () => lines(log) };
    }

    test("inserts every rule, the RETURN ending up first", () => {
      const ipt = fakeIptables();
      expect(run(["--apply"], ipt.env).code).toBe(0);
      expect(ipt.chain()).toEqual([RETURN, ...[...DROPS].reverse()]);
    });

    test("a second run only checks", () => {
      const ipt = fakeIptables();
      run(["--apply"], ipt.env);
      const before = ipt.calls().length;
      expect(run(["--apply"], ipt.env).code).toBe(0);
      expect(ipt.calls().slice(before).every((c) => c.startsWith("-C "))).toBe(true);
      expect(ipt.chain()).toEqual([RETURN, ...[...DROPS].reverse()]);
    });

    test("a missing drop goes back in, and the RETURN is moved back above it", () => {
      const ipt = fakeIptables();
      run(["--apply"], ipt.env);
      writeFileSync(join(dir, "chain"), ipt.chain().filter((r) => !r.includes("172.16.0.0/12")).join("\n") + "\n");
      expect(run(["--apply"], ipt.env).code).toBe(0);
      const chain = ipt.chain();
      expect(chain[0]).toBe(RETURN);
      expect(chain.slice().sort()).toEqual([RETURN, ...DROPS].sort());
    });

    test("an iptables that fails stops the script with its status", () => {
      const ipt = fakeIptables();
      writeFileSync(ipt.env["CANOPY_FENCE_IPTABLES"] ?? "", "#!/bin/sh\nexit 3\n");
      expect(run(["--apply"], ipt.env).code).not.toBe(0);
    });
  });
});
