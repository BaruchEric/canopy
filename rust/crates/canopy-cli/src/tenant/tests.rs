//! `canopy tenant` on a host of the test's own: a scratch home and config
//! dir, the commands it runs kept and answered by the test, and a clock
//! that moves only when the command naps. tenant.ts has no tests of its
//! own; core tenant.test.ts covers the pure half in canopy-core.

use super::*;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

type Answer = Box<dyn Fn(&[String]) -> Result<Ran, String> + Send + Sync>;

struct Host {
    dir: String,
    container: bool,
    platform: &'static str,
    bins: Vec<&'static str>,
    names: Vec<String>,
    up: Vec<String>,
    answer: Answer,
    ran: Mutex<Vec<String>>,
    clock: AtomicU64,
}

impl Host {
    fn new(platform: &'static str) -> Self {
        static NEXT: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let n = NEXT.fetch_add(1, Ordering::Relaxed);
        let p = std::env::temp_dir().join(format!("canopy-tenant-{}-{n}", std::process::id()));
        std::fs::create_dir_all(p.join("home")).unwrap();
        std::fs::create_dir_all(p.join("config")).unwrap();
        std::fs::create_dir_all(p.join("repo")).unwrap();
        std::fs::create_dir_all(p.join("clients/acme")).unwrap();
        Host {
            dir: p.to_string_lossy().into_owned(),
            container: false,
            platform,
            bins: vec!["docker"],
            names: vec!["mac".into(), "mini".into()],
            up: vec![],
            answer: Box::new(|_| {
                Ok(Ran {
                    ok: true,
                    out: String::new(),
                })
            }),
            ran: Mutex::default(),
            clock: AtomicU64::new(1_000),
        }
    }

    fn at(&self, p: &str) -> String {
        format!("{}/{p}", self.dir)
    }

    fn ran(&self) -> Vec<String> {
        self.ran.lock().unwrap().clone()
    }

    /// a tenant.json under the folder of its kind
    fn keep(&self, host: TenantHost, name: &str, port: u16, url: &str) {
        let t = Tenant {
            name: name.into(),
            root: format!("/srv/{name}"),
            port: f64::from(port),
            host,
            url: url.into(),
            created: 1.0,
        };
        let dir = format!("{}/{name}", state_root(self, host));
        std::fs::create_dir_all(&dir).unwrap();
        std::fs::write(format!("{dir}/tenant.json"), t.file_text()).unwrap();
    }
}

impl Drop for Host {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.dir);
    }
}

impl TenantSys for Host {
    fn in_container(&self) -> bool {
        self.container
    }
    fn platform(&self) -> String {
        self.platform.into()
    }
    fn has(&self, bin: &str) -> bool {
        self.bins.contains(&bin)
    }
    fn run(&self, cmd: &[&str], cwd: Option<&str>) -> Result<Ran, String> {
        let line = cmd.join(" ");
        self.ran.lock().unwrap().push(match cwd {
            Some(d) => format!("{line}  (in {d})"),
            None => line,
        });
        let owned: Vec<String> = cmd.iter().map(|s| s.to_string()).collect();
        (self.answer)(&owned)
    }
    fn home(&self) -> String {
        self.at("home")
    }
    fn config_dir(&self) -> String {
        self.at("config")
    }
    fn backend_names(&self) -> Result<Vec<String>, String> {
        Ok(self.names.clone())
    }
    fn repo(&self) -> String {
        self.at("repo")
    }
    fn bun(&self) -> String {
        "/opt/bun".into()
    }
    fn uid(&self) -> u32 {
        501
    }
    fn hostname(&self) -> String {
        "mini.local".into()
    }
    fn path_env(&self) -> Option<String> {
        Some("/usr/bin:/bin".into())
    }
    fn now(&self) -> f64 {
        self.clock.load(Ordering::Relaxed) as f64
    }
    async fn alive(&self, url: &str) -> bool {
        self.up.iter().any(|u| u == url)
    }
    async fn nap(&self, d: Duration) {
        self.clock
            .fetch_add(d.as_millis() as u64, Ordering::Relaxed);
    }
}

