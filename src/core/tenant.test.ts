import { describe, expect, test } from "bun:test";
import { composeEnv, composeProject, envRefusal, firstCodeIn, freePort, inTenantRange, isTenantEntry, launchdPlist, launchLabel, parseTenant, registryRefusal, TENANT_PORTS, tenantNameRefusal, tenantOrigins, withoutTenant, withTenant } from "./tenant";

describe("a tenant's name", () => {
  test("is a short lowercase word a label, a project and an id can carry", () => {
    expect(tenantNameRefusal("acme", [])).toBeNull();
    expect(tenantNameRefusal("team-2", [])).toBeNull();
    for (const bad of ["A", "a", "Acme", "2team", "acme_co", "acme co", "-acme", "acme-", "a".repeat(25), "acme/../x"]) {
      expect(tenantNameRefusal(bad, [])).not.toBeNull();
    }
  });

  test("is not a backend the registry already names", () => {
    expect(tenantNameRefusal("mini", ["mac", "mini"])).toContain("already names a backend");
    expect(tenantNameRefusal("home", [])).toContain("already names a backend");
  });

  test("makes its launchd label and compose project", () => {
    expect(launchLabel("acme")).toBe("canopy.tenant.acme");
    expect(composeProject("acme")).toBe("canopy-t-acme");
  });
});

describe("a tenant's port", () => {
  test("is the first of the range nothing holds", () => {
    expect(freePort(new Set())).toBe(TENANT_PORTS.first);
    expect(freePort(new Set([7880, 7881]))).toBe(7882);
    const all = new Set<number>();
    for (let p = TENANT_PORTS.first; p <= TENANT_PORTS.last; p++) all.add(p);
    expect(freePort(all)).toBeNull();
  });

  test("asked for by hand stays in the range, clear of canopy's own", () => {
    expect(inTenantRange(7885)).toBe(true);
    for (const p of [7850, 7855, 7859, 7865, 7871, 7900, 7880.5]) expect(inTenantRange(p)).toBe(false);
  });
});

describe("the launchd agent", () => {
  const plist = launchdPlist({
    name: "acme",
    bun: "/Users/x/.bun/bin/bun",
    entry: "/repo/bin/canopy.ts",
    root: "/Users/x/clients/acme & co",
    port: 7880,
    configDir: "/Users/x/.config/canopy/tenants/acme/config",
    home: "/Users/x/.config/canopy/tenants/acme/home",
    origins: ["http://127.0.0.1:7850", "http://localhost:7850"],
    log: "/Users/x/.config/canopy/tenants/acme/server.log",
    path: "/usr/bin:/bin",
  });

  test("runs canopy straight on its own port, config and home, enforcing who calls", () => {
    expect(plist).toContain("<string>canopy.tenant.acme</string>");
    expect(plist).toContain("<string>/repo/bin/canopy.ts</string>");
    expect(plist).toContain("<string>7880</string>");
    expect(plist).toContain("<key>CANOPY_CALLERS</key><string>enforce</string>");
    expect(plist).toContain("<key>CANOPY_CONFIG_DIR</key><string>/Users/x/.config/canopy/tenants/acme/config</string>");
    expect(plist).toContain("<key>HOME</key><string>/Users/x/.config/canopy/tenants/acme/home</string>");
    expect(plist).toContain("<key>CANOPY_ORIGINS</key><string>http://127.0.0.1:7850,http://localhost:7850</string>");
    // none of the owner's desktop, and not Homebrew's keychain helper for git
    expect(plist).toContain("<key>CANOPY_NO_DESKTOP</key><string>1</string>");
    expect(plist).toContain("<key>GIT_CONFIG_NOSYSTEM</key><string>1</string>");
    // never the owner's launcher, which loads the owner's keys
    expect(plist).not.toContain("mac-server.sh");
  });

  test("escapes what XML would read as markup", () => {
    expect(plist).toContain("<string>/Users/x/clients/acme &amp; co</string>");
  });
});

