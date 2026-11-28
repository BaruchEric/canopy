//! A tenant (FR-074, plan 3), the pure half (`src/core/tenant.ts`): a
//! canopy of its own on a host, with its own config dir, port, callers and
//! people, for a group that must not reach another's files. On the mini it
//! is a compose project with the tenant's folder and its own home mounted
//! and nothing of the owner's, which is the wall. On a Mac it is a launchd
//! agent under the owner's OS user, which keeps the roster, the callers and
//! the state apart and not the files. `canopy tenant` (the CLI's
//! `tenant.rs`) does the host's side; everything here is pure: the names,
//! the ports, the files it writes and the registry entry. Registry entries
//! stay the JSON `normalize_backends` reads.

use crate::js::num;
use crate::pathx::{is_bare_origin, js_trim};
use regex::Regex;
use serde_json::{Value, json};
use std::collections::HashSet;
use std::sync::LazyLock;

/// `TENANT_PORTS`: the ports a tenant takes, clear of canopy's own (7850,
/// 7851, 7855, 7859, the previews' 7860-7869) and the mini's 7871.
pub const TENANT_FIRST: u16 = 7880;
pub const TENANT_LAST: u16 = 7899;

/// `TenantHost`: where a tenant runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TenantHost {
    Launchd,
    Compose,
}

impl TenantHost {
    pub fn as_str(self) -> &'static str {
        match self {
            TenantHost::Launchd => "launchd",
            TenantHost::Compose => "compose",
        }
    }
}

/// What `canopy tenant add` keeps in `tenant.json`.
#[derive(Debug, Clone, PartialEq)]
pub struct Tenant {
    pub name: String,
    /// the folder its repos are under, the only one of the host's it sees
    pub root: String,
    pub port: f64,
    pub host: TenantHost,
    /// the address the host's own page dials it at
    pub url: String,
    pub created: f64,
}

impl Tenant {
    /// The record as `JSON.stringify(tenant, null, 2) + "\n"` writes it.
    pub fn file_text(&self) -> String {
        let v = json!({
            "name": self.name,
            "root": self.root,
            "port": num(self.port),
            "host": self.host.as_str(),
            "url": self.url,
            "created": num(self.created),
        });
        format!("{}\n", crate::js::pretty(&v))
    }
}

static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-z][a-z0-9-]{1,23}$").unwrap());

/// `tenantNameRefusal()`: why a name will not do for a tenant, or None.
/// Lowercase letters, digits and hyphens, 2 to 24 long, starting with a
/// letter, and not a backend the registry already names. It is a launchd
/// label, a compose project and a backend's name in every id the page
/// holds.
pub fn tenant_name_refusal(name: &str, taken: &[String]) -> Option<String> {
    if !NAME.is_match(name) {
        return Some(format!(
            "a tenant's name is 2 to 24 lowercase letters, digits and hyphens, starting with a letter (not \"{name}\")"
        ));
    }
    if name.ends_with('-') {
        return Some(format!(
            "a tenant's name does not end in a hyphen (not \"{name}\")"
        ));
    }
    if name == "home" || taken.iter().any(|t| t == name) {
        return Some(format!("{name} already names a backend here"));
    }
    None
}

/// `freePort()`: the first port of the tenants' range nothing holds.
pub fn free_port(taken: &HashSet<u16>) -> Option<u16> {
    (TENANT_FIRST..=TENANT_LAST).find(|p| !taken.contains(p))
}

/// `inTenantRange()`: whether a port asked for by hand is one a tenant may
/// take.
pub fn in_tenant_range(port: f64) -> bool {
    port.fract() == 0.0 && port >= f64::from(TENANT_FIRST) && port <= f64::from(TENANT_LAST)
}

pub fn launch_label(name: &str) -> String {
    format!("canopy.tenant.{name}")
}

pub fn compose_project(name: &str) -> String {
    format!("canopy-t-{name}")
}

fn xml(s: &str) -> String {
    s.replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
}

/// What `launchdPlist()` is given.
pub struct PlistArgs<'a> {
    pub name: &'a str,
    pub bun: &'a str,
    pub entry: &'a str,
    pub root: &'a str,
    pub port: u16,
    pub config_dir: &'a str,
    pub home: &'a str,
    pub origins: &'a [String],
    pub log: &'a str,
    pub path: &'a str,
}

