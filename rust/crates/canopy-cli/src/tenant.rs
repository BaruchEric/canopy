//! `canopy tenant` (`src/cli/tenant.ts`, FR-074, plan 3): a canopy of its
//! own on this host for a group that must not reach another's files. Run on
//! the host itself, never inside canopy's container. On a Mac it is a
//! launchd agent, which keeps the tenant's people, callers and state apart
//! but runs as your own OS user, so its agents can read your files. On
//! Linux it is a compose project (docker-compose.tenant.yml) that mounts
//! only the tenant's folder and a home of its own, which is the wall.
//! Either way this machine's own backend registry names it, so the page
//! you already open here shows it. The pure half (names, ports, the files
//! written, the registry) is canopy-core's `tenant.rs`.
//!
//! What the host does (its platform, the commands it runs, the ports it
//! listens on, a tenant answering) goes through `TenantSys`, so a test
//! hands in a host of its own. Files are read and written where the
//! TypeScript reads and writes them.
//!
//! One part stays with the TypeScript: the registry is `config.json`'s
//! `backends`, and `saveConfig` writes the whole config as `normalize`
//! makes it, which is not ported. So a registry change on this machine
//! runs the TypeScript CLI's own `tenant register` or `unregister`, as the
//! compose path already runs it inside the main stack's container, and
//! `canopy tenant register` and `unregister` check their words here and
//! hand the write to it. The config stays one writer's until store.ts's
//! save is ported.

use crate::ask::{has, take};
use crate::out::Out;
use canopy_core::backends::normalize_backends;
use canopy_core::js::number_of;
use canopy_core::pathx::{is_bare_origin, join, js_trim, resolve};
use canopy_core::store::load_config;
use canopy_core::tenant::{
    ComposeArgs, PlistArgs, Tenant, TenantHost, compose_env, compose_project, env_refusal,
    first_code_in, free_port, in_tenant_range, launch_label, launchd_plist, parse_tenant,
    tenant_name_refusal, tenant_origins,
};
use regex::Regex;
use serde_json::Value;
use std::collections::HashSet;
use std::sync::LazyLock;
use std::time::Duration;

/// `TENANT_USAGE`.
pub const TENANT_USAGE: &str = "usage: canopy tenant add <name> --root <dir> [--port 7880-7899] [--origins <origin,...>] [--url <address the page dials>] [--dry-run]\n       canopy tenant list\n       canopy tenant up <name>\n       canopy tenant remove <name> [--purge]";

/// the main stack's container, whose config holds this host's registry
const MAIN_CONTAINER: &str = "canopy-canopy-1";

/// What a command run on the host gave: whether it exited 0, and its
/// stdout then stderr, trimmed.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Ran {
    pub ok: bool,
    pub out: String,
}

/// The host, as `canopy tenant` reaches it.
pub(crate) trait TenantSys {
    /// whether this process runs inside a container
    fn in_container(&self) -> bool;
    /// `process.platform`
    fn platform(&self) -> String;
    /// `Bun.which(bin) !== null`
    fn has(&self, bin: &str) -> bool;
    /// `Bun.spawnSync`: Err for a program that is not on PATH, in Bun's
    /// words
    fn run(&self, cmd: &[&str], cwd: Option<&str>) -> Result<Ran, String>;
    /// `homedir()`
    fn home(&self) -> String;
    /// `configDir()`
    fn config_dir(&self) -> String;
    /// the backends this machine's registry names (`loadConfig().backends`)
    fn backend_names(&self) -> Result<Vec<String>, String>;
    /// this checkout, where docker-compose.tenant.yml and bin/canopy.ts live
    fn repo(&self) -> String;
    /// the bun that runs canopy (`process.execPath`)
    fn bun(&self) -> String;
    fn uid(&self) -> u32;
    fn hostname(&self) -> String;
    /// `process.env.PATH`
    fn path_env(&self) -> Option<String>;
    /// `Date.now()`
    fn now(&self) -> f64;
    /// `GET <url>/api/about` answered 2xx within two seconds
    async fn alive(&self, url: &str) -> bool;
    async fn nap(&self, d: Duration);
}

/// where a tenant's own files sit on this host
fn state_root(sys: &impl TenantSys, host: TenantHost) -> String {
    match host {
        TenantHost::Launchd => join(&sys.config_dir(), "tenants"),
        TenantHost::Compose => join(&sys.home(), ".local/share/canopy-tenants"),
    }
}

