//! The router and its state, apart from `main` so tests can serve it.

use axum::extract::{ConnectInfo, State};
use axum::http::Uri;
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::routing::get;
use axum::{Extension, Json, Router};
use canopy_core::scan::{DEFAULT_IGNORE, ScanOptions};
use canopy_core::store::{CanopyConfig, load_config};
use canopy_core::types::{LAUNCH_SOURCE, ScanResult, now_ms};
use canopy_core::version::{canopy_dir, read_build};
use futures_util::stream::{self, Stream, StreamExt};
use serde_json::{Value, json};
use std::convert::Infallible;
use std::net::SocketAddr;
use std::sync::Arc;
use std::time::Duration;
use tokio::sync::{RwLock, broadcast};
use tokio_stream::wrappers::BroadcastStream;
use tower_http::services::{ServeDir, ServeFile};

use crate::gate::{self, GateCaller, Gatekeeper};
use crate::gated::{self, Gates};
use crate::harnesses::backend_caps;
use crate::notes::{Notes, TICK_EVERY, remind_every};
use crate::people::People;
use crate::presence::{Presence, TELL_AFTER, parse_stream};
use crate::routes::client_key;
use crate::routes::first_load;
use crate::tree::build_tree;

type ConfigFn = dyn Fn() -> Result<CanopyConfig, String> + Send + Sync;
type HarnessesFn = dyn Fn() -> Vec<&'static str> + Send + Sync;

/// how often the stream says it is alive, as a named event the page sees
pub const PING_EVERY: Duration = Duration::from_secs(25);

/// What a server is started on.
pub struct Setup {
    pub root: String,
    pub config_dir: String,
    pub about: Value,
    /// read before each scan and each config route, so an edit takes at once
    pub config: Box<ConfigFn>,
    /// the harnesses this backend offers now
    pub harnesses: Box<HarnessesFn>,
    pub people: Arc<People>,
    /// what this machine has for the routes it gates
    pub gates: Gates,
}

pub struct AppState {
    pub root: String,
    pub config_dir: String,
    pub hostname: String,
    pub config: Box<ConfigFn>,
    harnesses: Box<HarnessesFn>,
    pub result: RwLock<ScanResult>,
    pub about: Value,
    /// every frame the `/api/events` streams send, as JSON text
    pub events: broadcast::Sender<String>,
    pub people: Arc<People>,
    /// the container's default gateway, which docker's proxy hands every
    /// client as its address (Linux only)
    pub gateway: Option<String>,
    pub gates: Gates,
    /// the pages' event streams and the browsers they say they are
    pub presence: Presence,
    /// quick notes, whose reminders `start` sets on the trigger tick
    pub notes: Arc<Notes>,
}

/// The config as the Bun server reads it.
pub fn read_config() -> Result<CanopyConfig, String> {
    load_config().map_err(|e| e.to_string())
}

/// The config's scan settings, as the Bun server reads them.
pub fn scan_options(cfg: &CanopyConfig) -> ScanOptions {
    let mut ignore: Vec<String> = DEFAULT_IGNORE.iter().map(|s| s.to_string()).collect();
    ignore.extend(cfg.ignore.iter().cloned());
    ScanOptions {
        max_depth: Some(cfg.max_depth),
        ignore: Some(ignore),
        tip_remotes: None,
    }
}

/// `os.hostname()`.
pub fn hostname() -> String {
    std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default()
}

/// The default route's gateway in `/proc/net/route` (`parseDefaultGateway`
/// in core/helper.ts): its little-endian hex as dotted octets.
pub fn parse_default_gateway(text: &str) -> Option<String> {
    for line in text.split('\n').skip(1) {
        let f: Vec<&str> = line.split_whitespace().collect();
        if f.len() < 3 || f[1] != "00000000" {
            continue;
        }
        let hex = f[2];
        if hex.len() != 8 || !hex.bytes().all(|b| b.is_ascii_hexdigit()) {
            continue;
        }
        let octets: Vec<String> = (0..4)
            .rev()
            .map(|i| {
                u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16)
                    .unwrap_or(0)
                    .to_string()
            })
            .collect();
        return Some(octets.join("."));
    }
    None
}

