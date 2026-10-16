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
  test("the runner's fence probe target comes from .env, with no default in the file", () => {
    expect(envOf(stages ?? {})).toContain("CANOPY_FENCE_PROBE=${CANOPY_FENCE_PROBE:-}");
  });
  test("canopy reaches it only through the socket", () => {
    const canopy = compose.services["canopy"];
    expect(envOf(canopy ?? {})).toContain("CANOPY_STAGE_SOCKET=/run/canopy-stage/runner.sock");
    expect(canopy?.volumes ?? []).toContain("stage-sock:/run/canopy-stage");
    expect(compose.services["shells"]?.volumes ?? []).not.toContain("stage-sock:/run/canopy-stage");
  });
});

describe("the stages image", () => {
  const docker = async (): Promise<string> => {
    const text = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text();
    const start = text.indexOf("FROM shells AS stages");
    return text.slice(start, text.indexOf("\nFROM ", start + 1));
  };

  test("puts only root-owned folders on the PATH, with claude and codex moved out of the runner's home", async () => {
    const stages = await docker();
    expect(stages).toContain("ENV PATH=/opt/stage-tools/bin:/usr/local/bin:/usr/bin:/bin\n");
    expect(stages).toContain("ENV DISABLE_AUTOUPDATER=1\n");
    expect(stages).toContain("chown -R root:root /opt/stage-tools");
    expect(stages).toContain("rm -f /etc/profile.d/canopy-path.sh");
    // nothing the runner runs is copied in as its own user's
    expect(stages).not.toMatch(/COPY[^\n]*--chown=bun/);
    expect(stages).toContain("chown -R root:root /app");
  });

  test("fails the build on a PATH folder, a stage tool or a runner file the runner's user can write", async () => {
    const stages = await docker();
    const checks = stages.slice(stages.indexOf("ENV PATH=/opt/stage-tools/bin"));
    // the checks run as the runner's user, after the PATH they check is set
    expect(stages.lastIndexOf("USER bun")).toBeLessThan(stages.indexOf(checks));
    expect(checks).toContain('if [ -w "$p" ]; then');
    expect(checks).toContain("find /opt/stage-tools /app -writable");
    expect(checks).toContain("! command -v gh && ! command -v vercel && ! command -v vc");
  });

  test("ends as root after the checks, with setpriv and the uids the runner drops to baked in", async () => {
    const stages = await docker();
    const checked = stages.indexOf("find /opt/stage-tools /app -writable");
    const users = [...stages.matchAll(/^USER (\w+)$/gm)];
    expect(users.at(-1)?.[1]).toBe("root");
    expect(users.at(-1)?.index ?? -1).toBeGreaterThan(checked);
    expect(users.at(-2)?.[1]).toBe("bun");
    expect(users.at(-2)?.index ?? Infinity).toBeLessThan(checked);
    expect(stages).toContain("ARG STAGECALLER_GID=7850");
    expect(stages).toContain("ENV CANOPY_STAGE_UID=${UID} CANOPY_STAGE_GID=${GID} CANOPY_STAGE_CALLER_GID=${STAGECALLER_GID}");
    expect(stages).toContain('test -x "$(command -v setpriv)"');
    expect(stages).toContain('chown "root:${STAGECALLER_GID}" /run/canopy-stage && chmod 0750 /run/canopy-stage');
  });
});

describe("the stages container is read-only", () => {
  const stages = compose.services["stages"] as { read_only?: boolean; tmpfs?: string[] };
  test("with a tmpfs home owned by the stage user and a tmpfs /tmp, nothing else writable but the mounts", () => {
    expect(stages.read_only).toBe(true);
    expect(stages.tmpfs).toEqual([
      "/home/bun:uid=${HOST_UID:-1000},gid=${HOST_GID:-1000},mode=0700,size=2g,exec",
      "/tmp:mode=1777,size=1g,exec",
    ]);
  });
  test("the root runner makes no transpiler cache in the stage user's home", async () => {
    const text = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text();
    const start = text.indexOf("FROM shells AS stages");
    const image = text.slice(start, text.indexOf("\nFROM ", start + 1));
    expect(image).toContain("ENV BUN_RUNTIME_TRANSPILER_CACHE_PATH=0");
  });
});

describe("the stage runner's socket", () => {
  const services = compose.services as Record<string, { group_add?: string[]; build?: { args?: Record<string, string> } }>;
  test("canopy holds the stagecaller group, and the stages image is built with the same gid", () => {
    expect(services["canopy"]?.group_add).toContain("${STAGECALLER_GID:-7850}");
    expect(services["stages"]?.build?.args?.["STAGECALLER_GID"]).toBe("${STAGECALLER_GID:-7850}");
  });
  test("neither the shells nor the stages hold it", () => {
    expect(services["shells"]?.group_add).toBeUndefined();
    expect(services["stages"]?.group_add).toBeUndefined();
  });
});