fn state_dir(sys: &impl TenantSys, host: TenantHost, name: &str) -> String {
    join(&state_root(sys, host), name)
}

fn plist_path(sys: &impl TenantSys, name: &str) -> String {
    join(
        &sys.home(),
        &format!("Library/LaunchAgents/{}.plist", launch_label(name)),
    )
}

/// `hostKind()`: which kind of tenant this host makes, or why it makes none.
fn host_kind(sys: &impl TenantSys) -> Result<TenantHost, String> {
    if sys.in_container() {
        return Err("canopy tenant runs on the host, not inside canopy's container: ssh to the host and run it there".into());
    }
    let p = sys.platform();
    if p == "darwin" {
        return Ok(TenantHost::Launchd);
    }
    if p == "linux" && sys.has("docker") {
        return Ok(TenantHost::Compose);
    }
    Err("a tenant needs launchd (a Mac) or docker (Linux) on this host".into())
}

static PORT_IN: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r":(\d+)(?:[\s\u{feff}]|$)").unwrap());

/// `listening()`: the TCP ports something listens on here.
fn listening(sys: &impl TenantSys) -> Result<HashSet<u16>, String> {
    let r = if sys.platform() == "darwin" {
        sys.run(&["lsof", "-nP", "-iTCP", "-sTCP:LISTEN", "-Fn"], None)?
    } else {
        sys.run(&["ss", "-ltnH"], None)?
    };
    Ok(PORT_IN
        .captures_iter(&r.out)
        .filter_map(|c| c[1].parse().ok())
        .collect())
}

/// `tailnetName()`: this host's MagicDNS name, or None off the tailnet.
fn tailnet_name(sys: &impl TenantSys) -> Result<Option<String>, String> {
    if !sys.has("tailscale") {
        return Ok(None);
    }
    let r = sys.run(&["tailscale", "status", "--json"], None)?;
    if !r.ok {
        return Ok(None);
    }
    let parsed: Value = serde_json::from_str(&r.out).unwrap_or(Value::Null);
    Ok(parsed
        .get("Self")
        .and_then(|s| s.get("DNSName"))
        .and_then(Value::as_str)
        .filter(|d| !d.is_empty())
        .map(|d| d.strip_suffix('.').unwrap_or(d).to_string()))
}

/// `canServe()`: whether this host lets us change tailscale serve without a
/// password.
fn can_serve(sys: &impl TenantSys) -> Result<bool, String> {
    Ok(sys.has("tailscale") && sys.has("sudo") && sys.run(&["sudo", "-n", "true"], None)?.ok)
}

/// JavaScript's `/^\s*([A-Z_][A-Z0-9_]*)=(.*)$/`, whose `.` stops at a CR,
/// so a CRLF line is no match there either.
static ENV_LINE: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"^[\s\u{feff}]*([A-Z_][A-Z0-9_]*)=([^\r\n\u{2028}\u{2029}]*)$").unwrap()
});

/// `readEnv()`: a .env's plain KEY=value lines, quotes taken off.
fn read_env(path: &str) -> Vec<(String, String)> {
    let mut out: Vec<(String, String)> = Vec::new();
    let Ok(text) = std::fs::read_to_string(path) else {
        return out;
    };
    for line in text.split('\n') {
        let Some(m) = ENV_LINE.captures(line) else {
            continue;
        };
        let v = js_trim(&m[2]);
        let unquoted = ['\'', '"']
            .iter()
            .find_map(|q| {
                v.strip_prefix(*q)
                    .and_then(|r| r.strip_suffix(*q))
                    .filter(|_| v.len() >= 2)
            })
            .unwrap_or(v);
        let key = m[1].to_string();
        out.retain(|(k, _)| *k != key);
        out.push((key, unquoted.to_string()));
    }
    out
}

fn env_of<'a>(env: &'a [(String, String)], key: &str) -> Option<&'a str> {
    env.iter().find(|(k, _)| k == key).map(|(_, v)| v.as_str())
}

