/**
 * scripts/stages-fence.sh itself, run under sh: the rules it prints,
 * --apply's idempotence through a stand-in iptables and ip6tables, and what
 * --install writes under a fixture root. The script is tested rather than a
 * TS copy of it, so the two cannot drift apart.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = new URL("../../scripts/stages-fence.sh", import.meta.url).pathname;
const BRIDGE = "br-canopy-stg";
const RANGES = [
  "10.0.0.0/8",
  "172.16.0.0/12",
  "192.168.0.0/16",
  "100.64.0.0/10",
  "169.254.0.0/16",
  "224.0.0.0/4",
  "255.255.255.255/32",
  "0.0.0.0/8",
];
const V4 = RANGES.map((d) => `-i ${BRIDGE} -d ${d} -j DROP`);
const V6 = [`-i ${BRIDGE} -j DROP`];
const SBIN = "usr/local/sbin/canopy-stages-fence";
const UNIT = "etc/systemd/system/canopy-stages-fence.service";

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "stages-fence-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const BASE_PATH = "/usr/bin:/bin";
function run(script: string, args: string[], env: Record<string, string> = {}) {
  const p = Bun.spawnSync(["sh", script, ...args], { env: { PATH: BASE_PATH, ...env } });
  return { code: p.exitCode, out: p.stdout.toString(), err: p.stderr.toString() };
}
const lines = (f: string) => (existsSync(f) ? readFileSync(f, "utf8").split("\n").filter(Boolean) : []);

// a stand-in for iptables or ip6tables over the raw table's PREROUTING,
// kept as lines in a file, top first; every call is logged
function fake(name: string, at = dir): { bin: string; chain: () => string[]; calls: () => string[] } {
  const state = join(at, `${name}.chain`);
  const log = join(at, `${name}.calls`);
  writeFileSync(state, "");
  const bin = join(at, name);
  writeFileSync(
    bin,
    `#!/bin/sh
echo "$*" >> "${log}"
[ "$1" = -t ] && [ "$2" = raw ] || exit 2
op=$3; chain=$4; shift 4; rule="$*"
[ "$chain" = PREROUTING ] || exit 2
case $op in
  -C) grep -qxF -- "$rule" "${state}" ;;
  -I) { printf '%s\\n' "$rule"; cat "${state}"; } > "${state}.new" && mv "${state}.new" "${state}" ;;
  *) exit 2 ;;
esac
`,
  );
  chmodSync(bin, 0o755);
  return { bin, chain: () => lines(state), calls: () => lines(log) };
}

describe("stages-fence.sh", () => {
  test("with no arguments it prints the rules and runs nothing", () => {
    const v4 = fake("ipt");
    const r = run(SCRIPT, [], { CANOPY_FENCE_IPTABLES: v4.bin });
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")).toEqual([
      ...V4.map((x) => `iptables -t raw -I PREROUTING ${x}`),
      ...V6.map((x) => `ip6tables -t raw -I PREROUTING ${x}`),
    ]);
    expect(v4.calls()).toEqual([]);
  });

  test("refuses a word it does not know", () => {
    expect(run(SCRIPT, ["--aply"]).code).toBe(2);
  });

  test("the comment owns up to dropping traffic between containers on the bridge", () => {
    expect(readFileSync(SCRIPT, "utf8")).toMatch(/container-to-container/i);
  });

  describe("--apply", () => {
    function both() {
      const v4 = fake("ipt");
      const v6 = fake("ip6t");
      return { v4, v6, env: { CANOPY_FENCE_IPTABLES: v4.bin, CANOPY_FENCE_IP6TABLES: v6.bin } };
    }

    test("inserts every drop into raw PREROUTING, v4 and v6", () => {
      const f = both();
      expect(run(SCRIPT, ["--apply"], f.env).code).toBe(0);
      expect(f.v4.chain().slice().sort()).toEqual(V4.slice().sort());
      expect(f.v6.chain()).toEqual(V6);
    });

    test("a second run only checks", () => {
      const f = both();
      run(SCRIPT, ["--apply"], f.env);
      const n4 = f.v4.calls().length;
      const n6 = f.v6.calls().length;
      expect(run(SCRIPT, ["--apply"], f.env).code).toBe(0);
      for (const c of [...f.v4.calls().slice(n4), ...f.v6.calls().slice(n6)]) expect(c).toStartWith("-t raw -C PREROUTING ");
      expect(f.v4.chain()).toHaveLength(V4.length);
      expect(f.v6.chain()).toEqual(V6);
    });

    test("puts back only the rule that went missing", () => {
      const f = both();
      run(SCRIPT, ["--apply"], f.env);
      writeFileSync(join(dir, "ipt.chain"), f.v4.chain().filter((r) => !r.includes("224.0.0.0/4")).join("\n") + "\n");
      const n4 = f.v4.calls().length;
      expect(run(SCRIPT, ["--apply"], f.env).code).toBe(0);
      expect(f.v4.calls().slice(n4).filter((c) => c.includes(" -I "))).toEqual([
        `-t raw -I PREROUTING -i ${BRIDGE} -d 224.0.0.0/4 -j DROP`,
      ]);
      expect(f.v4.chain().slice().sort()).toEqual(V4.slice().sort());
    });

    test("an iptables that fails stops the script with its exit status", () => {
      const f = both();
      writeFileSync(f.v4.bin, "#!/bin/sh\nexit 3\n");
      expect(run(SCRIPT, ["--apply"], f.env).code).toBe(3);
      expect(f.v6.calls()).toEqual([]);
    });
  });

  describe("--install", () => {
    function install() {
      const root = join(dir, "root");
      mkdirSync(root);
      const sysctl = join(dir, "systemctl");
      writeFileSync(sysctl, `#!/bin/sh\necho "$*" >> "${join(dir, "systemctl.calls")}"\n`);
      chmodSync(sysctl, 0o755);
      const r = run(SCRIPT, ["--install"], { CANOPY_FENCE_ROOT: root, CANOPY_FENCE_SYSTEMCTL: sysctl });
      return { r, root, systemctl: () => lines(join(dir, "systemctl.calls")) };
    }

    test("writes the copy at 0755: the script with only the checkout switch turned off", () => {
      const { r, root } = install();
      expect(r.code).toBe(0);
      const copy = readFileSync(join(root, SBIN), "utf8");
      const own = readFileSync(SCRIPT, "utf8");
      expect(own.split("\n")).toContain("CHECKOUT=1");
      expect(copy).toBe(own.replace(/^CHECKOUT=1$/m, "CHECKOUT=0"));
      expect(statSync(join(root, SBIN)).mode & 0o777).toBe(0o755);
    });

    test("writes a oneshot unit that runs the copy's --apply before docker starts", () => {
      const { root } = install();
      expect(readFileSync(join(root, UNIT), "utf8")).toBe(`[Unit]
Description=Fence the canopy stages bridge (${BRIDGE}) in the raw table
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
ExecStart=/usr/local/sbin/canopy-stages-fence --apply

[Install]
WantedBy=multi-user.target
`);
    });

    test("reloads systemd, enables the unit and runs it now, again on a rerun", () => {
      const { systemctl } = install();
      expect(systemctl()).toEqual([
        "daemon-reload",
        "enable --now canopy-stages-fence.service",
        "restart canopy-stages-fence.service",
      ]);
    });

    test("a rerun writes the same files and leaves no temp file behind", () => {
      const { root } = install();
      const copy = readFileSync(join(root, SBIN), "utf8");
      const unit = readFileSync(join(root, UNIT), "utf8");
      const again = run(SCRIPT, ["--install"], { CANOPY_FENCE_ROOT: root, CANOPY_FENCE_SYSTEMCTL: join(dir, "systemctl") });
      expect(again.code).toBe(0);
      expect(readFileSync(join(root, SBIN), "utf8")).toBe(copy);
      expect(readFileSync(join(root, UNIT), "utf8")).toBe(unit);
      expect(Bun.spawnSync(["find", root, "-type", "f"]).stdout.toString().trim().split("\n").sort()).toEqual(
        [join(root, UNIT), join(root, SBIN)].sort(),
      );
    });

    test("the installed copy calls iptables and ip6tables by name and ignores every test switch", () => {
      const { root } = install();
      // named stand-ins first on PATH: what the copy should call
      const named = join(dir, "bin");
      mkdirSync(named);
      const v4 = fake("iptables", named);
      const v6 = fake("ip6tables", named);
      // and override stand-ins it must never call
      const o4 = fake("o4");
      const o6 = fake("o6");
      const r = run(join(root, SBIN), ["--apply"], {
        PATH: `${named}:${BASE_PATH}`,
        CANOPY_FENCE_IPTABLES: o4.bin,
        CANOPY_FENCE_IP6TABLES: o6.bin,
      });
      expect(r.code).toBe(0);
      expect(v4.chain()).toHaveLength(V4.length);
      expect(v6.chain()).toEqual(V6);
      expect(o4.calls()).toEqual([]);
      expect(o6.calls()).toEqual([]);
    });

    test.skipIf(process.getuid?.() === 0)("the installed copy ignores CANOPY_FENCE_ROOT: as a user, --install refuses before writing", () => {
      const { root } = install();
      const other = join(dir, "other");
      mkdirSync(other);
      const sysctl = fake("sysctl-o");
      const r = run(join(root, SBIN), ["--install"], { CANOPY_FENCE_ROOT: other, CANOPY_FENCE_SYSTEMCTL: sysctl.bin });
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("root");
      expect(Bun.spawnSync(["find", other, "-type", "f"]).stdout.toString().trim()).toBe("");
      expect(sysctl.calls()).toEqual([]);
    });

    test.skipIf(process.getuid?.() === 0)("from the checkout without a fixture root it needs root", () => {
      const r = run(SCRIPT, ["--install"]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("root");
    });
  });
});
