//! CORS for the other canopy pages allowed to drive this backend (port of
//! `src/core/cors.ts`).

use url::Url;

use crate::text::js_trim;

/// The origins another canopy page may drive this backend from, read off
/// `CANOPY_ORIGINS` (comma separated). Only exact http(s) origins survive, so
/// a typo cannot widen it and a `*` is never one.
pub fn parse_origins(raw: Option<&str>) -> Vec<String> {
    let Some(raw) = raw else { return Vec::new() };
    raw.split(',')
        .map(js_trim)
        .filter(|v| !v.is_empty())
        .filter(|v| {
            Url::parse(v).is_ok_and(|u| {
                matches!(u.scheme(), "http" | "https") && u.origin().ascii_serialization() == *v
            })
        })
        .map(str::to_string)
        .collect()
}

/// The CORS headers for a listed origin: that origin back, never `*`, with
/// credentials so the gate's cookie rides along. None for anything else.
pub fn cors_headers(
    origin: Option<&str>,
    origins: &[String],
) -> Option<Vec<(&'static str, String)>> {
    let origin = origin.filter(|o| origins.iter().any(|x| x == o))?;
    Some(vec![
        ("Access-Control-Allow-Origin", origin.to_string()),
        ("Access-Control-Allow-Credentials", "true".to_string()),
        ("Vary", "Origin".to_string()),
    ])
}

/// What a preflight from a listed origin is told on top of `cors_headers`:
/// the methods and the two headers the client sends.
pub const PREFLIGHT_HEADERS: [(&str, &str); 3] = [
    ("Access-Control-Allow-Methods", "GET, POST, DELETE, PATCH"),
    (
        "Access-Control-Allow-Headers",
        "content-type, x-canopy-token",
    ),
    ("Access-Control-Max-Age", "600"),
];