/// `tenants()`: every tenant this host keeps, of either kind, each folder
/// in the order the directory lists it.
fn tenants(sys: &impl TenantSys) -> Vec<Tenant> {
    let mut out = Vec::new();
    for host in [TenantHost::Launchd, TenantHost::Compose] {
        let dir = state_root(sys, host);
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for e in entries.flatten() {
            let file = join(&join(&dir, &e.file_name().to_string_lossy()), "tenant.json");
            let Ok(text) = std::fs::read_to_string(&file) else {
                continue;
            };
            // a file that is not one is no tenant
            if let Some(t) = serde_json::from_str::<Value>(&text)
                .ok()
                .and_then(|v| parse_tenant(&v))
            {
                out.push(t);
            }
        }
    }
    out
}

/// The TypeScript CLI on this machine, which writes config.json.
fn ts_cli(sys: &impl TenantSys) -> String {
    std::env::var("CANOPY_TS_CLI").unwrap_or_else(|_| join(&sys.repo(), "bin/canopy.ts"))
}

/// `editRegistry()`: changes this machine's registry, or says why it will
/// not; only a tenant's own entry is touched. The TypeScript CLI's own
/// `tenant register` or `unregister` makes the change and words a refusal.
fn edit_registry(
    sys: &impl TenantSys,
    add: Option<(&str, &str)>,
    remove: &str,
) -> Result<Option<String>, String> {
    let bun = sys.bun();
    let cli = ts_cli(sys);
    let r = match add {
        Some((name, url)) => sys.run(&[&bun, &cli, "tenant", "register", name, url], None)?,
        None => sys.run(&[&bun, &cli, "tenant", "unregister", remove], None)?,
    };
    Ok(if r.ok { None } else { Some(r.out) })
}

/// `registry()`: puts the tenant in, or takes it out of, this host's
/// backend registry: the config here on a Mac, the main stack's through its
/// container on Linux. Says whether it changed and what to tell.
fn registry(
    sys: &impl TenantSys,
    host: TenantHost,
    add: Option<(&str, &str)>,
    remove: &str,
) -> Result<(bool, String), String> {
    let done = if add.is_some() {
        "names it"
    } else {
        "no longer names it"
    };
    if host == TenantHost::Compose {
        let mut cmd = vec![
            "docker",
            "exec",
            MAIN_CONTAINER,
            "bun",
            "bin/canopy.ts",
            "tenant",
        ];
        match add {
            Some((name, url)) => cmd.extend(["register", name, url]),
            None => cmd.extend(["unregister", remove]),
        }
        let r = sys.run(&cmd, None)?;
        return Ok(if r.ok {
            (true, format!("the registry of {MAIN_CONTAINER} {done}"))
        } else {
            let last = r
                .out
                .split('\n')
                .next_back()
                .unwrap_or("docker exec failed");
            (
                false,
                format!(
                    "the registry of {MAIN_CONTAINER} was not changed ({last}); deploy this checkout's code to the main stack first"
                ),
            )
        });
    }
    Ok(match edit_registry(sys, add, remove)? {
        Some(why) => (
            false,
            format!("this machine's registry was not changed: {why}"),
        ),
        None => (true, format!("this machine's registry {done}")),
    })
}

/// `waitUp()`: whether the tenant answers within `seconds`, asked once a
/// second.
async fn wait_up(sys: &impl TenantSys, url: &str, seconds: f64) -> bool {
    let until = sys.now() + seconds * 1000.0;
    while sys.now() < until {
        if sys.alive(url).await {
            return true;
        }
        sys.nap(Duration::from_secs(1)).await;
    }
    false
}

/// `localOf()`: where this host reaches a tenant itself: loopback when
/// tailscale serve fronts it, else the address the page dials.
fn local_of(t: &Tenant) -> String {
    if t.url.starts_with("https://") {
        format!(
            "http://127.0.0.1:{}",
            canopy_core::js::number_string(t.port)
        )
    } else {
        t.url.clone()
    }
}

/// `logOf()`: the tenant's log, for its first sign-in code.
fn log_of(sys: &impl TenantSys, t: &Tenant) -> Result<String, String> {
    if t.host == TenantHost::Launchd {
        let file = join(&state_dir(sys, TenantHost::Launchd, &t.name), "server.log");
        return Ok(std::fs::read_to_string(file).unwrap_or_default());
    }
    Ok(sys
        .run(
            &[
                "docker",
                "logs",
                &format!("{}-canopy-1", compose_project(&t.name)),
            ],
            None,
        )?
        .out)
}

