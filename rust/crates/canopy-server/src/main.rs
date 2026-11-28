//! `canopy-server`, the start of the Rust port of the Bun server
//! (`src/server/index.ts`). It scans the folders it is given and serves
//! the built page (`dist/web`) with the page's first reads: `/api/tree`,
//! `/api/about`, `/api/sources` and the `/api/events` stream. Nothing else
//! of the API is here yet; docs/rust-port.md has the ledger.
//!
//!   canopy-server [--port 7860] [--host 127.0.0.1] [--web dist/web] [dir]
//!
//! It defaults to port 7860 so it never takes the Bun server's 7850.

mod app;
mod gate;

use app::{AppState, about, rescan_every, scan_options};
use canopy_core::pathx::resolve;
use canopy_core::version::canopy_dir;
use std::net::SocketAddr;
use std::sync::Arc;

struct Args {
    port: u16,
    host: String,
    web: String,
    root: String,
}

fn parse_args(argv: &[String]) -> Result<Args, String> {
    let mut a = Args {
        port: 7860,
        host: "127.0.0.1".into(),
        web: format!("{}/dist/web", canopy_dir()),
        root: ".".into(),
    };
    let mut it = argv.iter();
    while let Some(arg) = it.next() {
        let mut value = |flag: &str| {
            it.next()
                .cloned()
                .ok_or_else(|| format!("{flag} needs a value"))
        };
        match arg.as_str() {
            "--port" => {
                a.port = value("--port")?
                    .parse()
                    .map_err(|_| "--port takes a number".to_string())?
            }
            "--host" => a.host = value("--host")?,
            "--web" => a.web = value("--web")?,
            s if s.starts_with('-') => return Err(format!("unknown flag: {s}")),
            s => a.root = s.to_string(),
        }
    }
    Ok(a)
}

#[tokio::main]
async fn main() -> std::process::ExitCode {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    let args = match parse_args(&argv) {
        Ok(a) => a,
        Err(e) => {
            eprintln!("canopy-server: {e}");
            return std::process::ExitCode::from(2);
        }
    };
    // the Bun server owns ~/.config/canopy; two servers writing callers.json
    // and the rest would corrupt them, so until the cutover this one runs only
    // on a config folder of its own
    if std::env::var("CANOPY_CONFIG_DIR").map_or(true, |d| d.is_empty()) {
        eprintln!(
            "canopy-server: set CANOPY_CONFIG_DIR to a folder of its own; the Bun server owns ~/.config/canopy until the cutover"
        );
        return std::process::ExitCode::from(2);
    }
    let root = resolve(&args.root);
    let state = match AppState::start(&root, about(&root), Box::new(scan_options)).await {
        Ok(s) => Arc::new(s),
        Err(e) => {
            eprintln!("canopy-server: {e}");
            return std::process::ExitCode::FAILURE;
        }
    };
    tokio::spawn(rescan_every(
        state.clone(),
        std::time::Duration::from_secs(30),
    ));
    let addr: SocketAddr = match format!("{}:{}", args.host, args.port).parse() {
        Ok(a) => a,
        Err(e) => {
            eprintln!("canopy-server: bad address: {e}");
            return std::process::ExitCode::from(2);
        }
    };
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            eprintln!("canopy-server: port {} is unavailable: {e}", args.port);
            return std::process::ExitCode::FAILURE;
        }
    };
    eprintln!("canopy-server on http://{addr} for {root}");
    let keeper = Arc::new(gate::Gatekeeper::from_env(
        canopy_auth::CallerBook::open_default(),
        &args.host,
    ));
    let app = app::router(state, keeper, &args.web);
    if let Err(e) = axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await
    {
        eprintln!("canopy-server: {e}");
        return std::process::ExitCode::FAILURE;
    }
    std::process::ExitCode::SUCCESS
}