async fn run(host: &Host, args: &[&str]) -> (Vec<String>, Result<(), String>) {
    let mut out = Out::default();
    let r = tenant_cmd(args.iter().map(|s| s.to_string()).collect(), host, &mut out).await;
    (out.text.lines().map(String::from).collect(), r)
}

#[tokio::test]
async fn list_says_none_then_each_tenant_up_or_down_with_where_its_log_is() {
    let mut host = Host::new("linux");
    assert_eq!(run(&host, &["list"]).await.0, ["no tenants on this host"]);
    host.keep(TenantHost::Launchd, "acme", 7880, "http://127.0.0.1:7880");
    host.keep(TenantHost::Compose, "rio", 7881, "https://mini.ts.net:7881");
    // a folder with no tenant.json and one that is not one are no tenants
    std::fs::create_dir_all(format!("{}/tenants/empty", host.at("config"))).unwrap();
    std::fs::create_dir_all(format!("{}/tenants/junk", host.at("config"))).unwrap();
    std::fs::write(
        format!("{}/tenants/junk/tenant.json", host.at("config")),
        "{",
    )
    .unwrap();
    // served over https, it is asked on loopback at its port
    host.up = vec!["http://127.0.0.1:7881".into()];
    let (lines, r) = run(&host, &[]).await;
    r.unwrap();
    assert_eq!(
        lines,
        [
            format!(
                "acme\tdown\thttp://127.0.0.1:7880\tlaunchd\t/srv/acme\tlog: {}/tenants/acme/server.log",
                host.at("config")
            ),
            "rio\tup\thttps://mini.ts.net:7881\tcompose\t/srv/rio\tlog: docker logs canopy-t-rio-canopy-1".to_string(),
        ]
    );
    assert!(host.ran().is_empty());
}

#[tokio::test]
async fn inside_a_container_add_up_and_remove_are_refused_after_their_usage() {
    let mut host = Host::new("linux");
    host.container = true;
    let inside = "canopy tenant runs on the host, not inside canopy's container: ssh to the host and run it there";
    for (args, want) in [
        (&["add", "acme"][..], TENANT_USAGE),
        (&["add", "--root", "/x"][..], TENANT_USAGE),
        (&["add", "acme", "b", "--root", "/x"][..], TENANT_USAGE),
        (&["add", "acme", "--root", "/x", "--dry-run"][..], inside),
        (&["up"][..], TENANT_USAGE),
        (&["up", "acme"][..], inside),
        (&["remove", "acme", "--purge"][..], inside),
        (&["remove", "a", "b"][..], TENANT_USAGE),
        (&["frob"][..], TENANT_USAGE),
    ] {
        assert_eq!(run(&host, args).await.1, Err(want.to_string()), "{args:?}");
    }
    let mut bare = Host::new("linux");
    bare.bins = vec![];
    assert_eq!(
        run(&bare, &["up", "acme"]).await.1,
        Err("a tenant needs launchd (a Mac) or docker (Linux) on this host".into())
    );
}

#[tokio::test]
async fn add_refuses_a_bad_name_a_taken_one_a_missing_folder_home_and_a_port_out_of_range() {
    let mut host = Host::new("darwin");
    host.answer = Box::new(|cmd| {
        Ok(Ran {
            ok: true,
            out: if cmd[0] == "lsof" {
                "p1\nn*:7880\np2\nn127.0.0.1:7881".into()
            } else {
                String::new()
            },
        })
    });
    let root = host.at("clients/acme");
    let home = host.home();
    for (args, want) in [
        (vec!["add", "Acme", "--root", &root], "a tenant's name is 2 to 24 lowercase letters, digits and hyphens, starting with a letter (not \"Acme\")".to_string()),
        (vec!["add", "mini", "--root", &root], "mini already names a backend here".to_string()),
        (vec!["add", "acme", "--root", "/nonexistent/acme"], "no folder /nonexistent/acme".to_string()),
        (vec!["add", "acme", "--root", &home], format!("a tenant's folder is the one its group works in, never {home}")),
        (vec!["add", "acme", "--root", "/"], "a tenant's folder is the one its group works in, never /".to_string()),
        (vec!["add", "acme", "--root", &root, "--port", "7000"], "--port is one of 7880 to 7899".to_string()),
        (vec!["add", "acme", "--root", &root, "--port", "x"], "--port is one of 7880 to 7899".to_string()),
        (vec!["add", "acme", "--root", &root, "--port", "7881"], "port 7881 is taken here".to_string()),
    ] {
        assert_eq!(run(&host, &args).await.1, Err(want), "{args:?}");
    }
}