fn compose_args(sys: &impl TenantSys, name: &str, env_file: &str) -> Vec<String> {
    vec![
        "docker".into(),
        "compose".into(),
        "-p".into(),
        compose_project(name),
        "--env-file".into(),
        env_file.into(),
        "-f".into(),
        join(&sys.repo(), "docker-compose.tenant.yml"),
    ]
}

fn strs(v: &[String]) -> Vec<&str> {
    v.iter().map(String::as_str).collect()
}

/// `mkdirSync(p, { recursive: true, mode })`.
fn mkdirs(p: &str, mode: u32) -> Result<(), String> {
    use std::os::unix::fs::DirBuilderExt as _;
    std::fs::DirBuilder::new()
        .recursive(true)
        .mode(mode)
        .create(p)
        .map_err(|e| e.to_string())
}

/// `writeFileSync(p, text, { mode })`: the mode only for a new file.
fn write_file(p: &str, text: &str, mode: Option<u32>) -> Result<(), String> {
    use std::io::Write as _;
    use std::os::unix::fs::OpenOptionsExt as _;
    let mut o = std::fs::OpenOptions::new();
    o.write(true).create(true).truncate(true);
    if let Some(m) = mode {
        o.mode(m);
    }
    o.open(p)
        .and_then(|mut f| f.write_all(text.as_bytes()))
        .map_err(|e| e.to_string())
}

/// `tenantHome()`: the tenant's own home's mount points. Docker would make
/// a missing one as root, and a missing file as a folder; `up` makes them
/// too, for a tenant added before a mount was (.gemini came with FR-081).
fn tenant_home(home: &str) -> Result<(), String> {
    for d in [".claude", ".codex", ".gemini", ".config/git"] {
        mkdirs(&join(home, d), 0o700)?;
    }
    let file = join(home, ".claude.json");
    if std::fs::metadata(&file).is_err() {
        write_file(&file, "{}\n", Some(0o600))?;
    }
    Ok(())
}

fn exists(p: &str) -> bool {
    std::fs::metadata(p).is_ok()
}

