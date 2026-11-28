//! The router and its state, apart from `main` so tests can serve it.

use axum::extract::State;
use axum::http::{Method, StatusCode, Uri};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{IntoResponse, Response};
use axum::routing::get;
use axum::{Json, Router};
use canopy_core::scan::{DEFAULT_IGNORE, ScanOptions, scan};
use canopy_core::store::load_config;
use canopy_core::types::{ScanResult, now_ms};
use canopy_core::version::{canopy_dir, read_build};
use futures_util::stream::{self, Stream, StreamExt};
use serde_json::{Value, json};
use std::convert::Infallible;
use std::sync::Arc;
use tokio::sync::{RwLock, broadcast};
use tokio_stream::wrappers::BroadcastStream;
use tower_http::services::{ServeDir, ServeFile};

use crate::gate::{self, Gatekeeper};

type Options = dyn Fn() -> Result<ScanOptions, String> + Send + Sync;

pub struct AppState {
    pub root: String,
    /// read before each scan, so a config edit takes at the next one
    options: Box<Options>,
    pub result: RwLock<ScanResult>,
    pub about: Value,
    /// every frame the `/api/events` streams send, as JSON text
    pub events: broadcast::Sender<String>,
}

/// The config's scan settings, as the Bun server reads them.
pub fn scan_options() -> Result<ScanOptions, String> {
    let cfg = load_config().map_err(|e| e.to_string())?;
    let mut ignore: Vec<String> = DEFAULT_IGNORE.iter().map(|s| s.to_string()).collect();
    ignore.extend(cfg.ignore);
    Ok(ScanOptions {
        max_depth: Some(cfg.max_depth),
        ignore: Some(ignore),
        tip_remotes: None,
    })
}

impl AppState {
    pub async fn start(root: &str, about: Value, options: Box<Options>) -> Result<Self, String> {
        let result = scan(root, &options()?).await?;
        let (events, _) = broadcast::channel(64);
        Ok(Self {
            root: root.into(),
            options,
            result: RwLock::new(result),
            about,
            events,
        })
    }

    /// Scan again and tell every stream.
    pub async fn rescan(&self) -> Result<(), String> {
        let result = scan(&self.root, &(self.options)()?).await?;
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
    let build = read_build(&canopy_dir());
    let mut v = serde_json::to_value(&build).unwrap_or_else(|_| json!({}));
    let host = std::process::Command::new("hostname")
        .output()
        .ok()
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .unwrap_or_default();
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
        m.insert("hostname".into(), json!(host));
        m.insert("root".into(), json!(root));
        m.insert("homepage".into(), Value::Null);
        m.insert("coordinator".into(), json!(false));
    }
    v
}

async fn tree(State(s): State<Arc<AppState>>) -> Json<ScanResult> {
    Json(s.result.read().await.clone())
}

async fn about_route(State(s): State<Arc<AppState>>) -> Json<Value> {
    Json(s.about.clone())
}

async fn sources(State(s): State<Arc<AppState>>) -> Json<Value> {
    Json(serde_json::to_value(&s.result.read().await.sources).unwrap_or(Value::Null))
}

/// `: hello`, then every frame the server broadcasts.
async fn events(
    State(s): State<Arc<AppState>>,
) -> Sse<impl Stream<Item = Result<Event, Infallible>>> {
    let hello = stream::once(async { Ok(Event::default().comment("hello")) });
    let frames = BroadcastStream::new(s.events.subscribe())
        .filter_map(|f| async move { f.ok().map(|data| Ok(Event::default().data(data))) });
    Sse::new(hello.chain(frames)).keep_alive(KeepAlive::default())
}

/// An API path this port does not answer yet: say so plainly.
async fn not_ported(method: Method, uri: Uri) -> Response {
    let body = json!({ "error": format!("{method} {} is not in the Rust port yet", uri.path()) });
    (StatusCode::NOT_IMPLEMENTED, Json(body)).into_response()
}

pub fn router(state: Arc<AppState>, keeper: Arc<Gatekeeper>, web: &str) -> Router {
    let page = ServeDir::new(web).fallback(ServeFile::new(format!("{web}/index.html")));
    Router::new()
        .route("/api/tree", get(tree))
        .route("/api/about", get(about_route))
        .route("/api/sources", get(sources))
        .route("/api/events", get(events))
        .route("/api/{*rest}", axum::routing::any(not_ported))
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
        let state = Arc::new(
            AppState::start(
                root.path().to_str().unwrap(),
                about("/r"),
                Box::new(|| Ok(ScanOptions::default())),
            )
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
        let other = get(addr, "/api/runs", 1 << 14).await;
        assert!(
            other.starts_with("HTTP/1.1 501") && other.contains("not in the Rust port yet"),
            "{other}"
        );
        let events = get(addr, "/api/events", 256).await;
        assert!(
            events.contains("text/event-stream") && events.contains(": hello"),
            "{events}"
        );
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
}
