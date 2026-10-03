import { describe, expect, test } from "bun:test";

const compose = Bun.YAML.parse(await Bun.file(new URL("../../docker-compose.yml", import.meta.url)).text()) as {
  services: Record<string, { environment?: string[] | Record<string, string>; volumes?: string[]; network_mode?: string; pid?: string; networks?: unknown; depends_on?: unknown }>;
  networks?: Record<string, { enable_ipv6?: boolean; driver_opts?: Record<string, string>; ipam?: { config?: { subnet?: string }[] } }>;
};
const envOf = (s: { environment?: string[] | Record<string, string> }): string[] =>
  Array.isArray(s.environment) ? s.environment : Object.entries(s.environment ?? {}).map(([k, v]) => `${k}=${v}`);

describe("the stages service", () => {
  const stages = compose.services["stages"];
  test("exists, shares no namespace with canopy or the shells", () => {
    expect(stages).toBeDefined();
    expect(stages?.network_mode).toBeUndefined();
    expect(stages?.pid).toBeUndefined();
  });
  test("inherits nothing: no env_file, no merge key, no extends", async () => {
    // read the raw text too: a YAML parser may resolve a merge key and hide where the env came from
    const raw = await Bun.file(new URL("../../docker-compose.yml", import.meta.url)).text();
    const start = raw.indexOf("\n  stages:\n");
    expect(start).toBeGreaterThan(-1);
    const rest = raw.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
    const block = next === -1 ? rest : rest.slice(0, next + 1);
    expect(block).not.toMatch(/<<:|env_file|extends:/);
    expect(stages).not.toHaveProperty("env_file");
    expect(stages).not.toHaveProperty("extends");
  });
  test("canopy starts only once the runner answers its healthcheck", () => {
    expect((stages as { healthcheck?: { test?: string[] } }).healthcheck?.test).toEqual(["CMD", "bun", "/app/stage-runner.js", "--health"]);
    expect((compose.services["canopy"]?.depends_on as Record<string, { condition?: string }>)?.["stages"]?.condition).toBe("service_healthy");
  });
  test("canopy still waits for the shells and restarts with them", () => {
    // canopy lives in the shells' network namespace and loses it when they restart
    expect((compose.services["canopy"]?.depends_on as Record<string, unknown>)?.["shells"]).toEqual({ condition: "service_healthy", restart: true });
  });
  test("holds no token, key or secret, and mounts no ssh, git config, .env or docker socket", () => {
    for (const e of envOf(stages ?? {})) expect(e.split("=")[0]).not.toMatch(/TOKEN|KEY|SECRET|PASSWORD/);
    for (const v of stages?.volumes ?? []) expect(v).not.toMatch(/\.ssh|\.config\/git|\.env|docker\.sock|canopy-config|\/\.claude[:/]|\/\.codex[:/]/);
  });
  test("mounts the seeds read-write, .shared read-only over them, and the socket", () => {
    const vols = stages?.volumes ?? [];
    expect(vols.some((v) => /_incubator:\$\{DEV_ROOT[^}]*\}\/_incubator$/.test(v) || v.endsWith("/_incubator"))).toBe(true);
    expect(vols.some((v) => v.includes("_incubator/.shared") && v.endsWith(":ro"))).toBe(true);
    expect(vols).toContain("stage-sock:/run/canopy-stage");
  });
  test("sits on its own network outside ufw's docker range and the tailchan rule", () => {
    const subnet = compose.networks?.["stages-net"]?.ipam?.config?.[0]?.subnet;
    expect(subnet).toBe("10.250.13.0/24");
  });
  test("its network has no IPv6, so the v4 subnet is the whole of its reach", () => {
    expect(compose.networks?.["stages-net"]?.enable_ipv6).toBe(false);
  });
  test("its bridge has the name the fence matches, short enough to be an interface name", async () => {
    const script = await Bun.file(new URL("../../scripts/stages-fence.sh", import.meta.url)).text();
    const fenced = /^BRIDGE=(\S+)$/m.exec(script)?.[1];
    const name = compose.networks?.["stages-net"]?.driver_opts?.["com.docker.network.bridge.name"];
    expect(fenced).toBe("br-canopy-stg");
    expect(name).toBe(fenced);
    // IFNAMSIZ is 16 with the NUL: a longer name fails the bridge and the -i match both
    expect((name ?? "").length).toBeLessThanOrEqual(15);
  });
  test("resolves through public servers, since docker forwards queries from the fenced bridge", () => {
    expect((stages as { dns?: string[] }).dns).toEqual(["1.1.1.1", "9.9.9.9"]);
  });
  test("canopy reaches it only through the socket", () => {
    const canopy = compose.services["canopy"];
    expect(envOf(canopy ?? {})).toContain("CANOPY_STAGE_SOCKET=/run/canopy-stage/runner.sock");
    expect(canopy?.volumes ?? []).toContain("stage-sock:/run/canopy-stage");
    expect(compose.services["shells"]?.volumes ?? []).not.toContain("stage-sock:/run/canopy-stage");
  });
});