fn default_gateway() -> Option<String> {
    if !cfg!(target_os = "linux") {
        return None;
    }
    std::fs::read_to_string("/proc/net/route")
        .ok()
        .and_then(|t| parse_default_gateway(&t))
}

impl AppState {
    /// The first tree built; a launch root that will not scan fails the
    /// start, as the Bun server's does.
    pub async fn start(s: Setup) -> Result<Self, String> {
        Self::start_with_tick(s, TICK_EVERY).await
    }

    /// `start` with the reminders looked at every `tick` (the trigger
    /// engine's 30 seconds in `start`; a test's own period).
    pub async fn start_with_tick(s: Setup, tick: std::time::Duration) -> Result<Self, String> {
        let cfg = (s.config)()?;
        let backend = backend_caps(&(s.harnesses)());
        let result = build_tree(
            &s.root,
            &s.config_dir,
            &cfg.raw,
            &scan_options(&cfg),
            backend,
            None,
        )
        .await;
        if let Some(e) = result
            .sources
            .iter()
            .find(|x| x.source.id == LAUNCH_SOURCE)
            .and_then(|x| x.error.clone())
        {
            return Err(e);
        }
        let (events, _) = broadcast::channel(64);
        let notes = Arc::new(Notes::new(&s.config_dir, events.clone()));
        tokio::spawn(remind_every(notes.clone(), tick));
        Ok(Self {
            root: s.root,
            config_dir: s.config_dir,
            hostname: hostname(),
            config: s.config,
            harnesses: s.harnesses,
            result: RwLock::new(result),
            about: s.about,
            events,
            people: s.people,
            gateway: default_gateway(),
            gates: s.gates,
            presence: Presence::default(),
            notes,
        })
    }

    pub fn backend(&self) -> Value {
        backend_caps(&(self.harnesses)())
    }

    /// Scan again and tell every stream.
    pub async fn rescan(&self) -> Result<(), String> {
        let cfg = (self.config)()?;
        let last = self.result.read().await.clone();
        let result = build_tree(
            &self.root,
            &self.config_dir,
            &cfg.raw,
            &scan_options(&cfg),
            self.backend(),
            Some(&last),
        )
        .await;
        let frame = json!({ "type": "scan", "result": &result }).to_string();
        *self.result.write().await = result;
        // no stream listening is not an error
        let _ = self.events.send(frame);
        Ok(())
    }
}

pub async fn rescan_every(state: Arc<AppState>, every: std::time::Duration) {
    let mut tick = tokio::time::interval(every);
    tick.tick().await;
    loop {
        tick.tick().await;
        if let Err(e) = state.rescan().await {
            eprintln!("canopy-server: rescan failed: {e}");
        }
    }
}

/// What `/api/about` says (`About` in src/core/types.ts).
pub fn about(root: &str) -> Value {
    let dir = canopy_dir();
    let build = read_build(&dir);
    let mut v = serde_json::to_value(&build).unwrap_or_else(|_| json!({}));
    let homepage = std::fs::read_to_string(format!("{dir}/package.json"))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|p| p.get("homepage").cloned())
        .unwrap_or(Value::Null);
    if let Some(m) = v.as_object_mut() {
        m.insert("startedAt".into(), json!(now_ms()));
        // the field names the runtime; this one is Rust, not Bun
        m.insert(
            "bun".into(),
            json!(format!("rust {}", env!("CARGO_PKG_VERSION"))),
        );
        m.insert(
            "platform".into(),
            json!(if cfg!(target_os = "macos") {
                "darwin"
            } else {
                std::env::consts::OS
            }),
        );
        m.insert(
            "arch".into(),
            json!(match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                a => a,
            }),
        );
        m.insert("hostname".into(), json!(hostname()));
        m.insert("root".into(), json!(root));
        m.insert("homepage".into(), homepage);
        m.insert("coordinator".into(), json!(false));
    }
    v
}

/// The tree, with what this backend can do as it stands now: the login
/// shell's answer may have come since the last scan.
async fn tree(State(s): State<Arc<AppState>>) -> Json<ScanResult> {
    let mut t = s.result.read().await.clone();
    t.backend = s.backend();
    Json(t)
}