describe("the compose project", () => {
  test("its .env names the folder, the port, the bind, the home and the origins", () => {
    expect(composeEnv({ root: "/home/eric/clients/acme", port: 7881, listen: "100.68.139.95", home: "/home/eric/.local/share/canopy-tenants/acme/home", origins: ["https://canopy.beric.ca"] })).toBe(
      [
        "TENANT_ROOT=/home/eric/clients/acme",
        "TENANT_PORT=7881",
        "TENANT_LISTEN=100.68.139.95",
        "TENANT_HOME=/home/eric/.local/share/canopy-tenants/acme/home",
        "TENANT_ORIGINS=https://canopy.beric.ca",
        "",
      ].join("\n"),
    );
  });

  test("a value compose would expand or split is refused", () => {
    expect(envRefusal("TENANT_ROOT", "/srv/acme")).toBeNull();
    for (const bad of ["/srv/$HOME", "/srv/a\nb", '/srv/"a"', "/srv/`x`"]) expect(envRefusal("TENANT_ROOT", bad)).not.toBeNull();
  });
});

describe("the origins it answers", () => {
  test("are exact origins, once each, in the order given", () => {
    expect(tenantOrigins(["http://127.0.0.1:7850/", "https://canopy.beric.ca", " https://canopy.beric.ca ", "not a url", "https://x.test/path"])).toEqual([
      "http://127.0.0.1:7850",
      "https://canopy.beric.ca",
    ]);
  });
});

describe("the registry", () => {
  const mac = { name: "mac", tailnet: "http://mac:7850" };
  test("takes the tenant in, replacing one of the same name", () => {
    const one = withTenant([mac], { name: "acme", tailnet: "http://127.0.0.1:7880" });
    expect(one).toEqual([mac, { name: "acme", tailnet: "http://127.0.0.1:7880" }]);
    expect(withTenant(one, { name: "acme", tailnet: "http://127.0.0.1:7881" })).toEqual([mac, { name: "acme", tailnet: "http://127.0.0.1:7881" }]);
  });

  test("lets it go", () => {
    expect(withoutTenant([mac, { name: "acme" }], "acme")).toEqual([mac]);
  });

  test("touches only a tenant's own entry, on a tenant port", () => {
    const acme = { name: "acme", tailnet: "https://mini.ts.net:7880" };
    expect(isTenantEntry(acme)).toBe(true);
    expect(isTenantEntry(mac)).toBe(false);
    expect(isTenantEntry({ name: "bare" })).toBe(false);
    expect(registryRefusal([mac, acme], { remove: "acme" })).toBeNull();
    expect(registryRefusal([mac, acme], { add: { name: "acme", url: "https://mini.ts.net:7881" } })).toBeNull();
    // gone already: nothing to refuse
    expect(registryRefusal([mac], { remove: "acme" })).toBeNull();
    // a slip of the name never drops or rewrites a backend of its own
    expect(registryRefusal([mac, acme], { remove: "mac" })).toContain("not a tenant");
    expect(registryRefusal([mac], { add: { name: "mac", url: "http://127.0.0.1:7880" } })).toContain("not a tenant");
    expect(registryRefusal([mac], { add: { name: "acme", url: "http://127.0.0.1:7850" } })).toContain("7880 to 7899");
  });
});

describe("what is kept and read back", () => {
  test("a tenant.json parses, and anything else does not", () => {
    const t = { name: "acme", root: "/srv/acme", port: 7880, host: "launchd", url: "http://127.0.0.1:7880", created: 1 };
    expect(parseTenant(t)).toEqual({ name: "acme", root: "/srv/acme", port: 7880, host: "launchd", url: "http://127.0.0.1:7880", created: 1 });
    expect(parseTenant({ ...t, host: "vm" })).toBeNull();
    expect(parseTenant({ ...t, port: "7880" })).toBeNull();
    expect(parseTenant(null)).toBeNull();
  });

  test("the first sign-in code is read off the tenant's log", () => {
    expect(firstCodeIn("canopy: first sign-in code ABCD-1234 (good until a page or the CLI signs in)\n")).toBe("ABCD-1234");
    expect(firstCodeIn("canopy: first sign-in code OLD-1 (good until)\ncanopy: first sign-in code NEW-2 (good until)\n")).toBe("NEW-2");
    expect(firstCodeIn("canopy on :7880\n")).toBeNull();
  });
});
