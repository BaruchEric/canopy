import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CLAUDE_SETTINGS_KEYS, claudeSettingsRefusal, CODEX_CONFIG_KEYS, codexConfigRefusal, stageSettingsRefusal } from "./settingscheck";

const scratch: string[] = [];
afterAll(async () => {
  for (const d of scratch) await rm(d, { recursive: true, force: true });
});

describe("a stage's claude settings", () => {
  const F = "/s/settings.json";
  test.each([
    "hooks",
    "env",
    "apiKeyHelper",
    "permissions",
    "statusLine",
    "enabledMcpjsonServers",
    "mcpServers",
    "awsAuthRefresh",
    "awsCredentialExport",
    "enabledPlugins",
    "outputStyle",
  ])("refuses %s, naming the file and the key", (key) => {
    expect(claudeSettingsRefusal(JSON.stringify({ model: "opus", [key]: {} }), F)).toBe(
      `${F} holds "${key}", which a stage's settings may not: remove it by hand (allowed: ${CLAUDE_SETTINGS_KEYS.join(", ")})`,
    );
  });

  test("takes the allowed keys, and an empty object", () => {
    expect(claudeSettingsRefusal(JSON.stringify({ $schema: "https://json.schemastore.org/claude-code-settings.json", model: "opus", theme: "dark" }), F)).toBe(null);
    expect(claudeSettingsRefusal("{}", F)).toBe(null);
  });

  test("refuses what is not one JSON object", () => {
    expect(claudeSettingsRefusal("{ hooks: ", F)).toBe(`${F} is not JSON, so the stage runner cannot tell what it sets: fix or remove it by hand`);
    expect(claudeSettingsRefusal("[]", F)).toBe(`${F} is not a JSON object: fix or remove it by hand`);
    expect(claudeSettingsRefusal("null", F)).toBe(`${F} is not a JSON object: fix or remove it by hand`);
  });
});

describe("a stage's codex config", () => {
  const F = "/s/config.toml";
  test("takes the allowed keys and the notice table", () => {
    const ok = 'model = "gpt-5.5"\nmodel_reasoning_effort = "high"\npersonality = "x"\n\n[notice]\nhide_full_access_warning = true\n\n[notice.model_migrations]\na = "b"\n';
    expect(codexConfigRefusal(ok, F)).toBe(null);
    expect(codexConfigRefusal("", F)).toBe(null);
  });

  test.each([
    ["notify", 'notify = ["sh", "-c", "x"]\n', "notify"],
    ["an mcp_servers table", '[mcp_servers.x]\ncommand = "y"\n', "mcp_servers"],
    ["a dotted model_providers key", 'model_providers.evil.base_url = "https://x"\n', "model_providers"],
    ["shell_environment_policy", "[shell_environment_policy]\ninherit = \"all\"\n", "shell_environment_policy"],
    ["profiles", '[profiles.p]\nmodel = "x"\n', "profiles"],
    ["a projects table left after the sweep", '[projects."/elsewhere"]\ntrust_level = "trusted"\n', "projects"],
    ["an escaped key a line scan would not read", '"mcp\\u005fservers" = {}\n', "mcp_servers"],
    ["a header hidden in a multi-line string, before a real top-level key", 'model = """\n[notice]\n"""\nnotify = ["x"]\n', "notify"],
  ])("refuses %s, naming the key", (_name, text, key) => {
    expect(codexConfigRefusal(text, F)).toBe(
      `${F} holds "${key}", which a stage's codex config may not: remove it by hand (allowed: ${CODEX_CONFIG_KEYS.join(", ")})`,
    );
  });

  test("refuses what does not parse", () => {
    expect(codexConfigRefusal('model = "a"\nmodel = "b"\n', F)).toBe(`${F} is not TOML the stage runner can read, so it cannot tell what it sets: fix or remove it by hand`);
  });
});

describe("the files themselves", () => {
  const home = async (): Promise<{ claude: string; codex: string }> => {
    const dir = await realpath(await mkdtemp(join(tmpdir(), "canopy-settings-")));
    scratch.push(dir);
    const claude = join(dir, "claude");
    const codex = join(dir, "codex");
    await mkdir(claude);
    await mkdir(codex);
    return { claude, codex };
  };
  const env = (h: { claude: string; codex: string }) => ({ CLAUDE_CONFIG_DIR: h.claude, CODEX_HOME: h.codex });

  test("none at all is fine", async () => {
    expect(await stageSettingsRefusal(env(await home()))).toBe(null);
  });

  test("reads settings.json, settings.local.json and config.toml", async () => {
    const h = await home();
    await writeFile(join(h.claude, "settings.local.json"), JSON.stringify({ env: { ANTHROPIC_BASE_URL: "https://x" } }));
    expect(await stageSettingsRefusal(env(h))).toContain(`${join(h.claude, "settings.local.json")} holds "env"`);
    await rm(join(h.claude, "settings.local.json"));
    await writeFile(join(h.claude, "settings.json"), JSON.stringify({ hooks: {} }));
    expect(await stageSettingsRefusal(env(h))).toContain(`${join(h.claude, "settings.json")} holds "hooks"`);
    await writeFile(join(h.claude, "settings.json"), JSON.stringify({ model: "opus" }));
    await writeFile(join(h.codex, "config.toml"), 'notify = ["x"]\n');
    expect(await stageSettingsRefusal(env(h))).toContain(`${join(h.codex, "config.toml")} holds "notify"`);
  });

  test("with no config dirs named, they are HOME's", async () => {
    const h = await home();
    await mkdir(join(h.claude, ".claude"));
    await writeFile(join(h.claude, ".claude", "settings.json"), JSON.stringify({ apiKeyHelper: "x" }));
    expect(await stageSettingsRefusal({ HOME: h.claude })).toContain(`${join(h.claude, ".claude", "settings.json")} holds "apiKeyHelper"`);
    await mkdir(join(h.codex, ".codex"));
    await writeFile(join(h.codex, ".codex", "config.toml"), "[mcp_servers.x]\n");
    expect(await stageSettingsRefusal({ HOME: h.codex })).toContain(`${join(h.codex, ".codex", "config.toml")} holds "mcp_servers"`);
  });

  test("a fifo or a folder in a settings file's place is refused at once, never waited on", async () => {
    const h = await home();
    await Bun.$`mkfifo ${join(h.claude, "settings.json")}`.quiet();
    const started = Date.now();
    expect(await stageSettingsRefusal(env(h))).toBe(`${join(h.claude, "settings.json")} is not a plain file: remove it by hand`);
    expect(Date.now() - started).toBeLessThan(2000);
    await rm(join(h.claude, "settings.json"));
    await mkdir(join(h.codex, "config.toml"));
    expect(await stageSettingsRefusal(env(h))).toBe(`${join(h.codex, "config.toml")} is not a plain file: remove it by hand`);
  });

  test("one too big to be settings is refused", async () => {
    const h = await home();
    await writeFile(join(h.claude, "settings.json"), `{"model":"${"x".repeat(300_000)}"}`);
    expect(await stageSettingsRefusal(env(h))).toBe(`${join(h.claude, "settings.json")} is larger than settings ever are: remove it by hand`);
  });
});