async fn add(sys: &impl TenantSys, mut args: Vec<String>, out: &mut Out) -> Result<(), String> {
    let dry = has(&mut args, "--dry-run");
    let root_arg = take(&mut args, "--root");
    let port_arg = take(&mut args, "--port");
    let origins_arg = take(&mut args, "--origins");
    let url_arg = take(&mut args, "--url");
    let name = args.first().filter(|n| !n.is_empty()).cloned();
    let (Some(name), Some(root_arg)) = (name, root_arg.filter(|r| !r.is_empty())) else {
        return Err(TENANT_USAGE.into());
    };
    if args.len() > 1 {
        return Err(TENANT_USAGE.into());
    }
    let host = host_kind(sys)?;
    let mut taken_names = sys.backend_names()?;
    taken_names.extend(tenants(sys).into_iter().map(|t| t.name));
    if let Some(why) = tenant_name_refusal(&name, &taken_names) {
        return Err(why);
    }
    let root = resolve(&root_arg);
    if !exists(&root) {
        return Err(format!("no folder {root}"));
    }
    if root == sys.home() || root == "/" {
        return Err(format!(
            "a tenant's folder is the one its group works in, never {root}"
        ));
    }

    let mut taken = listening(sys)?;
    for t in tenants(sys) {
        if t.port.fract() == 0.0 && (0.0..=65535.0).contains(&t.port) {
            taken.insert(t.port as u16);
        }
    }
    let port: u16 = match &port_arg {
        Some(p) => {
            let n = number_of(p);
            if !in_tenant_range(n) {
                return Err("--port is one of 7880 to 7899".into());
            }
            let n = n as u16;
            if taken.contains(&n) {
                return Err(format!("port {n} is taken here"));
            }
            n
        }
        None => free_port(&taken).ok_or("every port from 7880 to 7899 is taken here")?,
    };

    let dir = state_dir(sys, host, &name);
    let home = join(&dir, "home");
    let main_env = if host == TenantHost::Compose {
        read_env(&join(&sys.repo(), ".env"))
    } else {
        vec![]
    };
    // On the mini the tenant listens on loopback and tailscale serve puts it
    // on the tailnet over https, as the main stack's 7849 is, so an https
    // page can call it. Without serve it listens where the main stack does,
    // plain. A Mac's tenant stays on loopback: it is no wall, so it stays
    // off the tailnet.
    let dns = if host == TenantHost::Compose {
        tailnet_name(sys)?
    } else {
        None
    };
    let serve = host == TenantHost::Compose && dns.is_some() && can_serve(sys)?;
    let listen = if host == TenantHost::Compose && !serve {
        env_of(&main_env, "CANOPY_LISTEN")
            .unwrap_or("127.0.0.1")
            .to_string()
    } else {
        "127.0.0.1".to_string()
    };
    let plain_name = if listen == "127.0.0.1" {
        "127.0.0.1".to_string()
    } else {
        sys.hostname()
            .split('.')
            .next()
            .unwrap_or(&listen)
            .to_string()
    };
    let url = match (&url_arg, &dns) {
        (Some(u), _) => u.clone(),
        (None, Some(d)) if serve => format!("https://{d}:{port}"),
        _ => format!("http://{plain_name}:{port}"),
    };
    let local = format!("http://{listen}:{port}");
    let mut given: Vec<String> = vec![
        // the pages that call it: this host's own page at the addresses it
        // is opened at, and every page the main stack already answers
        "http://127.0.0.1:7850".into(),
        "http://localhost:7850".into(),
    ];
    given.extend(
        env_of(&main_env, "CANOPY_ORIGINS")
            .unwrap_or("")
            .split(',')
            .map(String::from),
    );
    given.push(
        env_of(&main_env, "CANOPY_PUBLIC_ORIGIN")
            .unwrap_or("")
            .into(),
    );
    given.extend(
        origins_arg
            .as_deref()
            .unwrap_or("")
            .split(',')
            .map(String::from),
    );
    let origins = tenant_origins(&given);
    let tenant = Tenant {
        name: name.clone(),
        root: root.clone(),
        port: f64::from(port),
        host,
        url: url.clone(),
        created: sys.now(),
    };

    if host == TenantHost::Launchd {
        let entry = join(&sys.repo(), "bin/canopy.ts");
        let config_dir = join(&dir, "config");
        let log = join(&dir, "server.log");
        let path = sys.path_env().unwrap_or_else(|| "/usr/bin:/bin".into());
        let bun = sys.bun();
        let plist = launchd_plist(&PlistArgs {
            name: &name,
            bun: &bun,
            entry: &entry,
            root: &root,
            port,
            config_dir: &config_dir,
            home: &home,
            origins: &origins,
            log: &log,
            path: &path,
        });
        let plist_at = plist_path(sys, &name);
        if dry {
            out.line(format!("would write {plist_at}:\n{plist}"));
            out.line(format!(
                "would run launchctl bootstrap gui/{} {plist_at}, and name {name} at {url} in this machine's registry",
                sys.uid()
            ));
            return Ok(());
        }
        mkdirs(&config_dir, 0o700)?;
        mkdirs(&home, 0o700)?;
        write_file(&join(&dir, "tenant.json"), &tenant.file_text(), Some(0o600))?;
        mkdirs(&join(&sys.home(), "Library/LaunchAgents"), 0o777)?;
        write_file(&plist_at, &plist, None)?;
        let uid = sys.uid();
        sys.run(
            &[
                "launchctl",
                "bootout",
                &format!("gui/{uid}/{}", launch_label(&name)),
            ],
            None,
        )?;
        let boot = sys.run(
            &["launchctl", "bootstrap", &format!("gui/{uid}"), &plist_at],
            None,
        )?;
        if !boot.ok {
            return Err(format!("launchctl did not start it: {}", boot.out));
        }
    } else {
        let joined = origins.join(",");
        for (k, v) in [
            ("TENANT_ROOT", root.as_str()),
            ("TENANT_HOME", home.as_str()),
            ("TENANT_LISTEN", listen.as_str()),
            ("TENANT_ORIGINS", joined.as_str()),
        ] {
            if let Some(why) = env_refusal(k, v) {
                return Err(why);
            }
        }
        let env = compose_env(&ComposeArgs {
            root: &root,
            port,
            listen: &listen,
            home: &home,
            origins: &origins,
            tz: env_of(&main_env, "TZ"),
        });
        let env_file = join(&dir, ".env");
        let mut start = compose_args(sys, &name, &env_file);
        start.extend(["up".into(), "-d".into()]);
        if dry {
            out.line(format!("would write {env_file}:\n{env}"));
            out.line(format!(
                "would run {}{}, and name {name} at {url} in {MAIN_CONTAINER}'s registry",
                start.join(" "),
                if serve {
                    format!(", serve https {port} on the tailnet")
                } else {
                    String::new()
                }
            ));
            return Ok(());
        }
        for img in ["canopy-shells:latest", "canopy-backend:latest"] {
            if !sys.run(&["docker", "image", "inspect", img], None)?.ok {
                return Err(format!(
                    "no {img} image here: the main stack builds it (bun run redeploy)"
                ));
            }
        }
        tenant_home(&home)?;
        write_file(&join(&dir, "tenant.json"), &tenant.file_text(), Some(0o600))?;
        write_file(&env_file, &env, Some(0o600))?;
        let repo = sys.repo();
        let r = sys.run(&strs(&start), Some(&repo))?;
        if !r.ok {
            return Err(format!("docker compose did not start it:\n{}", r.out));
        }
        if serve {
            let s = sys.run(
                &[
                    "sudo",
                    "-n",
                    "tailscale",
                    "serve",
                    "--bg",
                    &format!("--https={port}"),
                    &format!("http://127.0.0.1:{port}"),
                ],
                None,
            )?;
            if !s.ok {
                out.line(format!(
                    "  tailscale serve did not take {port}: {}; it answers on loopback only until it does",
                    s.out.split('\n').next_back().unwrap_or("")
                ));
            }
        }
    }

    let up_now = wait_up(sys, &local, 90.0).await;
    let (changed, said) = registry(sys, host, Some((&name, &url)), &name)?;
    // the code is printed just after the server first answers
    let mut code: Option<String> = None;
    let mut i = 0;
    while i < 10 && code.is_none() && up_now {
        code = first_code_in(&log_of(sys, &tenant)?);
        if code.is_none() {
            sys.nap(Duration::from_millis(500)).await;
        }
        i += 1;
    }
    out.line(format!(
        "tenant {name} {} at {url} ({})",
        if up_now {
            "is up"
        } else {
            "did not answer in 90 s; its log says why"
        },
        if host == TenantHost::Launchd {
            launch_label(&name)
        } else {
            compose_project(&name)
        }
    ));
    out.line(format!("  its folder, the only one it scans: {root}"));
    out.line(if changed {
        format!("  {said}, so the page here lists it after a reload")
    } else {
        format!("  {said}; until it does, add {url} to the page's backends by hand")
    });
    out.line(match code {
        Some(c) => format!("  sign in as its owner: open {url} and type the first code {c}"),
        None => {
            "  sign in as its owner with the first code in its log (canopy tenant list says where)"
                .into()
        }
    });
    out.line("  it has no claude login of its own: give it a provider file (providers/<id>.json in its config) or sign claude in from one of its shells");
    if host == TenantHost::Launchd {
        out.line("  on a Mac it runs as your own OS user: its people, callers and state are its own, your files are not walled off. The mini's tenant is the wall.");
    }
    Ok(())
}