#[tokio::test]
async fn a_dry_run_on_a_mac_prints_the_agent_it_would_load_and_writes_nothing() {
    let mut host = Host::new("darwin");
    host.answer = Box::new(|cmd| {
        Ok(Ran {
            ok: true,
            out: if cmd[0] == "lsof" {
                "n*:7880".into()
            } else {
                String::new()
            },
        })
    });
    let root = host.at("clients/acme");
    let (lines, r) = run(
        &host,
        &[
            "add",
            "acme",
            "--root",
            &root,
            "--origins",
            "https://a.test/,bad",
            "--dry-run",
        ],
    )
    .await;
    r.unwrap();
    let dir = format!("{}/tenants/acme", host.at("config"));
    let plist_at = format!(
        "{}/Library/LaunchAgents/canopy.tenant.acme.plist",
        host.home()
    );
    let plist = launchd_plist(&PlistArgs {
        name: "acme",
        bun: "/opt/bun",
        entry: &format!("{}/bin/canopy.ts", host.repo()),
        root: &root,
        port: 7881,
        config_dir: &format!("{dir}/config"),
        home: &format!("{dir}/home"),
        origins: &[
            "http://127.0.0.1:7850".to_string(),
            "http://localhost:7850".to_string(),
            "https://a.test".to_string(),
        ],
        log: &format!("{dir}/server.log"),
        path: "/usr/bin:/bin",
    });
    let mut want: Vec<String> = format!("would write {plist_at}:\n{plist}")
        .split('\n')
        .map(String::from)
        .collect();
    want.push(format!(
        "would run launchctl bootstrap gui/501 {plist_at}, and name acme at http://127.0.0.1:7881 in this machine's registry"
    ));
    assert_eq!(lines, want);
    assert!(std::fs::metadata(&dir).is_err());
    assert_eq!(host.ran(), ["lsof -nP -iTCP -sTCP:LISTEN -Fn"]);
}

#[tokio::test]
async fn a_dry_run_on_linux_reads_the_main_env_serves_on_the_tailnet_and_prints_the_compose_file() {
    let mut host = Host::new("linux");
    host.bins = vec!["docker", "tailscale", "sudo"];
    std::fs::write(
        host.at("repo/.env"),
        "CANOPY_ORIGINS=https://canopy.example.ca,http://mini:7850\nCANOPY_PUBLIC_ORIGIN='https://pub.example.ca'\nTZ=\"America/Los_Angeles\"\nCRLF=x\r\n# a comment\n",
    )
    .unwrap();
    host.answer = Box::new(|cmd| {
        Ok(Ran {
            ok: true,
            out: match cmd[0].as_str() {
                "ss" => "LISTEN 0 4096 127.0.0.1:7850 0.0.0.0:*\nLISTEN 0 4096 *:7880 *:*".into(),
                "tailscale" => r#"{"Self": {"DNSName": "mini.tail2d2c60.ts.net."}}"#.into(),
                _ => String::new(),
            },
        })
    });
    let root = host.at("clients/acme");
    let (lines, r) = run(&host, &["add", "acme", "--root", &root, "--dry-run"]).await;
    r.unwrap();
    let dir = format!("{}/.local/share/canopy-tenants/acme", host.home());
    assert_eq!(
        lines,
        [
            format!("would write {dir}/.env:"),
            format!("TENANT_ROOT={root}"),
            "TENANT_PORT=7881".to_string(),
            "TENANT_LISTEN=127.0.0.1".to_string(),
            format!("TENANT_HOME={dir}/home"),
            "TENANT_ORIGINS=http://127.0.0.1:7850,http://localhost:7850,https://canopy.example.ca,http://mini:7850,https://pub.example.ca".to_string(),
            "TZ=America/Los_Angeles".to_string(),
            String::new(),
            format!(
                "would run docker compose -p canopy-t-acme --env-file {dir}/.env -f {}/docker-compose.tenant.yml up -d, serve https 7881 on the tailnet, and name acme at https://mini.tail2d2c60.ts.net:7881 in canopy-canopy-1's registry",
                host.repo()
            ),
        ]
    );
    assert_eq!(
        host.ran(),
        ["ss -ltnH", "tailscale status --json", "sudo -n true"]
    );
}

