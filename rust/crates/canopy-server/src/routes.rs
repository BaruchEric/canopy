//! The read routes the page calls on its first load (src/server/index.ts),
//! in two kinds. The config's own lists (backends, workspaces, launchers,
//! agent routing, kept shells, people, quick notes) are read the way the
//! Bun server reads them. The live lists (runs, flows, fleets, jobs, shells, helpers,
//! devices, agent pulses) are state the Bun server holds in memory for the
//! work it runs; this port runs none yet, so they answer what a Bun server
//! that runs nothing answers. Any other method on these paths answers 501.

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, get};
use axum::{Extension, Json, Router};
use canopy_auth::is_loopback;
use canopy_core::backends::{config_self, normalize_backends, self_name};
use canopy_core::keep::{KEEP_DAYS, expired_shells, list_kept, lost_shells};
use canopy_core::launch::normalize_launchers;
use canopy_core::route::Routing;
use canopy_core::store::{flag, workspaces};
use canopy_core::types::now_ms;
use serde_json::{Value, json};
use std::net::SocketAddr;
use std::sync::Arc;

use crate::app::AppState;
use crate::gate::GateCaller;

/// An API path this port does not answer yet: say so plainly.
pub async fn not_ported(method: Method, uri: Uri) -> Response {
    let body = json!({ "error": format!("{method} {} is not in the Rust port yet", uri.path()) });
    (StatusCode::NOT_IMPLEMENTED, Json(body)).into_response()
}

/// A GET handler, with every other method still the Bun server's.
fn read<H, T>(h: H) -> MethodRouter<Arc<AppState>>
where
    H: axum::handler::Handler<T, Arc<AppState>>,
    T: 'static,
{
    get(h).fallback(not_ported)
}

/// a config that will not read, as the Bun server's 500 says it
type Refusal = (StatusCode, Json<Value>);

async fn config(s: &AppState) -> Result<Value, Refusal> {
    (s.config)().map(|c| c.raw).map_err(|e| {
        (
            StatusCode::INTERNAL_SERVER_ERROR,
            Json(json!({ "error": e })),
        )
    })
}

/// `{ self, backends }`: this backend's name and the others the page may
/// talk to.
async fn backends(State(s): State<Arc<AppState>>) -> Result<Json<Value>, Refusal> {
    let raw = config(&s).await?;
    let me = self_name(config_self(&raw).as_deref(), &s.hostname);
    let list = normalize_backends(raw.get("backends").unwrap_or(&Value::Null));
    Ok(Json(json!({ "self": me, "backends": list })))
}

async fn workspaces_route(State(s): State<Arc<AppState>>) -> Result<Json<Value>, Refusal> {
    Ok(Json(Value::from(workspaces(&config(&s).await?))))
}

async fn launchers(State(s): State<Arc<AppState>>) -> Result<Json<Value>, Refusal> {
    let raw = config(&s).await?;
    Ok(Json(Value::Object(normalize_launchers(
        raw.get("launchers").unwrap_or(&Value::Null),
    ))))
}

async fn agents(State(s): State<Arc<AppState>>) -> Result<Json<Value>, Refusal> {
    Ok(Json(Routing::from_config(&config(&s).await?).routes()))
}

/// The records on disk past neither retention window and answered by no
/// live shell (`refreshKept`). The Bun server deletes the expired records
/// as it reads; this port leaves them, and only leaves them out.
async fn kept(State(s): State<Arc<AppState>>) -> Result<Json<Value>, Refusal> {
    let raw = config(&s).await?;
    let all = list_kept(&s.config_dir);
    let gone = expired_shells(&all, now_ms() as f64, KEEP_DAYS);
    let left: Vec<_> = all.into_iter().filter(|k| !gone.contains(&k.id)).collect();
    // no shell is live here: tmux sessions are not ported yet
    let kept: Vec<Value> = lost_shells(&left, &[])
        .into_iter()
        .map(|k| k.json)
        .collect();
    Ok(Json(
        json!({ "keeping": flag(&raw, "keepShells", false), "kept": kept }),
    ))
}

/// The empty list a backend that runs nothing answers.
async fn none() -> Json<Value> {
    Json(json!([]))
}

/// No evaluator runs here (`flows.hasEvaluator`).
async fn verdict() -> Json<Value> {
    Json(json!({ "ready": false }))
}

async fn pulse() -> Json<Value> {
    Json(json!({ "pulses": [] }))
}

/// `clientKey`: an IPv4-mapped IPv6 address as the IPv4 it carries.
pub fn client_key(address: &str) -> String {
    let lower = address.to_ascii_lowercase();
    match lower.strip_prefix("::ffff:") {
        Some(v4) if v4.parse::<std::net::Ipv4Addr>().is_ok() => v4.to_string(),
        _ => address.to_string(),
    }
}