describe("the Firebase deploy's settings", () => {
  const names = (svc: string): string[] => envOf(compose.services[svc] ?? {}).map((e) => e.split("=")[0] ?? "");
  test("canopy holds the token, the location and the CLI's own PATH", () => {
    expect(names("canopy")).toEqual(expect.arrayContaining(["FIREBASE_TOKEN", "FIREBASE_LOCATION", "CANOPY_FIREBASE_PATH"]));
    expect(envOf(compose.services["canopy"] ?? {})).toContain("CANOPY_FIREBASE_PATH=/opt/firebase/bin:/usr/local/bin:/usr/bin:/bin");
  });
  test("neither the shells nor the stages do", () => {
    for (const svc of ["shells", "stages"]) for (const n of names(svc)) expect(n).not.toMatch(/FIREBASE/);
  });
  test("the CLI is an exact version installed from its own lockfile, which the build may not change", async () => {
    const pkg = (await Bun.file(new URL("../../docker/firebase/package.json", import.meta.url)).json()) as { dependencies?: Record<string, string> };
    expect(pkg.dependencies).toEqual({ "firebase-tools": "15.32.1" });
    const lock = await Bun.file(new URL("../../docker/firebase/bun.lock", import.meta.url)).text();
    expect(lock).toContain('"firebase-tools": ["firebase-tools@15.32.1"');
    const docker = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text();
    expect(docker).toContain("COPY docker/firebase/package.json docker/firebase/bun.lock /opt/firebase/");
    expect(docker).toContain("bun install --frozen-lockfile --production");
    expect(docker).not.toMatch(/bun add -g firebase-tools/);
  });
});

describe("the kit", () => {
  test("the canopy service, and only it, mounts the host's ~/.hermes under /home/bun", () => {
    const want = "${HOST_HOME:-/home/eric}/.hermes:/home/bun/.hermes";
    expect(compose.services["canopy"]!.volumes).toContain(want);
    expect(compose.services["shells"]!.volumes ?? []).not.toContain(want);
    expect(compose.services["stages"]!.volumes ?? []).not.toContain(want);
  });
});