async fn about_route(State(s): State<Arc<AppState>>) -> Json<Value> {
    Json(s.about.clone())
}

async fn sources(State(s): State<Arc<AppState>>) -> Json<Value> {
    Json(serde_json::to_value(&s.result.read().await.sources).unwrap_or(Value::Null))
}

/// The people list as every page gets it (`publish()`): `{ type, people, teams }`.
pub fn tell_people(s: &AppState, devices: &[Value]) {
    let here = s.people.here(devices, now_ms() as f64);
    let mut frame = serde_json::Map::new();
    frame.insert("type".into(), json!("people"));
    if let Value::Object(m) = here {
        frame.extend(m);
    }
    let _ = s.events.send(Value::Object(frame).to_string());
}

/// `tellDevices()`: the devices list and then the people, to every stream,
/// once no other open or close has come for 300 ms.
pub fn tell_devices(s: &Arc<AppState>) {
    let ticket = s.presence.changed();
    let Ok(rt) = tokio::runtime::Handle::try_current() else {
        return;
    };
    let s = s.clone();
    rt.spawn(async move {
        tokio::time::sleep(TELL_AFTER).await;
        if !s.presence.latest(ticket) {
            return;
        }
        let devices = s.presence.devices();
        let _ = s
            .events
            .send(json!({ "type": "devices", "devices": &devices }).to_string());
        s.people.saw_devices(&devices, now_ms() as f64);
        tell_people(&s, &devices);
    });
}

/// A stream's browser, let go when the stream is.
struct Closer {
    state: Arc<AppState>,
    key: Option<u64>,
}

impl Drop for Closer {
    fn drop(&mut self) {
        if let Some(k) = self.key
            && self.state.presence.close(k)
        {
            tell_devices(&self.state);
        }
    }
}

/// `: hello`, then every frame the server broadcasts, with a named `ping`
/// whenever the stream has been quiet for 25 seconds. A stream whose query
/// names its browser puts it on the devices list while it is open.
async fn events(
    State(s): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    caller: Option<Extension<GateCaller>>,
    uri: Uri,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let hello = stream::once(async { Ok(Event::default().comment("hello")) });
    // subscribed before the browser is told, so this stream hears it too
    let rx = s.events.subscribe();
    let address = client_key(&peer.ip().to_string());
    let opened =
        parse_stream(uri.query().unwrap_or(""), &address, now_ms() as f64).map(|mut st| {
            if let Some(Extension(GateCaller(c, mode))) = &caller {
                st.person =
                    canopy_auth::AuthPeople::me(&*s.people, c.as_ref(), *mode).map(|m| m.id);
            }
            s.presence.open(st)
        });
    if opened.is_some() {
        tell_devices(&s);
    }
    let closer = Closer {
        state: s.clone(),
        key: opened,
    };
    let frames = BroadcastStream::new(rx).filter_map(move |f| {
        let _held = &closer;
        async move { f.ok().map(|data| Ok(Event::default().data(data))) }
    });
    Sse::new(hello.chain(frames)).keep_alive(
        KeepAlive::new()
            .interval(PING_EVERY)
            .event(Event::default().event("ping").data("")),
    )
}

pub fn router(state: Arc<AppState>, keeper: Arc<Gatekeeper>, web: &str) -> Router {
    let page = ServeDir::new(web).fallback(ServeFile::new(format!("{web}/index.html")));
    Router::new()
        .route("/api/tree", get(tree))
        .route("/api/about", get(about_route))
        .route("/api/sources", get(sources))
        .route("/api/events", get(events))
        .merge(first_load())
        .merge(crate::settings_reads::routes())
        .merge(crate::work_reads::routes())
        .merge(crate::notes::routes())
        .merge(crate::terms::routes(&state, &keeper))
        .route("/api/{*rest}", axum::routing::any(gated::fallback))
        .fallback_service(page)
        .with_state(state)
        .layer(axum::middleware::from_fn_with_state(keeper, gate::check))
}