/// `isLoopbackHost` on the URL's hostname: localhost, [::1] or 127.x.
fn loopback_host(headers: &HeaderMap) -> bool {
    let host = headers
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    let name = if host.starts_with('[') {
        host.split(']')
            .next()
            .map(|h| format!("{h}]"))
            .unwrap_or_default()
    } else {
        host.split(':').next().unwrap_or("").to_ascii_lowercase()
    };
    name == "localhost"
        || name == "[::1]"
        || name.strip_prefix("127.").is_some_and(|r| {
            r.split('.').count() == 3
                && r.split('.')
                    .all(|p| !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()))
        })
}

/// What the backend knows of this browser (`clientInfo`): its address,
/// whether it is on this machine with a desktop, and whether the address is
/// the container gateway every client arrives from. The simulator list a
/// local browser gets is not ported yet.
async fn client(
    State(s): State<Arc<AppState>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    headers: HeaderMap,
) -> Json<Value> {
    let key = client_key(&peer.ip().to_string());
    let here = is_loopback(&key) && loopback_host(&headers);
    let local = here && crate::harnesses::host_openers();
    let shared = s.gateway.as_deref() == Some(key.as_str());
    Json(json!({ "address": key, "local": local, "shared": shared }))
}

/// `GET /api/people`, for the caller the gate found.
async fn people(
    State(s): State<Arc<AppState>>,
    caller: Option<Extension<GateCaller>>,
) -> Json<Value> {
    let caller = caller.and_then(|Extension(GateCaller(c))| c);
    Json(s.people.info(caller.as_ref(), now_ms() as f64))
}

/// `GET /api/notes`: `<config>/notes.json` read back. No file is no notes,
/// and so is a file that is not JSON; a file that will not read is an
/// error, as in the Bun server, which must not write one note over the rest.
async fn notes(State(s): State<Arc<AppState>>) -> Result<Json<Value>, Refusal> {
    let file = format!("{}/notes.json", s.config_dir);
    let notes = match std::fs::read_to_string(&file) {
        Ok(raw) => serde_json::from_str::<Value>(&raw)
            .map(|v| canopy_core::notes::parse_notes(&v))
            .unwrap_or_default(),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => vec![],
        Err(e) => {
            let error = format!("{e}, open '{file}'");
            return Err((
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({ "error": error })),
            ));
        }
    };
    Ok(Json(json!({ "notes": notes })))
}

/// `GET /api/layouts`: the presets and the user's own profiles from
/// `screen-layouts.json`. The Bun server reads the file once at its start;
/// this reads it at each call, so an edit by hand shows at once.
async fn layouts(State(s): State<Arc<AppState>>) -> Json<Value> {
    let raw = std::fs::read_to_string(format!("{}/screen-layouts.json", s.config_dir)).ok();
    let profiles = canopy_core::screenlayouts::list_profiles(raw.as_deref());
    Json(json!({ "profiles": profiles }))
}

/// `GET /api/peers` while peer sync is off: the config's peers and nothing
/// seen, since only a pass fills that in. With sync on or dry the Bun server
/// runs passes this port does not, so the route is not ported then.
async fn peers(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    let raw = match config(&s).await {
        Ok(raw) => raw,
        Err(e) => return e.into_response(),
    };
    let sync = canopy_core::peers::peer_sync(&raw);
    if sync != "off" {
        return not_ported(method, uri).await;
    }
    let list = canopy_core::peers::normalize_peers(raw.get("peers").unwrap_or(&Value::Null));
    let body = json!({ "self": config_self(&raw), "peers": list, "seen": [], "sync": sync, "root": s.root });
    Json(body).into_response()
}

pub fn first_load() -> Router<Arc<AppState>> {
    Router::new()
        .route("/api/notes", read(notes))
        .route("/api/peers", read(peers))
        .route("/api/layouts", read(layouts))
        .route("/api/backends", read(backends))
        .route("/api/workspaces", read(workspaces_route))
        .route("/api/launchers", read(launchers))
        .route("/api/agents", read(agents))
        .route("/api/terms/kept", read(kept))
        .route("/api/people", read(people))
        .route("/api/client", read(client))
        .route("/api/verdict", read(verdict))
        .route("/api/agents/pulse", read(pulse))
        .route("/api/runs", read(none))
        .route("/api/flows", read(none))
        .route("/api/fleets", read(none))
        .route("/api/jobs", read(none))
        .route("/api/terms", read(none))
        .route("/api/helpers", read(none))
        .route("/api/devices", read(none))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_mapped_address_is_the_ipv4_it_carries() {
        assert_eq!(client_key("::ffff:127.0.0.1"), "127.0.0.1");
        assert_eq!(client_key("::1"), "::1");
        assert_eq!(client_key("10.0.0.2"), "10.0.0.2");
    }

    #[test]
    fn a_loopback_host_is_localhost_ipv6_loopback_or_127() {
        let h = |v: &str| {
            let mut m = HeaderMap::new();
            m.insert("host", v.parse().unwrap());
            loopback_host(&m)
        };
        assert!(h("localhost:7850"));
        assert!(h("127.0.0.1:7850"));
        assert!(h("[::1]:7850"));
        assert!(!h("canopy.example.com"));
        assert!(!h("127.0.0:1"));
    }
}