describe("the secrets service", () => {
  const secrets = compose.services["secrets"];
  const canopy = compose.services["canopy"];
  /** a volume's host side, with ${HOST_HOME:-x} read as its default, so two
   *  HOST_HOME mounts compare by path and not by the text "${HOST_HOME" */
  const named = (v: string): string => v.replace(/\$\{HOST_HOME:-([^}]*)\}/g, "$1").split(":")[0] ?? v;
  const MCP_ENV = "${HOST_HOME:-/home/eric}/.claude/mcp-env";
  const HOST_CLAUDE = "${HOST_HOME:-/home/eric}/.claude:${HOST_HOME:-/home/eric}/.claude";

  test("exists in a network and process namespace of its own", () => {
    expect(secrets).toBeDefined();
    expect(secrets?.network_mode).toBeUndefined();
    expect(secrets?.pid).toBeUndefined();
  });
  test("inherits nothing: no env_file, no merge key, no extends", async () => {
    const raw = await Bun.file(new URL("../../docker-compose.yml", import.meta.url)).text();
    const start = raw.indexOf("\n  secrets:\n");
    expect(start).toBeGreaterThan(-1);
    const rest = raw.slice(start + 1);
    const next = rest.slice(1).search(/\n  [a-z][\w-]*:\n/);
    const block = next === -1 ? rest : rest.slice(0, next + 1);
    expect(block).not.toMatch(/<<:|env_file|extends:/);
    expect(secrets).not.toHaveProperty("env_file");
  });
  test("its env is its own settings and no token, key or password", () => {
    for (const e of envOf(secrets ?? {})) {
      const name = e.split("=")[0] ?? "";
      expect(name === "LANG" || name.startsWith("CANOPY_SECRETS_")).toBe(true);
      expect(name).not.toMatch(/TOKEN|KEY|PASSWORD|PASSPHRASE/);
    }
    expect(envOf(secrets ?? {})).toContain("CANOPY_SECRETS_CALLER_GID=${SECRETSCALLER_GID:-7851}");
  });
  test("mounts its data, the stacks, canopy's .env read-only and the socket, and nothing the shells mount", () => {
    const vols = secrets?.volumes ?? [];
    expect(vols).toContain("secrets-data:/data");
    expect(vols).toContain("/opt/stacks:/opt/stacks");
    expect(vols).toContain("./.env:/import/canopy.env:ro");
    expect(vols).toContain("secrets-sock:/run/canopy-secrets");
    const shells = (compose.services["shells"]?.volumes ?? []).map(named);
    for (const v of vols) expect(shells).not.toContain(named(v));
  });
  test("shares only the socket with canopy, and only canopy holds it", () => {
    const mine = (secrets?.volumes ?? []).map(named);
    expect((canopy?.volumes ?? []).filter((v) => mine.includes(named(v)))).toEqual(["secrets-sock:/run/canopy-secrets"]);
    for (const [name, s] of Object.entries(compose.services)) {
      if (name === "canopy" || name === "secrets") continue;
      expect((s.volumes ?? []).map(named)).not.toContain("secrets-sock");
      expect((s.volumes ?? []).map(named)).not.toContain("secrets-data");
    }
  });
  test("writes the MCP env files at their host path, a sink root, and nothing else of ~/.claude", () => {
    expect(secrets?.volumes).toContain(`${MCP_ENV}:${MCP_ENV}`);
    expect(envOf(secrets ?? {})).toContain(`CANOPY_SECRETS_SINK_ROOTS=/opt/stacks:${MCP_ENV}`);
    expect((secrets?.volumes ?? []).filter((v) => v.includes(".claude"))).toEqual([`${MCP_ENV}:${MCP_ENV}`]);
  });
  test("reads the restart key's folder and nothing else of the host's home config, read-only", () => {
    const restart = "${HOST_HOME:-/home/eric}/.config/canopy-restart:/restart:ro";
    expect(secrets?.volumes).toContain(restart);
    expect((secrets?.volumes ?? []).filter((v) => v.includes(".config") || v.includes(".ssh"))).toEqual([restart]);
    for (const name of ["canopy", "shells", "stages"]) expect(compose.services[name]?.volumes ?? []).not.toContain(restart);
  });
  test("canopy and the shells see ~/.claude at its host path too, so the wrapper's path runs in both", () => {
    for (const name of ["canopy", "shells"]) {
      const vols = compose.services[name]?.volumes ?? [];
      expect(vols).toContain("${HOST_HOME:-/home/eric}/.claude:/home/bun/.claude");
      expect(vols).toContain(HOST_CLAUDE);
      // the env files reach them only inside ~/.claude, never as a mount of their own
      expect(vols.map(named)).not.toContain(named(MCP_ENV));
    }
    expect(compose.services["stages"]?.volumes ?? []).not.toContain(HOST_CLAUDE);
    expect(envOf(canopy ?? {})).toContain("CANOPY_HOST_HOME=${HOST_HOME:-/home/eric}");
  });
  test("canopy holds the caller group and the socket path, and does not wait on the service's health", () => {
    expect((canopy as { group_add?: string[] }).group_add).toContain("${SECRETSCALLER_GID:-7851}");
    expect(envOf(canopy ?? {})).toContain("CANOPY_SECRETS_SOCKET=/run/canopy-secrets/secrets.sock");
    // the same origin as the service's, or every gated act answers 403
    const origin = envOf(secrets ?? {}).find((e) => e.startsWith("CANOPY_SECRETS_ORIGIN="));
    expect(origin).toBeTruthy();
    expect(envOf(canopy ?? {})).toContain(origin ?? "");
    expect((canopy?.depends_on as Record<string, { condition?: string }>)?.["secrets"]?.condition).toBe("service_started");
    for (const [name, s] of Object.entries(compose.services)) {
      if (name === "canopy") continue;
      expect(envOf(s).some((e) => e.startsWith("CANOPY_SECRETS_SOCKET="))).toBe(false);
    }
  });
  test("is read-only with a small tmpfs /tmp, and answers a healthcheck", () => {
    const s = secrets as { read_only?: boolean; tmpfs?: string[]; healthcheck?: { test?: string[] } };
    expect(s.read_only).toBe(true);
    expect(s.tmpfs).toEqual(["/tmp:mode=1777,size=64m"]);
    expect(s.healthcheck?.test).toEqual(["CMD", "bun", "/app/secrets-service.js", "--health"]);
  });
});

describe("the secrets image", () => {
  test("is plain bun with git and ssh, and carries only the service's bundle", async () => {
    const text = await Bun.file(new URL("../../Dockerfile", import.meta.url)).text();
    expect(text).toContain("RUN bun build src/secrets/main.ts --target=bun --outfile /app/dist/secrets-service.js");
    const start = text.indexOf("FROM oven/bun:1 AS secrets");
    expect(start).toBeGreaterThan(-1);
    const end = text.indexOf("\nFROM ", start + 1);
    const stage = end === -1 ? text.slice(start) : text.slice(start, end);
    expect(stage).toContain("git openssh-client ca-certificates");
    expect(stage.match(/^COPY .*$/gm)).toEqual(["COPY --from=build /app/dist/secrets-service.js /app/secrets-service.js"]);
    expect(stage).toContain('CMD ["bun", "/app/secrets-service.js"]');
    expect(stage).not.toMatch(/^USER /m);
  });
});