async fn list(sys: &impl TenantSys, out: &mut Out) {
    let all = tenants(sys);
    if all.is_empty() {
        out.line("no tenants on this host");
        return;
    }
    for t in all {
        let alive = sys.alive(&local_of(&t)).await;
        let log = if t.host == TenantHost::Launchd {
            join(&state_dir(sys, TenantHost::Launchd, &t.name), "server.log")
        } else {
            format!("docker logs {}-canopy-1", compose_project(&t.name))
        };
        out.line(format!(
            "{}\t{}\t{}\t{}\t{}\tlog: {log}",
            t.name,
            if alive { "up" } else { "down" },
            t.url,
            t.host.as_str(),
            t.root
        ));
    }
}

/// The tenant a command names, on this host's kind.
fn named(sys: &impl TenantSys, args: &[String]) -> Result<(TenantHost, Tenant), String> {
    let Some(name) = args.first().filter(|n| !n.is_empty()) else {
        return Err(TENANT_USAGE.into());
    };
    if args.len() > 1 {
        return Err(TENANT_USAGE.into());
    }
    let host = host_kind(sys)?;
    let t = tenants(sys)
        .into_iter()
        .find(|t| t.name == *name && t.host == host)
        .ok_or_else(|| format!("no tenant {name} on this host"))?;
    Ok((host, t))
}