/// `launchdPlist()`: the launchd agent's plist. bun runs canopy straight,
/// not through the owner's mac-server.sh, so none of the owner's keys reach
/// the tenant. HOME is the tenant's own, so its agents read no CLAUDE.md,
/// skills, settings or claude login of the owner's. GIT_CONFIG_NOSYSTEM
/// keeps git off Homebrew's system gitconfig, whose osxkeychain helper
/// would hand a push the owner's GitHub login. ssh still reads the OS
/// user's ~/.ssh whatever HOME says: a Mac tenant is no wall.
pub fn launchd_plist(p: &PlistArgs<'_>) -> String {
    let origins = p.origins.join(",");
    let env: [(&str, &str); 9] = [
        ("CANOPY_CONFIG_DIR", p.config_dir),
        ("CANOPY_CALLERS", "enforce"),
        ("CANOPY_ORIGINS", &origins),
        // no previews, no tailchan (a value that is no URL turns it off),
        // and none of the desktop openers, which would act on the owner's
        // screen
        ("CANOPY_PREVIEW_PORTS", "0"),
        ("CANOPY_TAILCHAN_URL", "off"),
        ("CANOPY_NO_DESKTOP", "1"),
        ("GIT_CONFIG_NOSYSTEM", "1"),
        ("HOME", p.home),
        ("PATH", p.path),
    ];
    let port = p.port.to_string();
    let args = [
        p.bun,
        "run",
        p.entry,
        "ui",
        p.root,
        "--port",
        &port,
        "--no-open",
    ];
    let mut lines: Vec<String> = vec![
        r#"<?xml version="1.0" encoding="UTF-8"?>"#.into(),
        r#"<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">"#.into(),
        r#"<plist version="1.0">"#.into(),
        "<dict>".into(),
        format!(
            "  <key>Label</key><string>{}</string>",
            xml(&launch_label(p.name))
        ),
        "  <key>ProgramArguments</key>".into(),
        "  <array>".into(),
    ];
    lines.extend(
        args.iter()
            .map(|a| format!("    <string>{}</string>", xml(a))),
    );
    lines.push("  </array>".into());
    lines.push("  <key>EnvironmentVariables</key>".into());
    lines.push("  <dict>".into());
    lines.extend(
        env.iter()
            .map(|(k, v)| format!("    <key>{k}</key><string>{}</string>", xml(v))),
    );
    lines.push("  </dict>".into());
    lines.push(format!(
        "  <key>WorkingDirectory</key><string>{}</string>",
        xml(p.root)
    ));
    lines.push("  <key>RunAtLoad</key><true/>".into());
    lines.push("  <key>KeepAlive</key><true/>".into());
    lines.push("  <key>ThrottleInterval</key><integer>10</integer>".into());
    lines.push(format!(
        "  <key>StandardOutPath</key><string>{}</string>",
        xml(p.log)
    ));
    lines.push(format!(
        "  <key>StandardErrorPath</key><string>{}</string>",
        xml(p.log)
    ));
    lines.push("</dict>".into());
    lines.push("</plist>".into());
    lines.push(String::new());
    lines.join("\n")
}

/// `envRefusal()`: a compose .env value is one line, no quotes, no `$` for
/// compose to expand.
pub fn env_refusal(key: &str, value: &str) -> Option<String> {
    if value
        .chars()
        .any(|c| matches!(c, '\n' | '\r' | '"' | '\'' | '$' | '`' | '\\'))
    {
        let quoted = serde_json::to_string(value).unwrap_or_default();
        return Some(format!(
            "{key} may not hold a newline, a quote, a backslash, a backtick or a $ ({quoted})"
        ));
    }
    None
}

/// What `composeEnv()` is given.
pub struct ComposeArgs<'a> {
    pub root: &'a str,
    pub port: u16,
    pub listen: &'a str,
    pub home: &'a str,
    pub origins: &'a [String],
    pub tz: Option<&'a str>,
}

/// `composeEnv()`: the compose project's .env, read by
/// docker-compose.tenant.yml.
pub fn compose_env(p: &ComposeArgs<'_>) -> String {
    let mut lines: Vec<(&str, String)> = vec![
        ("TENANT_ROOT", p.root.into()),
        ("TENANT_PORT", p.port.to_string()),
        ("TENANT_LISTEN", p.listen.into()),
        ("TENANT_HOME", p.home.into()),
        ("TENANT_ORIGINS", p.origins.join(",")),
    ];
    if let Some(tz) = p.tz.filter(|t| !t.is_empty()) {
        lines.push(("TZ", tz.into()));
    }
    let body: Vec<String> = lines.iter().map(|(k, v)| format!("{k}={v}")).collect();
    format!("{}\n", body.join("\n"))
}

