//! The origin gate (port of the request checks in `src/core/library.ts`)
//! and the two loopback tests from `src/core/client.ts`.

use std::borrow::Cow;

use url::Url;

use crate::request::{Req, url_host};
use crate::text::{ascii_digits, js_trim};

/// Whether an address is the machine the server runs on.
pub fn is_loopback(address: &str) -> bool {
    address == "127.0.0.1"
        || address == "::1"
        || address == "::ffff:127.0.0.1"
        || address.starts_with("127.")
}

/// Whether a request's host is this machine by a loopback name. A proxy or
/// tunnel on the same machine also connects from loopback, but for a browser
/// that asked for the proxy's name, so the peer address alone cannot say the
/// browser is here.
pub fn is_loopback_host(hostname: &str) -> bool {
    if hostname == "localhost" || hostname == "[::1]" {
        return true;
    }
    let parts: Vec<&str> = hostname.split('.').collect();
    parts.len() == 4 && parts[0] == "127" && parts[1..].iter().all(|p| ascii_digits(p))
}

/// Whether a request's host is one the tailnet edge vouches for: a tailnet
/// address literal (100.64.0.0/10), a MagicDNS name (`*.ts.net`, or a bare
/// machine name with no dots, which no public resolver can point elsewhere).
/// A dotted public name is not, since an attacker's domain could resolve to
/// the same address and carry a matching Origin.
pub fn tailnet_host(hostname: &str) -> bool {
    let parts: Vec<&str> = hostname.split('.').collect();
    if parts.len() == 4 && parts[0] == "100" && parts[1..].iter().all(|p| ascii_digits(p)) {
        // any length of digits, as Number() reads them
        let second: f64 = parts[1].parse().unwrap_or(f64::INFINITY);
        return (64.0..=127.0).contains(&second);
    }
    hostname.ends_with(".ts.net") || (!hostname.contains('.') && !hostname.is_empty())
}

/// What the origin gate is told about this server.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct OriginPolicy {
    /// `CANOPY_PUBLIC_ORIGIN`: one HTTPS origin behind an authenticated
    /// reverse proxy
    pub public_origin: Option<String>,
    /// the server listens beyond loopback (`CANOPY_BIND`), so the tailnet is
    /// the trust edge
    pub open: bool,
    /// `CANOPY_ORIGINS`: other canopy pages allowed to drive this backend
    pub origins: Vec<String>,
    /// exact hosts a caller may name with no Origin or its own: the
    /// coordinator's address on its bridge's gateway (`coord_api_host`)
    pub hosts: Vec<String>,
}

/// Whether a request may reach the API or the Library from where it came.
/// A listed Origin passes even cross-site; a request with no Origin passes
/// when its Host is a listed origin's host and it is not marked cross-site.
/// Otherwise a cross-site request is out, a loopback host's same-origin
/// request is in, a tailnet name's is in when the server is open, and the
/// public origin passes only as https behind the proxy that says so.
pub fn library_origin_allowed(req: &Req, policy: &OriginPolicy) -> bool {
    // an empty Origin is no Origin, as the TS's truthiness test reads it
    let origin = req.header("origin").filter(|o| !o.is_empty());
    let origin = origin.as_deref();
    let site = req.header("sec-fetch-site");
    let cross = site.as_deref() == Some("cross-site");
    let host = req.host();
    let own = req.origin();
    let same = origin.is_none_or(|o| o == own);
    if let Some(o) = origin
        && policy.origins.iter().any(|x| x == o)
    {
        return true;
    }
    if policy.hosts.contains(&host) && !cross && same {
        return true;
    }
    // an origin that does not parse names no host (the TS would throw here;
    // CANOPY_ORIGINS only ever holds parsed ones)
    if origin.is_none()
        && !cross
        && policy
            .origins
            .iter()
            .any(|o| Url::parse(o).is_ok_and(|u| url_host(&u) == host))
    {
        return true;
    }
    let local = matches!(req.hostname(), "localhost" | "127.0.0.1" | "[::1]");
    if cross {
        return false;
    }
    if local && same {
        return true;
    }
    if policy.open && tailnet_host(req.hostname()) && same {
        return true;
    }
    let Some(public) = policy.public_origin.as_deref() else {
        return false;
    };
    let Ok(configured) = Url::parse(public) else {
        return false;
    };
    let configured_origin = configured.origin().ascii_serialization();
    configured.scheme() == "https"
        && configured_origin == public
        && host == url_host(&configured)
        && req.header("x-forwarded-proto").as_deref() == Some("https")
        && origin.is_none_or(|o| o == configured_origin)
}

/// GET routes another site sends the browser back to, which the browser marks
/// cross-site: Linear's app install returns to `/api/linear/callback`. Each
/// checks a one-time state this server handed out, so the origin gate reads
/// them without the cross-site mark; the host, the forwarded protocol and any
/// Origin still count.
pub const RETURN_LEGS: &[&str] = &["/api/linear/callback"];

/// The request the origin gate should judge: a cross-site GET to a return leg
/// loses its `sec-fetch-site`, anything else is passed through.
pub fn return_leg(req: &Req) -> Cow<'_, Req> {
    if req.method() != "GET"
        || !RETURN_LEGS.contains(&req.path())
        || req.header("sec-fetch-site").as_deref() != Some("cross-site")
    {
        return Cow::Borrowed(req);
    }
    Cow::Owned(req.without_header("sec-fetch-site"))
}

/// The host (address and port) of `CANOPY_COORD_API`, the URL a coordinator
/// reaches canopy at, for the origin gate; None when it is unset or not an
/// http(s) URL.
pub fn coord_api_host(api: Option<&str>) -> Option<String> {
    let raw = js_trim(api?);
    if raw.is_empty() {
        return None;
    }
    let url = Url::parse(raw).ok()?;
    matches!(url.scheme(), "http" | "https").then(|| url_host(&url))
}

/// Whether the server listens beyond loopback: `CANOPY_BIND` names an address
/// that is not a loopback one.
pub fn open_bind(bind: Option<&str>) -> bool {
    bind.is_some_and(|b| !b.is_empty() && !matches!(b, "127.0.0.1" | "localhost" | "::1" | "[::1]"))
}

/// `open_bind` on the process's `CANOPY_BIND`.
pub fn open_bind_env() -> bool {
    open_bind(std::env::var("CANOPY_BIND").ok().as_deref())
}
