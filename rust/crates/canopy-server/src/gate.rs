//! The check every request passes before a handler, in the order the Bun
//! server's `fetch` and `route` run it (src/server/index.ts): the preflight,
//! who is calling, the lane, the rights gate, the origin gate, then the
//! auth routes. People's folder scopes and the Library are not ported yet.

use axum::Json;
use axum::body::{Body, to_bytes};
use axum::extract::{ConnectInfo, Request, State};
use axum::http::{HeaderName, HeaderValue, Method, StatusCode};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use canopy_auth::{
    Bypass, CallerBook, CallerGate, OriginPolicy, PREFLIGHT_HEADERS, Reply, Req, auth_route,
    caller_of, callers_mode_env, cors_headers, is_loopback, library_origin_allowed,
    loopback_auth_wanted_env, loopback_bypass, open_bind_env, parse_origins, return_leg,
};
use serde_json::json;
use std::net::SocketAddr;
use std::sync::Arc;

/// The largest body an auth route takes; they carry a label or a code.
const AUTH_BODY_MAX: usize = 64 * 1024;

pub struct Gatekeeper {
    pub gate: CallerGate,
    pub policy: OriginPolicy,
    pub beyond_loopback: bool,
    pub loopback_wanted: bool,
}

impl Gatekeeper {
    /// The gate as the environment sets it, over the book at `book`.
    pub fn from_env(book: CallerBook, host: &str) -> Gatekeeper {
        let open = open_bind_env() || !is_loopback(host);
        let policy = OriginPolicy {
            public_origin: std::env::var("CANOPY_PUBLIC_ORIGIN")
                .ok()
                .filter(|o| !o.is_empty()),
            open,
            origins: parse_origins(std::env::var("CANOPY_ORIGINS").ok().as_deref()),
            hosts: vec![],
        };
        let log: canopy_auth::gate::LogHook = Arc::new(|line: &str| eprintln!("{line}"));
        Gatekeeper {
            gate: CallerGate::new(Arc::new(book), callers_mode_env(), log),
            policy,
            beyond_loopback: open,
            loopback_wanted: loopback_auth_wanted_env(),
        }
    }
}

fn reply(r: Reply) -> Response {
    let status = StatusCode::from_u16(r.status).unwrap_or(StatusCode::INTERNAL_SERVER_ERROR);
    (status, Json(r.body)).into_response()
}

fn foreign() -> Response {
    reply(Reply::json(403, json!({ "error": "Foreign origin" })))
}

fn add_headers(res: &mut Response, headers: &[(&str, String)]) {
    for (k, v) in headers {
        if let (Ok(name), Ok(value)) = (HeaderName::try_from(*k), HeaderValue::from_str(v)) {
            res.headers_mut().insert(name, value);
        }
    }
}

/// The request as canopy-auth reads it: Bun's `req.url` is
/// `http://<Host><target>`, and the headers come along.
fn auth_req(req: &Request) -> Option<Req> {
    let host = req
        .headers()
        .get("host")
        .and_then(|h| h.to_str().ok())
        .unwrap_or("localhost");
    let target = req.uri().path_and_query().map_or("/", |p| p.as_str());
    let mut out = Req::from_target(req.method().as_str(), host, target).ok()?;
    for (k, v) in req.headers() {
        if let Ok(v) = v.to_str() {
            out = out.with_header(k.as_str(), v);
        }
    }
    Some(out)
}

pub async fn check(
    State(keeper): State<Arc<Gatekeeper>>,
    ConnectInfo(peer): ConnectInfo<SocketAddr>,
    req: Request,
    next: Next,
) -> Response {
    let api = req.uri().path().starts_with("/api/");
    let origin = req
        .headers()
        .get("origin")
        .and_then(|o| o.to_str().ok())
        .map(String::from);
    let cors = if api {
        cors_headers(origin.as_deref(), &keeper.policy.origins)
    } else {
        None
    };
    // a preflight runs nothing, and only a listed origin gets one
    if req.method() == Method::OPTIONS {
        if !api {
            return StatusCode::METHOD_NOT_ALLOWED.into_response();
        }
        let Some(cors) = cors else { return foreign() };
        let mut res = StatusCode::NO_CONTENT.into_response();
        add_headers(&mut res, &cors);
        add_headers(
            &mut res,
            &PREFLIGHT_HEADERS
                .iter()
                .map(|(k, v)| (*k, v.to_string()))
                .collect::<Vec<_>>(),
        );
        return res;
    }
    let Some(areq) = auth_req(&req) else {
        return reply(Reply::json(
            400,
            json!({ "error": "a request canopy cannot read" }),
        ));
    };
    let addr = peer.ip().to_string();
    let book = &keeper.gate.book;
    let mut caller = caller_of(book, &areq);
    if caller.is_none()
        && loopback_bypass(&Bypass {
            wanted: keeper.loopback_wanted,
            beyond_loopback: keeper.beyond_loopback,
            on_lane: false,
            upgrade: areq.header("upgrade").is_some(),
            sec_fetch_site: areq.header("sec-fetch-site").as_deref(),
            addr: &addr,
            hostname: areq.hostname(),
        })
    {
        caller = Some(book.local_caller());
    }
    if let Some(r) = keeper.gate.lane(&areq, caller.as_ref(), &addr, false) {
        return reply(r);
    }
    if let Some(r) = keeper.gate.gate(&areq, caller.as_ref()) {
        return reply(r);
    }
    if api && !library_origin_allowed(&return_leg(&areq), &keeper.policy) {
        return foreign();
    }
    let path = areq.path().to_string();
    let mut res = if path == "/api/auth" || path.starts_with("/api/auth/") {
        let (parts, body) = req.into_parts();
        let Ok(bytes) = to_bytes(body, AUTH_BODY_MAX).await else {
            return reply(Reply::json(
                413,
                json!({ "error": "that body is too large" }),
            ));
        };
        match auth_route(&keeper.gate, &areq, &bytes, caller.as_ref(), &addr, None) {
            Some(r) => reply(r),
            None => {
                next.run(Request::from_parts(parts, Body::from(bytes)))
                    .await
            }
        }
    } else {
        next.run(req).await
    };
    if let Some(cors) = cors {
        add_headers(&mut res, &cors);
    }
    res
}