#[tokio::test]
async fn add_on_a_mac_writes_the_tenant_loads_it_names_it_and_reads_its_first_code() {
    let mut host = Host::new("darwin");
    host.up = vec!["http://127.0.0.1:7880".into()];
    let root = host.at("clients/acme");
    let log_dir = format!("{}/tenants/acme", host.at("config"));
    let log = format!("{log_dir}/server.log");
    let log_at = log.clone();
    host.answer = Box::new(move |cmd| {
        // the agent prints its first code once launchd starts it
        if cmd.get(1).map(String::as_str) == Some("bootstrap") {
            std::fs::write(
                &log_at,
                "canopy: first sign-in code ZX9-4 (good until a page or the CLI signs in)\n",
            )
            .unwrap();
        }
        Ok(Ran {
            ok: true,
            out: String::new(),
        })
    });
    let (lines, r) = run(&host, &["add", "acme", "--root", &root]).await;
    r.unwrap();
    assert_eq!(
        lines,
        [
            "tenant acme is up at http://127.0.0.1:7880 (canopy.tenant.acme)".to_string(),
            format!("  its folder, the only one it scans: {root}"),
            "  this machine's registry names it, so the page here lists it after a reload".to_string(),
            "  sign in as its owner: open http://127.0.0.1:7880 and type the first code ZX9-4".to_string(),
            "  it has no claude login of its own: give it a provider file (providers/<id>.json in its config) or sign claude in from one of its shells".to_string(),
            "  on a Mac it runs as your own OS user: its people, callers and state are its own, your files are not walled off. The mini's tenant is the wall.".to_string(),
        ]
    );
    let kept: Value =
        serde_json::from_str(&std::fs::read_to_string(format!("{log_dir}/tenant.json")).unwrap())
            .unwrap();
    assert_eq!(
        kept,
        serde_json::json!({"name": "acme", "root": root, "port": 7880, "host": "launchd", "url": "http://127.0.0.1:7880", "created": 1000})
    );
    use std::os::unix::fs::PermissionsExt as _;
    let mode = std::fs::metadata(format!("{log_dir}/tenant.json"))
        .unwrap()
        .permissions()
        .mode()
        & 0o777;
    assert_eq!(mode, 0o600);
    let plist = std::fs::read_to_string(format!(
        "{}/Library/LaunchAgents/canopy.tenant.acme.plist",
        host.home()
    ))
    .unwrap();
    assert!(plist.contains("<string>7880</string>"));
    let ts =
        std::env::var("CANOPY_TS_CLI").unwrap_or_else(|_| format!("{}/bin/canopy.ts", host.repo()));
    assert_eq!(
        host.ran(),
        [
            "lsof -nP -iTCP -sTCP:LISTEN -Fn".to_string(),
            "launchctl bootout gui/501/canopy.tenant.acme".to_string(),
            format!(
                "launchctl bootstrap gui/501 {}/Library/LaunchAgents/canopy.tenant.acme.plist",
                host.home()
            ),
            format!("/opt/bun {ts} tenant register acme http://127.0.0.1:7880"),
        ]
    );
}

#[tokio::test]
async fn add_on_linux_refuses_without_the_main_stacks_images() {
    let mut host = Host::new("linux");
    host.answer = Box::new(|cmd| {
        Ok(Ran {
            ok: !(cmd[1] == "image" && cmd[3] == "canopy-backend:latest"),
            out: String::new(),
        })
    });
    let root = host.at("clients/acme");
    assert_eq!(
        run(&host, &["add", "acme", "--root", &root]).await.1,
        Err(
            "no canopy-backend:latest image here: the main stack builds it (bun run redeploy)"
                .into()
        )
    );
    assert!(
        std::fs::metadata(format!("{}/.local/share/canopy-tenants/acme", host.home())).is_err()
    );
}

