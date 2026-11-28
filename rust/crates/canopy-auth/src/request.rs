//! A request as the gate sees it: its method, its URL parsed the way a
//! browser and Bun parse one (WHATWG, through the `url` crate, so dot
//! segments are resolved and a default port drops out of the host), and its
//! headers. No HTTP framework's types, so every gate function stays pure.

use std::fmt;

use url::Url;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct BadUrl(pub String);

impl fmt::Display for BadUrl {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "not a URL: {}", self.0)
    }
}

impl std::error::Error for BadUrl {}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Req {
    method: String,
    url: Url,
    /// names lowercased, values trimmed, in the order they came
    headers: Vec<(String, String)>,
}

/// HTTP whitespace, which a header value loses at both ends.
fn http_trim(v: &str) -> &str {
    v.trim_matches(|c| matches!(c, ' ' | '\t' | '\n' | '\r'))
}

impl Req {
    /// A request for an absolute URL, as `new Request(url, { method })`.
    pub fn new(method: &str, url: &str) -> Result<Req, BadUrl> {
        let url = Url::parse(url).map_err(|_| BadUrl(url.to_string()))?;
        Ok(Req {
            method: method.to_string(),
            url,
            headers: Vec::new(),
        })
    }

    /// A request as a server receives it: the request target (path and
    /// query) and the Host it asked for, read as `http://<host><target>` the
    /// way Bun builds `req.url`.
    pub fn from_target(method: &str, host: &str, target: &str) -> Result<Req, BadUrl> {
        Req::new(method, &format!("http://{host}{target}"))
    }

    /// The same request with one more header.
    pub fn with_header(mut self, name: &str, value: &str) -> Req {
        self.headers
            .push((name.to_ascii_lowercase(), http_trim(value).to_string()));
        self
    }

    /// The same request with these headers added.
    pub fn with_headers<'a>(
        mut self,
        headers: impl IntoIterator<Item = (&'a str, &'a str)>,
    ) -> Req {
        for (k, v) in headers {
            self = self.with_header(k, v);
        }
        self
    }

    /// The same request without any header of this name.
    pub fn without_header(&self, name: &str) -> Req {
        let name = name.to_ascii_lowercase();
        let mut out = self.clone();
        out.headers.retain(|(k, _)| *k != name);
        out
    }

    pub fn method(&self) -> &str {
        &self.method
    }

    /// The whole URL, as `req.url`.
    pub fn href(&self) -> &str {
        self.url.as_str()
    }

    /// `url.pathname`
    pub fn path(&self) -> &str {
        self.url.path()
    }

    /// `url.searchParams.get(name)`: the first value, form-decoded.
    pub fn query(&self, name: &str) -> Option<String> {
        self.url
            .query_pairs()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.into_owned())
    }

    /// `headers.get(name)`: case-insensitive, several values joined by ", ".
    pub fn header(&self, name: &str) -> Option<String> {
        let name = name.to_ascii_lowercase();
        let mut found: Option<String> = None;
        for (k, v) in &self.headers {
            if *k == name {
                match &mut found {
                    Some(all) => {
                        all.push_str(", ");
                        all.push_str(v);
                    }
                    None => found = Some(v.clone()),
                }
            }
        }
        found
    }

    pub fn has_header(&self, name: &str) -> bool {
        let name = name.to_ascii_lowercase();
        self.headers.iter().any(|(k, _)| *k == name)
    }

    /// `url.hostname`: an IPv6 address keeps its brackets.
    pub fn hostname(&self) -> &str {
        self.url.host_str().unwrap_or("")
    }

    /// `url.host`: the hostname and the port when it is not the default.
    pub fn host(&self) -> String {
        url_host(&self.url)
    }

    /// `url.origin`
    pub fn origin(&self) -> String {
        self.url.origin().ascii_serialization()
    }
}

/// `URL.host` for a parsed URL.
pub(crate) fn url_host(url: &Url) -> String {
    let name = url.host_str().unwrap_or("");
    match url.port() {
        Some(port) => format!("{name}:{port}"),
        None => name.to_string(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parts_like_a_browser() {
        let r = Req::new(
            "GET",
            "http://[::1]:7850/api/tree/../repos/raw?id=a+b&id=c&ticket=%2Fx",
        )
        .unwrap();
        assert_eq!(r.path(), "/api/repos/raw");
        assert_eq!(r.hostname(), "[::1]");
        assert_eq!(r.host(), "[::1]:7850");
        assert_eq!(r.origin(), "http://[::1]:7850");
        assert_eq!(r.query("id").as_deref(), Some("a b"));
        assert_eq!(r.query("ticket").as_deref(), Some("/x"));
        assert_eq!(r.query("nope"), None);
        let d = Req::new("GET", "http://Example.COM:80/x").unwrap();
        assert_eq!(d.host(), "example.com");
        assert_eq!(d.origin(), "http://example.com");
    }

    #[test]
    fn headers_like_fetch() {
        let r = Req::new("GET", "http://x/")
            .unwrap()
            .with_header("X-A", " one ")
            .with_header("x-a", "two")
            .with_header("Origin", "http://x");
        assert_eq!(r.header("x-a").as_deref(), Some("one, two"));
        assert_eq!(r.header("ORIGIN").as_deref(), Some("http://x"));
        assert!(r.has_header("origin"));
        assert!(!r.without_header("origin").has_header("origin"));
        assert_eq!(r.header("missing"), None);
    }
}
