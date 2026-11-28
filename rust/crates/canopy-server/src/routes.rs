//! The read routes the page calls on its first load (src/server/index.ts),
//! in three kinds. The config's own lists (backends, workspaces, launchers,
//! agent routing, kept shells, people) are read the way the Bun server
//! reads them; quick notes have a module of their own (`notes.rs`). The devices list and where each browser is come
//! from the pages' event streams, as they do there. The other live lists
//! (runs, flows, fleets, jobs, helpers, agent pulses) are state the Bun
//! server holds for the work it runs; this port runs none yet, so they
//! answer what a Bun server that runs nothing answers. Where that answer
//! would not be true (the kept runs), the route answers 501, and so does
//! any other method on these paths. The shells and the kept shells are
//! `terms.rs`'s.

use axum::extract::{ConnectInfo, State};
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::response::{IntoResponse, Response};
use axum::routing::{MethodRouter, get};
use axum::{Extension, Json, Router};
use canopy_auth::is_loopback;
use canopy_core::backends::{config_self, normalize_backends, self_name};
use canopy_core::launch::normalize_launchers;
use canopy_core::route::Routing;
use canopy_core::store::workspaces;
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
pub(crate) fn read<H, T>(h: H) -> MethodRouter<Arc<AppState>>
where
    H: axum::handler::Handler<T, Arc<AppState>>,
    T: 'static,
{
    get(h).fallback(not_ported)
}

/// a config that will not read, as the Bun server's 500 says it
pub(crate) type Refusal = (StatusCode, Json<Value>);

pub(crate) async fn config(s: &AppState) -> Result<Value, Refusal> {
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

/// `GET /api/runs`: no live run here. `?kept=1` is the runs kept in the run
/// log, which this port does not read yet.
async fn runs(method: Method, uri: Uri) -> Response {
    let kept = form_urlencoded::parse(uri.query().unwrap_or("").as_bytes())
        .find(|(k, _)| k == "kept")
        .is_some_and(|(_, v)| v == "1");
    if kept {
        return not_ported(method, uri).await;
    }
    Json(json!([])).into_response()
}

/// The empty list a backend that runs nothing answers.
async fn none() -> Json<Value> {
    Json(json!([]))
}

/// `flows.hasEvaluator`: false without a gateway key. With one the Bun
/// server's flows can ask the evaluator, and this port runs no flows yet.
async fn verdict(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    if s.gates.evaluator {
        return not_ported(method, uri).await;
    }
    Json(json!({ "ready": false })).into_response()
}

/// The agents' pulses read the broker's cards; without a broker there are
/// none, and with one this port does not read them yet.
async fn pulse(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    if s.gates.chan {
        return not_ported(method, uri).await;
    }
    Json(json!({ "pulses": [] })).into_response()
}

/// Whether a folder lists an entry ending in `.json`: a record some keeper
/// of the Bun server's reads back at its start.
pub(crate) fn has_json(dir: &str) -> bool {
    std::fs::read_dir(dir).is_ok_and(|d| {
        d.flatten()
            .any(|e| e.file_name().to_string_lossy().ends_with(".json"))
    })
}

/// Whether `<config>/flows` holds a flow record, which the Bun server
/// takes back at its start (`loadFlowRecords`), fleets with it.
fn flow_records(config_dir: &str) -> bool {
    has_json(&format!("{config_dir}/flows"))
}

/// `GET /api/flows` and `/api/fleets`: none here, unless the config dir
/// keeps flow records the Bun server would have taken back.
async fn flows(State(s): State<Arc<AppState>>, method: Method, uri: Uri) -> Response {
    if flow_records(&s.config_dir) {
        return not_ported(method, uri).await;
    }
    Json(json!([])).into_response()
}

/// Any method but POST on a people path: the Bun server's 404.
async fn not_found() -> Response {
    (StatusCode::NOT_FOUND, Json(json!({ "error": "not found" }))).into_response()
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
    let caller = caller.and_then(|Extension(GateCaller(c, _))| c);
    let devices = s.presence.devices();
    Json(s.people.info(caller.as_ref(), &devices, now_ms() as f64))
}

/// `GET /api/devices`: the browsers on the event stream now.
async fn devices(State(s): State<Arc<AppState>>) -> Json<Value> {
    Json(Value::from(s.presence.devices()))
}

/// `POST /api/people/at`: the repos a browser has open.
async fn place(
    State(s): State<Arc<AppState>>,
    caller: Option<Extension<GateCaller>>,
    body: axum::body::Bytes,
) -> Response {
    let caller = caller.and_then(|Extension(GateCaller(c, _))| c);
    let body: Value = serde_json::from_slice(&body).unwrap_or(Value::Null);
    let devices = s.presence.devices();
    let r = s
        .people
        .at(caller.as_ref(), &body, &devices, now_ms() as f64);
    if r.publish {
        crate::app::tell_people(&s, &devices);
    }
    let status = StatusCode::from_u16(r.status).unwrap_or(StatusCode::OK);
    (status, Json(r.body)).into_response()
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
        .route("/api/peers", read(peers))
        .route("/api/layouts", read(layouts))
        .route("/api/backends", read(backends))
        .route("/api/workspaces", read(workspaces_route))
        .route("/api/launchers", read(launchers))
        .route("/api/agents", read(agents))
        .route("/api/people", read(people))
        .route("/api/client", read(client))
        .route("/api/verdict", read(verdict))
        .route("/api/agents/pulse", read(pulse))
        .route("/api/runs", read(runs))
        .route("/api/flows", read(flows))
        .route("/api/fleets", read(flows))
        .route("/api/jobs", read(none))
        .route("/api/helpers", read(none))
        .route("/api/devices", read(devices))
        .route(
            "/api/people/at",
            axum::routing::post(place).fallback(not_found),
        )
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