#[cfg(test)]
mod tests {
    use super::*;
    use canopy_auth::rights::CallerKind;
    use canopy_auth::{CallerBook, CallerGate, CallersMode, MintOpts, OriginPolicy};
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    struct Served {
        addr: String,
        keeper: Arc<Gatekeeper>,
        _root: tempfile::TempDir,
        _web: tempfile::TempDir,
    }

    /// A server on a scratch root, page and callers book, with the gate in
    /// `mode` and nothing read from the environment.
    async fn serve(mode: CallersMode, origins: &[&str]) -> Served {
        let off = Gates {
            tmux: false,
            chan: false,
            voice: false,
            evaluator: false,
        };
        serve_with(mode, origins, off).await
    }

    async fn serve_with(mode: CallersMode, origins: &[&str], gates: Gates) -> Served {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a/repo/.git")).unwrap();
        let web = tempfile::tempdir().unwrap();
        std::fs::write(
            web.path().join("index.html"),
            "<!doctype html><title>canopy</title>",
        )
        .unwrap();
        std::fs::write(web.path().join("app.js"), "console.log(1)").unwrap();
        // never the real config: defaults only
        let config_dir = root.path().join("config");
        std::fs::create_dir_all(&config_dir).unwrap();
        let config_dir = config_dir.to_str().unwrap().to_string();
        let state = Arc::new(
            AppState::start(Setup {
                root: root.path().to_str().unwrap().into(),
                config_dir: config_dir.clone(),
                about: about("/r"),
                config: Box::new(|| Ok(CanopyConfig::default())),
                harnesses: Box::new(|| vec!["claude"]),
                people: Arc::new(People::new(&config_dir)),
                gates,
            })
            .await
            .unwrap(),
        );
        let book = CallerBook::open(root.path().join("callers.json"));
        let keeper = Arc::new(Gatekeeper {
            gate: CallerGate::new(Arc::new(book), mode, Arc::new(|_: &str| {})),
            policy: OriginPolicy {
                origins: origins.iter().map(|o| o.to_string()).collect(),
                ..Default::default()
            },
            beyond_loopback: false,
            loopback_wanted: false,
            people: Some(state.people.clone()),
        });
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let addr = listener.local_addr().unwrap().to_string();
        let app = router(state, keeper.clone(), web.path().to_str().unwrap());
        tokio::spawn(async move {
            axum::serve(
                listener,
                app.into_make_service_with_connect_info::<std::net::SocketAddr>(),
            )
            .await
            .unwrap()
        });
        Served {
            addr,
            keeper,
            _root: root,
            _web: web,
        }
    }

    /// One HTTP/1.1 request with extra header lines; the reply as text, cut
    /// off after `limit` bytes.
    async fn req(addr: &str, method: &str, path: &str, headers: &[&str], limit: usize) -> String {
        let extra: String = headers.iter().map(|h| format!("{h}\r\n")).collect();
        let raw =
            format!("{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\n{extra}\r\n");
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(raw.as_bytes()).await.unwrap();
        let mut buf = vec![0u8; limit];
        let mut n = 0;
        while n < limit {
            match tokio::time::timeout(std::time::Duration::from_secs(5), s.read(&mut buf[n..]))
                .await
            {
                Ok(Ok(0)) | Err(_) => break,
                Ok(Ok(k)) => n += k,
                Ok(Err(_)) => break,
            }
        }
        String::from_utf8_lossy(&buf[..n]).into_owned()
    }

    async fn get(addr: &str, path: &str, limit: usize) -> String {
        req(addr, "GET", path, &[], limit).await
    }