#[tokio::test]
async fn up_and_remove_find_the_tenant_on_this_hosts_kind_and_say_what_is_kept() {
    let mut host = Host::new("linux");
    host.keep(TenantHost::Compose, "rio", 7881, "https://mini.ts.net:7881");
    host.keep(TenantHost::Launchd, "acme", 7880, "http://127.0.0.1:7880");
    host.bins = vec!["docker", "tailscale"];
    host.up = vec!["http://127.0.0.1:7881".into()];
    assert_eq!(
        run(&host, &["up", "acme"]).await.1,
        Err("no tenant acme on this host".into())
    );
    let (lines, r) = run(&host, &["up", "rio"]).await;
    r.unwrap();
    assert_eq!(lines, ["tenant rio is up at https://mini.ts.net:7881"]);
    let dir = format!("{}/.local/share/canopy-tenants/rio", host.home());
    assert!(std::fs::metadata(format!("{dir}/home/.claude.json")).is_ok());
    let (lines, r) = run(&host, &["remove", "rio"]).await;
    r.unwrap();
    assert_eq!(
        lines,
        [
            "tenant rio is stopped and gone from docker; the registry of canopy-canopy-1 no longer names it".to_string(),
            format!("  its people, callers, state and home are kept in {dir} and the volume canopy-t-rio_config; --purge deletes them"),
        ]
    );
    let ran = host.ran();
    assert_eq!(
        ran[ran.len() - 3..],
        [
            format!(
                "docker compose -p canopy-t-rio --env-file {dir}/.env -f {}/docker-compose.tenant.yml down  (in {})",
                host.repo(),
                host.repo()
            ),
            "sudo -n tailscale serve --https=7881 off".to_string(),
            "docker exec canopy-canopy-1 bun bin/canopy.ts tenant unregister rio".to_string(),
        ]
    );
    let (lines, r) = run(&host, &["remove", "rio", "--purge"]).await;
    r.unwrap();
    assert_eq!(
        lines[1],
        "  its people, callers, state and home are deleted"
    );
    assert!(std::fs::metadata(&dir).is_err());
}

#[tokio::test]
async fn register_checks_its_words_and_hands_the_write_to_the_typescript_cli() {
    let mut host = Host::new("linux");
    host.container = true;
    host.answer = Box::new(|cmd| {
        Ok(if cmd.iter().any(|w| w == "mac") {
            Ran {
                ok: false,
                out: "mac is a backend of its own, not a tenant; the registry keeps it".into(),
            }
        } else {
            Ran {
                ok: true,
                out: String::new(),
            }
        })
    });
    let usage = "usage: canopy tenant register <name> <url>";
    for args in [
        &["register"][..],
        &["register", "acme"][..],
        &["register", "acme", "http://x/y"][..],
    ] {
        assert_eq!(run(&host, args).await.1, Err(usage.into()), "{args:?}");
    }
    assert_eq!(
        run(&host, &["unregister"]).await.1,
        Err("usage: canopy tenant unregister <name>".into())
    );
    assert!(host.ran().is_empty());
    assert_eq!(
        run(&host, &["register", "acme", "http://127.0.0.1:7880"]).await,
        (
            vec!["the registry names acme at http://127.0.0.1:7880".to_string()],
            Ok(())
        )
    );
    assert_eq!(
        run(&host, &["unregister", "acme"]).await,
        (
            vec!["the registry no longer names acme".to_string()],
            Ok(())
        )
    );
    assert_eq!(
        run(&host, &["unregister", "mac"]).await.1,
        Err("mac is a backend of its own, not a tenant; the registry keeps it".into())
    );
}

#[test]
fn a_main_env_keeps_plain_lines_takes_quotes_off_and_skips_a_crlf_line() {
    let dir = std::env::temp_dir().join(format!("canopy-tenant-env-{}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let file = dir.join(".env");
    std::fs::write(&file, "  A=1\nB = 2\nC=\"q\"\nD='\"\nE=x\r\nlower=1\nA=3\n").unwrap();
    let env = read_env(&file.to_string_lossy());
    let _ = std::fs::remove_dir_all(&dir);
    assert_eq!(env_of(&env, "A"), Some("3"));
    assert_eq!(env_of(&env, "B"), None);
    assert_eq!(env_of(&env, "C"), Some("q"));
    assert_eq!(env_of(&env, "D"), Some("'\""));
    assert_eq!(env_of(&env, "E"), None);
    assert_eq!(env_of(&env, "lower"), None);
}