/// `up()`: starts a tenant again on what this host has now: the images a
/// deploy just built, or the checkout's code under launchd.
async fn up(sys: &impl TenantSys, args: Vec<String>, out: &mut Out) -> Result<(), String> {
    let (host, t) = named(sys, &args)?;
    let name = &t.name;
    let r = if host == TenantHost::Launchd {
        sys.run(
            &[
                "launchctl",
                "kickstart",
                "-k",
                &format!("gui/{}/{}", sys.uid(), launch_label(name)),
            ],
            None,
        )?
    } else {
        let dir = state_dir(sys, host, name);
        tenant_home(&join(&dir, "home"))?;
        let mut cmd = compose_args(sys, name, &join(&dir, ".env"));
        cmd.extend(["up".into(), "-d".into()]);
        let repo = sys.repo();
        sys.run(&strs(&cmd), Some(&repo))?
    };
    if !r.ok {
        return Err(format!("{name} did not start again:\n{}", r.out));
    }
    let back = wait_up(sys, &local_of(&t), 90.0).await;
    out.line(format!(
        "tenant {name} {} at {}",
        if back {
            "is up"
        } else {
            "did not answer in 90 s"
        },
        t.url
    ));
    Ok(())
}

async fn remove(sys: &impl TenantSys, mut args: Vec<String>, out: &mut Out) -> Result<(), String> {
    let purge = has(&mut args, "--purge");
    let (host, t) = named(sys, &args)?;
    let name = t.name.clone();
    let dir = state_dir(sys, host, &name);
    if host == TenantHost::Launchd {
        sys.run(
            &[
                "launchctl",
                "bootout",
                &format!("gui/{}/{}", sys.uid(), launch_label(&name)),
            ],
            None,
        )?;
        let _ = std::fs::remove_file(plist_path(sys, &name));
    } else {
        let mut cmd = compose_args(sys, &name, &join(&dir, ".env"));
        cmd.push("down".into());
        if purge {
            cmd.push("-v".into());
        }
        let repo = sys.repo();
        let r = sys.run(&strs(&cmd), Some(&repo))?;
        if !r.ok {
            return Err(format!("docker compose did not take it down:\n{}", r.out));
        }
        // off the tailnet too; a tenant that was never served answers no handler
        if sys.has("tailscale") && t.url.starts_with("https://") {
            let port = canopy_core::js::number_string(t.port);
            sys.run(
                &[
                    "sudo",
                    "-n",
                    "tailscale",
                    "serve",
                    &format!("--https={port}"),
                    "off",
                ],
                None,
            )?;
        }
    }
    let (_, said) = registry(sys, host, None, &name)?;
    if purge {
        let _ = std::fs::remove_dir_all(&dir);
    }
    out.line(format!(
        "tenant {name} is stopped and gone from {}; {said}",
        if host == TenantHost::Launchd {
            "launchd"
        } else {
            "docker"
        }
    ));
    out.line(if purge {
        "  its people, callers, state and home are deleted".to_string()
    } else {
        format!(
            "  its people, callers, state and home are kept in {dir}{}; --purge deletes them",
            if host == TenantHost::Compose {
                format!(" and the volume {}_config", compose_project(&name))
            } else {
                String::new()
            }
        )
    });
    Ok(())
}