/// `tenantOrigins()`: the origins a tenant answers besides its own page,
/// each an exact origin, deduplicated, order kept.
pub fn tenant_origins<S: AsRef<str>>(given: &[S]) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw in given {
        let o = js_trim(raw.as_ref()).trim_end_matches('/');
        if !is_bare_origin(o) {
            continue;
        }
        if !out.iter().any(|x| x == o) {
            out.push(o.to_string());
        }
    }
    out
}

/// `withTenant()`: the registry with the tenant in it, replacing an entry
/// of the same name.
pub fn with_tenant(backends: &[Value], entry: Value) -> Vec<Value> {
    let mut out: Vec<Value> = backends
        .iter()
        .filter(|b| b.get("name") != entry.get("name"))
        .cloned()
        .collect();
    out.push(entry);
    out
}

/// `withoutTenant()`.
pub fn without_tenant(backends: &[Value], name: &str) -> Vec<Value> {
    backends
        .iter()
        .filter(|b| b.get("name").and_then(Value::as_str) != Some(name))
        .cloned()
        .collect()
}

/// `portOf()`: the port an address names, None for one that names none
/// (a URL's default port reads "" in JavaScript too).
fn port_of(url: &Value) -> Option<u16> {
    let s = url.as_str()?;
    url::Url::parse(s).ok()?.port()
}

/// `isTenantEntry()`: every address a registry entry has is on a tenant
/// port.
pub fn is_tenant_entry(b: &Value) -> bool {
    let addrs: Vec<&Value> = ["tailnet", "public"]
        .iter()
        .filter_map(|k| b.get(*k))
        .collect();
    !addrs.is_empty()
        && addrs
            .iter()
            .all(|a| port_of(a).is_some_and(|p| in_tenant_range(f64::from(p))))
}

/// A registry change: a tenant named in, or taken out.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RegistryChange {
    Add { name: String, url: String },
    Remove(String),
}

/// `registryRefusal()`: why a registry change is refused, or None. Only a
/// tenant's own entry is touched, so a slip of the name never drops or
/// rewrites the mini, the Mac or De Soto.
pub fn registry_refusal(backends: &[Value], change: &RegistryChange) -> Option<String> {
    let name = match change {
        RegistryChange::Add { name, .. } | RegistryChange::Remove(name) => name,
    };
    let was = backends
        .iter()
        .find(|b| b.get("name").and_then(Value::as_str) == Some(name));
    if was.is_some_and(|w| !is_tenant_entry(w)) {
        return Some(format!(
            "{name} is a backend of its own, not a tenant; the registry keeps it"
        ));
    }
    if let RegistryChange::Add { url, .. } = change {
        let ok = port_of(&json!(url)).is_some_and(|p| in_tenant_range(f64::from(p)));
        if !ok {
            return Some(format!(
                "a tenant's address is on a port from {TENANT_FIRST} to {TENANT_LAST}, not {url}"
            ));
        }
    }
    None
}

/// `parseTenant()`: what a tenant.json holds, None for a file that is not
/// one.
pub fn parse_tenant(v: &Value) -> Option<Tenant> {
    let o = v.as_object()?;
    let s = |k: &str| o.get(k).and_then(Value::as_str).map(String::from);
    let n = |k: &str| o.get(k).and_then(Value::as_f64);
    let host = match o.get("host").and_then(Value::as_str) {
        Some("launchd") => TenantHost::Launchd,
        Some("compose") => TenantHost::Compose,
        _ => return None,
    };
    Some(Tenant {
        name: s("name")?,
        root: s("root")?,
        port: n("port")?,
        host,
        url: s("url")?,
        created: n("created")?,
    })
}

static FIRST_CODE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"first sign-in code (\S+) ").unwrap());