    #[tokio::test]
    async fn a_stream_that_names_its_browser_is_on_the_devices_list_while_open() {
        let s = serve(CallersMode::Log, &[]).await;
        let addr = s.addr.clone();
        let mut sse = tokio::net::TcpStream::connect(&addr).await.unwrap();
        let open = format!(
            "GET /api/events?client=0123456789abcdef&name=desk&platform=mac HTTP/1.1\r\nHost: {addr}\r\n\r\n"
        );
        sse.write_all(open.as_bytes()).await.unwrap();
        // the stream hears the devices list once the change has settled
        let mut heard = String::new();
        let mut buf = [0u8; 4096];
        while !heard.contains(r#""type":"people""#) {
            match tokio::time::timeout(std::time::Duration::from_secs(3), sse.read(&mut buf)).await
            {
                Ok(Ok(n)) if n > 0 => heard.push_str(&String::from_utf8_lossy(&buf[..n])),
                _ => panic!("no devices frame: {heard}"),
            }
        }
        assert!(heard.contains(r#"data: {"type":"devices","devices":[{"id":"0123456789abcdef","name":"desk","platform":"mac","address":"127.0.0.1""#), "{heard}");
        let devices = body(&get(&addr, "/api/devices", 1 << 14).await);
        assert_eq!(devices[0]["person"], "owner");
        assert_eq!(devices[0]["streams"], 1);
        // its person says which repos it has open
        let said = r#"{"client":"0123456789abcdef","repos":["a/repo","a/repo","b"]}"#;
        let len = format!("Content-Length: {}", said.len());
        let mut post = tokio::net::TcpStream::connect(&addr).await.unwrap();
        let raw = format!(
            "POST /api/people/at HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Type: application/json\r\n{len}\r\n\r\n{said}"
        );
        post.write_all(raw.as_bytes()).await.unwrap();
        let mut answer = String::new();
        post.read_to_string(&mut answer).await.unwrap();
        assert!(
            answer.starts_with("HTTP/1.1 200") && answer.contains(r#"{"ok":true}"#),
            "{answer}"
        );
        let people = body(&get(&addr, "/api/people", 1 << 14).await);
        assert_eq!(
            people["people"][0]["devices"],
            json!([{ "id": "0123456789abcdef", "name": "desk", "platform": "mac" }])
        );
        assert_eq!(people["people"][0]["at"], json!(["a/repo", "b"]));
        drop(sse);
        let mut gone = false;
        for _ in 0..40 {
            tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            if body(&get(&addr, "/api/devices", 1 << 14).await) == json!([]) {
                gone = true;
                break;
            }
        }
        assert!(gone, "the device outlived its stream");
        let bad = r#"{"client":"nope","repos":[]}"#;
        let len = format!("Content-Length: {}", bad.len());
        let mut post = tokio::net::TcpStream::connect(&addr).await.unwrap();
        let raw = format!(
            "POST /api/people/at HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Type: application/json\r\n{len}\r\n\r\n{bad}"
        );
        post.write_all(raw.as_bytes()).await.unwrap();
        let mut answer = String::new();
        post.read_to_string(&mut answer).await.unwrap();
        assert!(answer.starts_with("HTTP/1.1 400"), "{answer}");
    }

    #[tokio::test]
    async fn serves_the_page_the_tree_and_the_stream() {
        let s = serve(CallersMode::Log, &[]).await;
        let addr = s.addr.as_str();
        let tree = get(addr, "/api/tree", 1 << 16).await;
        assert!(tree.starts_with("HTTP/1.1 200"), "{tree}");
        assert!(tree.contains(r#""id":"a/repo""#), "{tree}");
        let about = get(addr, "/api/about", 1 << 14).await;
        assert!(
            about.contains(r#""root":"/r""#) && about.contains(r#""version":"#),
            "{about}"
        );
        let page = get(addr, "/", 1 << 14).await;
        assert!(page.contains("<title>canopy</title>"), "{page}");
        let deep = get(addr, "/some/view", 1 << 14).await;
        assert!(
            deep.contains("<title>canopy</title>"),
            "a client route falls back to the page: {deep}"
        );
        assert!(
            get(addr, "/app.js", 1 << 14)
                .await
                .contains("console.log(1)")
        );
        let other = get(addr, "/api/capacity", 1 << 14).await;
        assert!(
            other.starts_with("HTTP/1.1 501") && other.contains("not in the Rust port yet"),
            "{other}"
        );
        let events = get(addr, "/api/events", 256).await;
        assert!(
            events.contains("text/event-stream") && events.contains(": hello"),
            "{events}"
        );
        assert!(
            tree.contains(r#""id":"trees""#) && tree.contains(r#""harnesses":["claude"]"#),
            "{tree}"
        );
    }

    /// The body of a reply, after its headers.
    fn body(reply: &str) -> serde_json::Value {
        let (_, b) = reply.split_once("\r\n\r\n").unwrap_or(("", ""));
        serde_json::from_str(b).unwrap_or_else(|e| panic!("{e}: {reply}"))
    }

    #[tokio::test]
    async fn what_this_port_cannot_read_yet_answers_501_not_an_empty_list() {
        let tmux = Gates {
            tmux: true,
            chan: true,
            voice: false,
            evaluator: true,
        };
        let s = serve_with(CallersMode::Log, &[], tmux).await;
        let addr = s.addr.as_str();
        for path in ["/api/runs?kept=1", "/api/verdict", "/api/agents/pulse"] {
            let r = get(addr, path, 1 << 14).await;
            assert!(r.starts_with("HTTP/1.1 501"), "{path}: {r}");
        }
        // the shells under tmux are read (terms.rs): a tmux server on the
        // scratch config dir that has not started holds none
        for path in ["/api/terms", "/api/terms/kept"] {
            let r = get(addr, path, 1 << 14).await;
            assert!(r.starts_with("HTTP/1.1 200"), "{path}: {r}");
        }
        // flow records on disk would come back as the Bun server's flows
        let flows = s._root.path().join("config/flows");
        std::fs::create_dir_all(&flows).unwrap();
        std::fs::write(flows.join("f-1.json"), "{}").unwrap();
        for path in ["/api/flows", "/api/fleets"] {
            let r = get(addr, path, 1 << 14).await;
            assert!(r.starts_with("HTTP/1.1 501"), "{path}: {r}");
        }
        let r = get(addr, "/api/people/at", 1 << 14).await;
        assert!(r.starts_with("HTTP/1.1 404"), "{r}");
        let r = get(addr, "/api/runs?kept=0", 1 << 14).await;
        assert!(r.starts_with("HTTP/1.1 200"), "{r}");
    }

    #[tokio::test]
    async fn the_first_load_reads_answer_what_a_backend_that_runs_nothing_answers() {
        let s = serve(CallersMode::Log, &[]).await;
        let addr = s.addr.as_str();
        for path in [
            "/api/runs",
            "/api/flows",
            "/api/fleets",
            "/api/jobs",
            "/api/terms",
            "/api/helpers",
            "/api/devices",
        ] {
            let r = get(addr, path, 1 << 14).await;
            assert!(r.starts_with("HTTP/1.1 200"), "{path}: {r}");
            assert_eq!(body(&r), json!([]), "{path}");
        }
        assert_eq!(
            body(&get(addr, "/api/verdict", 1 << 14).await),
            json!({ "ready": false })
        );
        assert_eq!(
            body(&get(addr, "/api/workspaces", 1 << 14).await),
            json!([])
        );
        assert_eq!(body(&get(addr, "/api/launchers", 1 << 14).await), json!({}));
        assert_eq!(
            body(&get(addr, "/api/terms/kept", 1 << 14).await),
            json!({ "keeping": false, "kept": [] })
        );
        let backends = body(&get(addr, "/api/backends", 1 << 14).await);
        assert_eq!(backends["backends"], json!([]));
        assert!(backends["self"].as_str().is_some_and(|n| !n.is_empty()));
        let agents = body(&get(addr, "/api/agents", 1 << 14).await);
        assert_eq!(agents["profiles"]["default"]["harness"], "claude");
        // a test request comes from loopback by a loopback name, but no
        // desktop is local to a test's backend unless it is a Mac's
        let client = body(&get(addr, "/api/client", 1 << 14).await);
        assert_eq!(client["address"], "127.0.0.1");
        assert_eq!(client["shared"], false);
        let people = body(&get(addr, "/api/people", 1 << 14).await);
        assert_eq!(people["people"][0]["id"], "owner");
        // another method on a ported path is still the Bun server's
        let post = req(addr, "POST", "/api/runs", &["Content-Length: 0"], 1 << 14).await;
        assert!(post.starts_with("HTTP/1.1 501"), "{post}");
        let join = req(
            addr,
            "POST",
            "/api/auth/join",
            &["Content-Length: 0"],
            1 << 14,
        )
        .await;
        assert!(join.starts_with("HTTP/1.1 501"), "{join}");
    }

    #[tokio::test]
    async fn enforce_wants_a_token_and_takes_one() {
        let s = serve(CallersMode::Enforce, &[]).await;
        let bare = get(&s.addr, "/api/tree", 1 << 14).await;
        assert!(
            !bare.starts_with("HTTP/1.1 200") && bare.contains(r#""error""#),
            "{bare}"
        );
        let minted = s
            .keeper
            .gate
            .book
            .mint(CallerKind::Page, MintOpts::label("a page"));
        let header = format!("X-Canopy-Token: {}", minted.token);
        let with = req(&s.addr, "GET", "/api/tree", &[&header], 1 << 16).await;
        assert!(with.starts_with("HTTP/1.1 200"), "{with}");
        // the page's own files need no token
        assert!(get(&s.addr, "/", 1 << 14).await.starts_with("HTTP/1.1 200"));
        // GET /api/auth answers who is asking, from the ported auth routes
        let auth = req(&s.addr, "GET", "/api/auth", &[&header], 1 << 16).await;
        assert!(
            auth.starts_with("HTTP/1.1 200") && auth.contains(r#""mode":"enforce""#),
            "{auth}"
        );
    }

    #[tokio::test]
    async fn a_foreign_page_is_turned_away() {
        let s = serve(CallersMode::Log, &["https://ok.test"]).await;
        let evil = req(
            &s.addr,
            "GET",
            "/api/tree",
            &["Origin: https://evil.test", "Sec-Fetch-Site: cross-site"],
            1 << 14,
        )
        .await;
        assert!(
            evil.starts_with("HTTP/1.1 403") && evil.contains("Foreign origin"),
            "{evil}"
        );
        let pre = req(
            &s.addr,
            "OPTIONS",
            "/api/tree",
            &["Origin: https://ok.test"],
            1 << 14,
        )
        .await;
        assert!(pre.starts_with("HTTP/1.1 204"), "{pre}");
        assert!(
            pre.to_ascii_lowercase()
                .contains("access-control-allow-origin: https://ok.test"),
            "{pre}"
        );
        let listed = req(
            &s.addr,
            "GET",
            "/api/about",
            &["Origin: https://ok.test", "Sec-Fetch-Site: cross-site"],
            1 << 14,
        )
        .await;
        assert!(
            listed.starts_with("HTTP/1.1 200")
                && listed
                    .to_ascii_lowercase()
                    .contains("access-control-allow-origin: https://ok.test"),
            "{listed}"
        );
        let bad = req(
            &s.addr,
            "OPTIONS",
            "/api/tree",
            &["Origin: https://evil.test"],
            1 << 14,
        )
        .await;
        assert!(
            bad.starts_with("HTTP/1.1 403") && bad.contains("Foreign origin"),
            "{bad}"
        );
        assert!(
            req(&s.addr, "OPTIONS", "/index.html", &[], 1 << 14)
                .await
                .starts_with("HTTP/1.1 405")
        );
    }

    async fn send(addr: &str, method: &str, path: &str, body: &str) -> String {
        let raw = format!(
            "{method} {path} HTTP/1.1\r\nHost: {addr}\r\nConnection: close\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        );
        let mut s = tokio::net::TcpStream::connect(addr).await.unwrap();
        s.write_all(raw.as_bytes()).await.unwrap();
        let mut answer = String::new();
        s.read_to_string(&mut answer).await.unwrap();
        answer
    }

    #[tokio::test]
    async fn the_notes_routes_answer_over_the_socket_with_the_scans_repos() {
        let s = serve(CallersMode::Log, &[]).await;
        let addr = s.addr.as_str();
        let root = s._root.path().to_str().unwrap().to_string();
        let added = send(
            addr,
            "POST",
            "/api/notes",
            &format!(r#"{{"text":"x","repo":"{root}/a/repo"}}"#),
        )
        .await;
        assert!(added.starts_with("HTTP/1.1 200"), "{added}");
        assert_eq!(body(&added)["repoId"], "a/repo");
        let id = body(&added)["id"].as_str().unwrap().to_string();
        assert!(canopy_core::notes::is_note_id(&id));
        let list = body(&get(addr, "/api/notes", 1 << 14).await);
        assert_eq!(list["notes"][0]["id"], id.as_str());
        for path in ["/api/notes/", "/api/notes/other"] {
            let r = get(addr, path, 1 << 14).await;
            assert!(
                r.starts_with("HTTP/1.1 404") && r.contains("not found"),
                "{path}: {r}"
            );
        }
        let done = send(
            addr,
            "POST",
            "/api/notes/done",
            &format!(r#"{{"id":"{id}"}}"#),
        )
        .await;
        assert!(done.starts_with("HTTP/1.1 200"), "{done}");
        let gone = send(addr, "DELETE", &format!("/api/notes?id={id}"), "").await;
        assert!(
            gone.starts_with("HTTP/1.1 200") && gone.contains(r#"{"ok":true}"#),
            "{gone}"
        );
        assert_eq!(
            body(&get(addr, "/api/notes", 1 << 14).await),
            json!({ "notes": [] })
        );
    }

    /// The next notes frame the stream carries within `wait` of real time,
    /// past any other frame.
    async fn notes_frame(rx: &mut broadcast::Receiver<String>, wait: Duration) -> Option<String> {
        let deadline = std::time::Instant::now() + wait;
        while std::time::Instant::now() < deadline {
            match tokio::time::timeout(Duration::from_millis(50), rx.recv()).await {
                Ok(Ok(f)) if f.contains(r#""type":"notes""#) => return Some(f),
                Ok(Err(broadcast::error::RecvError::Closed)) => return None,
                _ => {}
            }
        }
        None
    }

    #[tokio::test]
    async fn a_due_reminder_is_marked_and_broadcast_once_on_the_trigger_tick() {
        let root = tempfile::tempdir().unwrap();
        std::fs::create_dir_all(root.path().join("a/repo/.git")).unwrap();
        let config = root.path().join("config");
        std::fs::create_dir_all(&config).unwrap();
        let seeded = r#"[{"id":"n-dueaaaaa","text":"call the bank","createdAt":1,"due":1000},{"id":"n-plainaaa","text":"a thought","createdAt":2}]"#;
        std::fs::write(config.join("notes.json"), seeded).unwrap();
        let config_dir = config.to_str().unwrap().to_string();
        // start() looks every TICK_EVERY; this runs the same loop on a short
        // real period, since a paused clock raced with the loop's first poll
        let tick = Duration::from_millis(200);
        let state = AppState::start_with_tick(
            Setup {
                root: root.path().to_str().unwrap().into(),
                config_dir: config_dir.clone(),
                about: about("/r"),
                config: Box::new(|| Ok(CanopyConfig::default())),
                harnesses: Box::new(|| vec!["claude"]),
                people: Arc::new(People::new(&config_dir)),
                gates: Gates {
                    tmux: false,
                    chan: false,
                    voice: false,
                    evaluator: false,
                },
            },
            tick,
        )
        .await
        .unwrap();
        let mut rx = state.events.subscribe();
        // nothing before the first tick, a whole period after the start
        assert!(
            notes_frame(&mut rx, tick / 4).await.is_none(),
            "a reminder before the first tick"
        );
        let frame = notes_frame(&mut rx, Duration::from_secs(15))
            .await
            .expect("no notes frame");
        let frame: Value = serde_json::from_str(&frame).unwrap();
        let reminded = frame["notes"][0]["remindedAt"].clone();
        assert!(reminded.as_f64().is_some_and(|t| t > 1000.0), "{frame}");
        assert!(frame["notes"][1].get("remindedAt").is_none());
        let file: Value =
            serde_json::from_str(&std::fs::read_to_string(config.join("notes.json")).unwrap())
                .unwrap();
        assert_eq!(file, frame["notes"]);
        // the next ticks find it delivered
        assert!(
            notes_frame(&mut rx, tick * 4).await.is_none(),
            "delivered more than once"
        );
        let again: Value =
            serde_json::from_str(&std::fs::read_to_string(config.join("notes.json")).unwrap())
                .unwrap();
        assert_eq!(again[0]["remindedAt"], reminded);
    }
}