/// `tenantCommand()`.
pub(crate) async fn tenant_cmd(
    args: Vec<String>,
    sys: &impl TenantSys,
    out: &mut Out,
) -> Result<(), String> {
    let mut rest = args;
    let sub = if rest.is_empty() {
        None
    } else {
        Some(rest.remove(0))
    };
    match sub.as_deref() {
        Some("add") => add(sys, rest, out).await,
        Some("list") | None => {
            list(sys, out).await;
            Ok(())
        }
        Some("up") => up(sys, rest, out).await,
        Some("remove") => remove(sys, rest, out).await,
        // what add and remove run inside the main stack's container to edit
        // its registry; plain config edits, so they need no host
        Some("register") => {
            let name = rest.first().filter(|n| !n.is_empty());
            let url = rest.get(1).filter(|u| !u.is_empty());
            let (Some(name), Some(url)) = (name, url) else {
                return Err("usage: canopy tenant register <name> <url>".into());
            };
            if !is_bare_origin(url) {
                return Err("usage: canopy tenant register <name> <url>".into());
            }
            if let Some(why) = edit_registry(sys, Some((name, url)), name)? {
                return Err(why);
            }
            out.line(format!("the registry names {name} at {url}"));
            Ok(())
        }
        Some("unregister") => {
            let Some(name) = rest.first().filter(|n| !n.is_empty()) else {
                return Err("usage: canopy tenant unregister <name>".into());
            };
            if let Some(why) = edit_registry(sys, None, name)? {
                return Err(why);
            }
            out.line(format!("the registry no longer names {name}"));
            Ok(())
        }
        _ => Err(TENANT_USAGE.into()),
    }
}

/// This machine, as `canopy tenant` runs on it.
pub(crate) struct Real {
    pub client: crate::ask::Client,
}

impl TenantSys for Real {
    fn in_container(&self) -> bool {
        exists("/.dockerenv") || exists("/run/.containerenv")
    }

    fn platform(&self) -> String {
        match std::env::consts::OS {
            "macos" => "darwin".into(),
            other => other.into(),
        }
    }

    fn has(&self, bin: &str) -> bool {
        which(bin).is_some()
    }

    fn run(&self, cmd: &[&str], cwd: Option<&str>) -> Result<Ran, String> {
        let Some((prog, args)) = cmd.split_first() else {
            return Err("no command".into());
        };
        let found = if prog.contains('/') {
            Some(prog.to_string())
        } else {
            which(prog)
        };
        let Some(found) = found else {
            return Err(format!("Executable not found in $PATH: \"{prog}\""));
        };
        let mut c = std::process::Command::new(found);
        c.args(args)
            .stdin(std::process::Stdio::null())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped());
        if let Some(d) = cwd {
            c.current_dir(d);
        }
        let o = c.output().map_err(|e| e.to_string())?;
        let text = format!(
            "{}{}",
            String::from_utf8_lossy(&o.stdout),
            String::from_utf8_lossy(&o.stderr)
        );
        Ok(Ran {
            ok: o.status.success(),
            out: js_trim(&text).to_string(),
        })
    }

    fn home(&self) -> String {
        std::env::var("HOME").unwrap_or_else(|_| "/".into())
    }

    fn config_dir(&self) -> String {
        canopy_core::store::config_dir()
    }

    fn backend_names(&self) -> Result<Vec<String>, String> {
        let cfg = load_config().map_err(|e| e.to_string())?;
        let listed = normalize_backends(cfg.raw.get("backends").unwrap_or(&Value::Null));
        Ok(listed
            .iter()
            .map(|b| canopy_core::js::field(b, "name"))
            .collect())
    }

    fn repo(&self) -> String {
        canopy_core::version::canopy_dir()
    }

    fn bun(&self) -> String {
        which("bun")
            .and_then(|b| std::fs::canonicalize(b).ok())
            .map_or_else(|| "bun".into(), |p| p.to_string_lossy().into_owned())
    }

    fn uid(&self) -> u32 {
        rustix::process::getuid().as_raw()
    }

    fn hostname(&self) -> String {
        crate::pair::hostname()
    }

    fn path_env(&self) -> Option<String> {
        std::env::var("PATH").ok()
    }

    fn now(&self) -> f64 {
        canopy_core::types::now_ms() as f64
    }

    async fn alive(&self, url: &str) -> bool {
        let full = format!("{url}/api/about");
        self.client
            .request_as(
                reqwest::Method::GET,
                &full,
                Some(Duration::from_secs(2)),
                None,
            )
            .send()
            .await
            .is_ok_and(|r| r.status().is_success())
    }

    async fn nap(&self, d: Duration) {
        tokio::time::sleep(d).await;
    }
}

/// `Bun.which()`: the first executable of that name on PATH.
fn which(bin: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt as _;
    let path = std::env::var("PATH").ok()?;
    path.split(':').filter(|d| !d.is_empty()).find_map(|d| {
        let p = join(d, bin);
        std::fs::metadata(&p)
            .ok()
            .filter(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .map(|_| p)
    })
}

#[cfg(test)]
mod tests;