/// `firstCodeIn()`: the first sign-in code a tenant's log printed last, None
/// before it prints one; a restart prints a new one.
pub fn first_code_in(log: &str) -> Option<String> {
    FIRST_CODE
        .captures_iter(log)
        .last()
        .map(|c| c[1].to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn taken(names: &[&str]) -> Vec<String> {
        names.iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn a_tenants_name_is_a_short_lowercase_word_a_label_a_project_and_an_id_can_carry() {
        assert_eq!(tenant_name_refusal("acme", &[]), None);
        assert_eq!(tenant_name_refusal("team-2", &[]), None);
        let long = "a".repeat(25);
        for bad in [
            "A",
            "a",
            "Acme",
            "2team",
            "acme_co",
            "acme co",
            "-acme",
            "acme-",
            long.as_str(),
            "acme/../x",
        ] {
            assert!(tenant_name_refusal(bad, &[]).is_some(), "{bad}");
        }
    }

    #[test]
    fn a_tenants_name_is_not_a_backend_the_registry_already_names() {
        assert!(
            tenant_name_refusal("mini", &taken(&["mac", "mini"]))
                .unwrap()
                .contains("already names a backend")
        );
        assert!(
            tenant_name_refusal("home", &[])
                .unwrap()
                .contains("already names a backend")
        );
    }

    #[test]
    fn a_tenants_name_makes_its_launchd_label_and_compose_project() {
        assert_eq!(launch_label("acme"), "canopy.tenant.acme");
        assert_eq!(compose_project("acme"), "canopy-t-acme");
    }

    #[test]
    fn a_tenants_port_is_the_first_of_the_range_nothing_holds() {
        assert_eq!(free_port(&HashSet::new()), Some(TENANT_FIRST));
        assert_eq!(free_port(&HashSet::from([7880, 7881])), Some(7882));
        let all: HashSet<u16> = (TENANT_FIRST..=TENANT_LAST).collect();
        assert_eq!(free_port(&all), None);
    }

    #[test]
    fn a_tenants_port_asked_for_by_hand_stays_in_the_range_clear_of_canopys_own() {
        assert!(in_tenant_range(7885.0));
        for p in [7850.0, 7855.0, 7859.0, 7865.0, 7871.0, 7900.0, 7880.5] {
            assert!(!in_tenant_range(p), "{p}");
        }
    }

    fn plist() -> String {
        let origins = taken(&["http://127.0.0.1:7850", "http://localhost:7850"]);
        launchd_plist(&PlistArgs {
            name: "acme",
            bun: "/Users/x/.bun/bin/bun",
            entry: "/repo/bin/canopy.ts",
            root: "/Users/x/clients/acme & co",
            port: 7880,
            config_dir: "/Users/x/.config/canopy/tenants/acme/config",
            home: "/Users/x/.config/canopy/tenants/acme/home",
            origins: &origins,
            log: "/Users/x/.config/canopy/tenants/acme/server.log",
            path: "/usr/bin:/bin",
        })
    }

    #[test]
    fn the_launchd_agent_runs_canopy_straight_on_its_own_port_config_and_home_enforcing_who_calls()
    {
        let p = plist();
        for want in [
            "<string>canopy.tenant.acme</string>",
            "<string>/repo/bin/canopy.ts</string>",
            "<string>7880</string>",
            "<key>CANOPY_CALLERS</key><string>enforce</string>",
            "<key>CANOPY_CONFIG_DIR</key><string>/Users/x/.config/canopy/tenants/acme/config</string>",
            "<key>HOME</key><string>/Users/x/.config/canopy/tenants/acme/home</string>",
            "<key>CANOPY_ORIGINS</key><string>http://127.0.0.1:7850,http://localhost:7850</string>",
            "<key>CANOPY_NO_DESKTOP</key><string>1</string>",
            "<key>GIT_CONFIG_NOSYSTEM</key><string>1</string>",
        ] {
            assert!(p.contains(want), "{want}");
        }
        assert!(!p.contains("mac-server.sh"));
        assert!(p.ends_with("</plist>\n"));
    }

    #[test]
    fn the_launchd_agent_escapes_what_xml_would_read_as_markup() {
        assert!(plist().contains("<string>/Users/x/clients/acme &amp; co</string>"));
    }

    #[test]
    fn the_compose_projects_env_names_the_folder_the_port_the_bind_the_home_and_the_origins() {
        let origins = taken(&["https://canopy.beric.ca"]);
        assert_eq!(
            compose_env(&ComposeArgs {
                root: "/home/eric/clients/acme",
                port: 7881,
                listen: "100.68.139.95",
                home: "/home/eric/.local/share/canopy-tenants/acme/home",
                origins: &origins,
                tz: None,
            }),
            [
                "TENANT_ROOT=/home/eric/clients/acme",
                "TENANT_PORT=7881",
                "TENANT_LISTEN=100.68.139.95",
                "TENANT_HOME=/home/eric/.local/share/canopy-tenants/acme/home",
                "TENANT_ORIGINS=https://canopy.beric.ca",
                "",
            ]
            .join("\n")
        );
    }

    #[test]
    fn a_value_compose_would_expand_or_split_is_refused() {
        assert_eq!(env_refusal("TENANT_ROOT", "/srv/acme"), None);
        for bad in ["/srv/$HOME", "/srv/a\nb", "/srv/\"a\"", "/srv/`x`"] {
            assert!(env_refusal("TENANT_ROOT", bad).is_some(), "{bad}");
        }
        assert_eq!(
            env_refusal("K", "a\nb").unwrap(),
            "K may not hold a newline, a quote, a backslash, a backtick or a $ (\"a\\nb\")"
        );
    }

    #[test]
    fn the_origins_it_answers_are_exact_origins_once_each_in_the_order_given() {
        assert_eq!(
            tenant_origins(&[
                "http://127.0.0.1:7850/",
                "https://canopy.beric.ca",
                " https://canopy.beric.ca ",
                "not a url",
                "https://x.test/path",
            ]),
            ["http://127.0.0.1:7850", "https://canopy.beric.ca"]
        );
    }

    #[test]
    fn the_registry_takes_the_tenant_in_replacing_one_of_the_same_name() {
        let mac = json!({"name": "mac", "tailnet": "http://mac:7850"});
        let one = with_tenant(
            std::slice::from_ref(&mac),
            json!({"name": "acme", "tailnet": "http://127.0.0.1:7880"}),
        );
        assert_eq!(
            one,
            [
                mac.clone(),
                json!({"name": "acme", "tailnet": "http://127.0.0.1:7880"})
            ]
        );
        assert_eq!(
            with_tenant(
                &one,
                json!({"name": "acme", "tailnet": "http://127.0.0.1:7881"})
            ),
            [
                mac,
                json!({"name": "acme", "tailnet": "http://127.0.0.1:7881"})
            ]
        );
    }

    #[test]
    fn the_registry_lets_it_go() {
        let mac = json!({"name": "mac", "tailnet": "http://mac:7850"});
        assert_eq!(
            without_tenant(&[mac.clone(), json!({"name": "acme"})], "acme"),
            [mac]
        );
    }

    #[test]
    fn the_registry_touches_only_a_tenants_own_entry_on_a_tenant_port() {
        let mac = json!({"name": "mac", "tailnet": "http://mac:7850"});
        let acme = json!({"name": "acme", "tailnet": "https://mini.ts.net:7880"});
        assert!(is_tenant_entry(&acme));
        assert!(!is_tenant_entry(&mac));
        assert!(!is_tenant_entry(&json!({"name": "bare"})));
        let both = [mac.clone(), acme.clone()];
        let add = |name: &str, url: &str| RegistryChange::Add {
            name: name.into(),
            url: url.into(),
        };
        assert_eq!(
            registry_refusal(&both, &RegistryChange::Remove("acme".into())),
            None
        );
        assert_eq!(
            registry_refusal(&both, &add("acme", "https://mini.ts.net:7881")),
            None
        );
        let only = std::slice::from_ref(&mac);
        assert_eq!(
            registry_refusal(only, &RegistryChange::Remove("acme".into())),
            None
        );
        assert!(
            registry_refusal(&both, &RegistryChange::Remove("mac".into()))
                .unwrap()
                .contains("not a tenant")
        );
        assert!(
            registry_refusal(only, &add("mac", "http://127.0.0.1:7880"))
                .unwrap()
                .contains("not a tenant")
        );
        assert!(
            registry_refusal(only, &add("acme", "http://127.0.0.1:7850"))
                .unwrap()
                .contains("7880 to 7899")
        );
    }

    #[test]
    fn a_tenant_json_parses_and_anything_else_does_not() {
        let t = json!({"name": "acme", "root": "/srv/acme", "port": 7880, "host": "launchd", "url": "http://127.0.0.1:7880", "created": 1});
        let parsed = parse_tenant(&t).unwrap();
        assert_eq!(
            parsed,
            Tenant {
                name: "acme".into(),
                root: "/srv/acme".into(),
                port: 7880.0,
                host: TenantHost::Launchd,
                url: "http://127.0.0.1:7880".into(),
                created: 1.0,
            }
        );
        assert_eq!(
            parsed.file_text(),
            format!("{}\n", serde_json::to_string_pretty(&t).unwrap())
        );
        let mut vm = t.clone();
        vm["host"] = json!("vm");
        assert_eq!(parse_tenant(&vm), None);
        let mut text_port = t.clone();
        text_port["port"] = json!("7880");
        assert_eq!(parse_tenant(&text_port), None);
        assert_eq!(parse_tenant(&Value::Null), None);
    }

    #[test]
    fn the_first_sign_in_code_is_read_off_the_tenants_log() {
        assert_eq!(
            first_code_in(
                "canopy: first sign-in code ABCD-1234 (good until a page or the CLI signs in)\n"
            )
            .as_deref(),
            Some("ABCD-1234")
        );
        assert_eq!(
            first_code_in(
                "canopy: first sign-in code OLD-1 (good until)\ncanopy: first sign-in code NEW-2 (good until)\n"
            )
            .as_deref(),
            Some("NEW-2")
        );
        assert_eq!(first_code_in("canopy on :7880\n"), None);
    }
}
