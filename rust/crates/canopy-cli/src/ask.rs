//! One request to a canopy backend, as `ask()` in src/cli/health.ts sends
//! it: at the first of the backend's addresses that answers, with the
//! caller's token, no redirect followed, and a refusal by the backend taken
//! as the answer rather than a reason to try the next address. Also
//! `fetch`, one request as a verb with its own `fetch()` sends it (secrets,
//! incubator, ranger): one address, its status and body as they come, a
//! JSON body or a multipart form; a fake answers it through `ask`. And the
//! small argument helpers the HTTP verbs share (`take`, `has`) and the
//! backend list (`targetsOf`).

use crate::api::Caller;
use reqwest::{Method, StatusCode, redirect};
use serde_json::Value;
use std::error::Error as _;
use std::time::Duration;

/// A backend as the CLI addresses it: a name and its addresses, tried in
/// order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Target {
    pub name: String,
    pub urls: Vec<String>,
}

impl Target {
    /// The home backend at one address.
    pub fn home(url: &str) -> Self {
        Target {
            name: "home".into(),
            urls: vec![url.into()],
        }
    }
}

/// Why a request failed, in place of the TypeScript's error classes.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum AskError {
    /// No address answered (`Unreachable`): each address and what went
    /// wrong there, joined with "; ".
    Unreachable(String),
    /// The backend answered no (`Refused`), with its status.
    Refused { message: String, status: u16 },
    /// canopy refused for want of a right (a plain `Error`).
    Denied(String),
}

impl AskError {
    /// `err.message`.
    pub fn message(&self) -> &str {
        match self {
            AskError::Unreachable(m) | AskError::Denied(m) => m,
            AskError::Refused { message, .. } => message,
        }
    }
}

/// `ask()`'s default timeout.
pub const ASK_TIMEOUT: Duration = Duration::from_millis(8_000);

/// The HTTP client every verb shares, with the run's caller.
pub struct Client {
    http: reqwest::Client,
    pub caller: Caller,
}

impl Client {
    pub fn new(caller: Caller) -> Self {
        // rustls with ring, once per process; a second install is a no-op
        let _ = rustls::crypto::ring::default_provider().install_default();
        let http = reqwest::Client::builder()
            .redirect(redirect::Policy::none())
            .build()
            .expect("an HTTP client with rustls");
        Client { http, caller }
    }

    /// A request to `url` on the backend at `base`, with the caller's token
    /// for that backend and no redirect followed. The verbs that send or
    /// read something other than JSON (a clip's bytes, an event stream)
    /// build theirs here, so every request carries the token the same way.
    pub(crate) fn request(
        &self,
        method: Method,
        base: &str,
        url: &str,
        timeout: Option<Duration>,
    ) -> reqwest::RequestBuilder {
        let token = self.caller.caller_token(base, None);
        self.request_as(method, url, timeout, token.as_deref())
    }

    /// `request` with the token given rather than looked up: `canopy mcp`
    /// carries the session's own (`mcpToken`), and a tenant's `/api/about`
    /// is asked with none, as the TypeScript's plain fetch asks it.
    pub(crate) fn request_as(
        &self,
        method: Method,
        url: &str,
        timeout: Option<Duration>,
        token: Option<&str>,
    ) -> reqwest::RequestBuilder {
        let mut req = self.http.request(method, url);
        if let Some(t) = timeout {
            req = req.timeout(t);
        }
        if let Some(token) = token {
            req = req.header("x-canopy-token", token);
        }
        req
    }

    /// `ask(t, method, path, body)`.
    pub async fn ask(
        &self,
        t: &Target,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AskError> {
        self.ask_within(t, method, path, body, ASK_TIMEOUT).await
    }

    /// `ask` with its timeout given.
    pub async fn ask_within(
        &self,
        t: &Target,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value, AskError> {
        let method = Method::from_bytes(method.as_bytes()).unwrap_or(Method::GET);
        let mut tried: Vec<String> = Vec::new();
        for url in &t.urls {
            let full = format!("{url}{path}");
            let mut req = self.request(method.clone(), url, &full, Some(timeout));
            if let Some(b) = body {
                req = req
                    .header("content-type", "application/json")
                    .body(b.to_string());
            }
            let res = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    tried.push(format!("{url}: {}", fetch_words(&e, &full)));
                    continue;
                }
            };
            let status = res.status();
            let redirected = status.is_redirection();
            let out = if redirected {
                Value::Object(Default::default())
            } else {
                match res.text().await {
                    Ok(text) => serde_json::from_str(&text)
                        .unwrap_or_else(|_| Value::Object(Default::default())),
                    Err(e) => {
                        tried.push(format!("{url}: {}", fetch_words(&e, &full)));
                        continue;
                    }
                }
            };
            let auth = status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN;
            // canopy's own refusal names the right it wanted: that is the answer
            if auth && let Some(need) = out.get("need").and_then(Value::as_str) {
                return Err(AskError::Denied(error_of(&out).unwrap_or_else(|| {
                    format!("{} refused: it needs the {need} right", t.name)
                })));
            }
            // a sign-in gate or a redirect is not canopy answering
            if status == StatusCode::UNAUTHORIZED || redirected {
                tried.push(format!("{url}: needs a sign-in"));
                continue;
            }
            if !status.is_success() {
                return Err(AskError::Refused {
                    message: error_of(&out)
                        .unwrap_or_else(|| format!("{} answered {}", t.name, status.as_u16())),
                    status: status.as_u16(),
                });
            }
            return Ok(out);
        }
        Err(AskError::Unreachable(if tried.is_empty() {
            "no address".into()
        } else {
            tried.join("; ")
        }))
    }
}

/// `out.error` as `new Error(out.error ?? fallback)` would read it: a
/// string as it is, an array or object as `[object Object]`, anything else
/// as a template prints it.
pub(crate) fn error_of(out: &Value) -> Option<String> {
    match out.get("error")? {
        Value::Null => None,
        Value::String(s) => Some(s.clone()),
        Value::Array(_) | Value::Object(_) => Some("[object Object]".into()),
        other => Some(canopy_core::js::template(Some(other))),
    }
}

/// One request to a backend, so a verb's test can stand a fake in for the
/// network as the TypeScript tests hand in their own `ask`.
pub(crate) trait Ask {
    async fn ask(
        &self,
        t: &Target,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AskError>;

    /// `ask` with a timeout other than its 8 seconds. A fake has no clock,
    /// so it answers as `ask` does.
    async fn ask_within(
        &self,
        t: &Target,
        method: &str,
        path: &str,
        body: Option<&Value>,
        _timeout: Duration,
    ) -> Result<Value, AskError> {
        self.ask(t, method, path, body).await
    }

    /// `askText()`: a GET whose answer is text.
    async fn ask_text(&self, t: &Target, path: &str) -> Result<String, AskError>;

    /// `askText(t, path, timeoutMs)`: `ask_text` with a timeout other than
    /// its 8 seconds (a minute for a page, two for an analysis). A fake has
    /// no clock, so it answers as `ask_text` does.
    async fn ask_text_within(
        &self,
        t: &Target,
        path: &str,
        _timeout: Duration,
    ) -> Result<String, AskError> {
        self.ask_text(t, path).await
    }

    /// The network client behind this, for a request that is not one
    /// answer (an event stream). A fake has none.
    fn client(&self) -> Option<&Client> {
        None
    }

    /// One `fetch()` as a verb with its own sends it (secrets, incubator,
    /// ranger): one address, its status and body taken as they come, no
    /// address tried after it. Err is Bun's words for why nothing answered.
    /// A fake answers through `ask`, as `fetch_through_ask` says.
    async fn fetch(
        &self,
        method: &str,
        base: &str,
        path: &str,
        body: Option<Body<'_>>,
        timeout: Option<Duration>,
    ) -> Result<Fetched, String> {
        match self.client() {
            Some(c) => c.fetch(method, base, path, body, timeout).await,
            None => fetch_through_ask(self, method, base, path, body).await,
        }
    }
}

impl Ask for Client {
    async fn ask(
        &self,
        t: &Target,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AskError> {
        Client::ask(self, t, method, path, body).await
    }

    async fn ask_within(
        &self,
        t: &Target,
        method: &str,
        path: &str,
        body: Option<&Value>,
        timeout: Duration,
    ) -> Result<Value, AskError> {
        Client::ask_within(self, t, method, path, body, timeout).await
    }

    async fn ask_text(&self, t: &Target, path: &str) -> Result<String, AskError> {
        Client::ask_text(self, t, path).await
    }

    async fn ask_text_within(
        &self,
        t: &Target,
        path: &str,
        timeout: Duration,
    ) -> Result<String, AskError> {
        Client::ask_text_within(self, t, path, timeout).await
    }

    fn client(&self) -> Option<&Client> {
        Some(self)
    }
}

/// `body.key` when the body is a JSON object and the key a string.
fn string_in(body: Option<&Value>, key: &str) -> Option<String> {
    body?.get(key)?.as_str().map(String::from)
}

impl Client {
    /// `askText(t, path)`: the same addresses and refusals as `ask`, the
    /// answer's body as it is. Its refusals are plain errors, not
    /// `Refused`, and only a string `error` counts.
    pub async fn ask_text(&self, t: &Target, path: &str) -> Result<String, AskError> {
        self.ask_text_within(t, path, ASK_TIMEOUT).await
    }

    /// `ask_text` with its timeout given.
    pub async fn ask_text_within(
        &self,
        t: &Target,
        path: &str,
        timeout: Duration,
    ) -> Result<String, AskError> {
        let mut tried: Vec<String> = Vec::new();
        for url in &t.urls {
            let full = format!("{url}{path}");
            let req = self.request(Method::GET, url, &full, Some(timeout));
            let res = match req.send().await {
                Ok(r) => r,
                Err(e) => {
                    tried.push(format!("{url}: {}", fetch_words(&e, &full)));
                    continue;
                }
            };
            let status = res.status();
            if status.is_redirection() {
                tried.push(format!("{url}: needs a sign-in"));
                continue;
            }
            let text = match res.text().await {
                Ok(text) => text,
                Err(e) => {
                    tried.push(format!("{url}: {}", fetch_words(&e, &full)));
                    continue;
                }
            };
            let auth = status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN;
            let auth_body: Option<Value> = if auth {
                serde_json::from_str::<Value>(&text)
                    .ok()
                    .filter(Value::is_object)
            } else {
                None
            };
            if let Some(need) = string_in(auth_body.as_ref(), "need") {
                return Err(AskError::Denied(
                    string_in(auth_body.as_ref(), "error").unwrap_or_else(|| {
                        format!("{} refused: it needs the {need} right", t.name)
                    }),
                ));
            }
            if status == StatusCode::UNAUTHORIZED {
                tried.push(format!("{url}: needs a sign-in"));
                continue;
            }
            if !status.is_success() {
                let answered = format!("{} answered {}", t.name, status.as_u16());
                if status == StatusCode::FORBIDDEN {
                    return Err(AskError::Denied(
                        string_in(auth_body.as_ref(), "error").unwrap_or(answered),
                    ));
                }
                let parsed = serde_json::from_str::<Value>(&text).ok();
                let error = string_in(parsed.as_ref(), "error").unwrap_or(text);
                return Err(AskError::Denied(if error.is_empty() {
                    answered
                } else {
                    error
                }));
            }
            return Ok(text);
        }
        Err(AskError::Unreachable(if tried.is_empty() {
            "no address".into()
        } else {
            tried.join("; ")
        }))
    }
}

/// What Bun's fetch says when an address does not answer, so a "did not
/// answer" line reads the same from either CLI. A failure Bun words in a way
/// this does not know falls back to reqwest's own words.
pub fn fetch_words(e: &reqwest::Error, url: &str) -> String {
    if e.is_builder() {
        return "fetch() URL is invalid".into();
    }
    if e.is_timeout() {
        return "The operation timed out.".into();
    }
    let mut chain: Vec<String> = Vec::new();
    let mut src = e.source();
    while let Some(s) = src {
        let io = s.downcast_ref::<std::io::Error>();
        if io.is_some_and(|io| io.kind() == std::io::ErrorKind::ConnectionRefused) {
            return "ECONNREFUSED: Unable to connect. Is the computer able to access the url?"
                .into();
        }
        if tls_error(s).is_some_and(|r| {
            matches!(
                r,
                rustls::Error::InvalidMessage(_) | rustls::Error::InappropriateMessage { .. }
            )
        }) {
            return "EPROTO: The TLS handshake failed. Does the server speak TLS on this port?"
                .into();
        }
        chain.push(s.to_string());
        src = s.source();
    }
    if chain.iter().any(|c| c == "dns error") {
        let host = reqwest::Url::parse(url)
            .ok()
            .and_then(|u| u.host_str().map(String::from))
            .unwrap_or_default();
        return format!("getaddrinfo {} {host}", dns_code(&chain));
    }
    chain.last().cloned().unwrap_or_else(|| e.to_string())
}

/// The getaddrinfo code Bun names for a lookup that failed: EAI_AGAIN when
/// the resolver could not answer now (glibc's and macOS's "temporary failure
/// in name resolution", what a bare name gets in canopy's containers), else
/// ENOTFOUND.
pub(crate) fn dns_code(chain: &[String]) -> &'static str {
    let again = chain.iter().any(|c| {
        c.to_ascii_lowercase()
            .contains("temporary failure in name resolution")
    });
    if again { "EAI_AGAIN" } else { "ENOTFOUND" }
}

/// rustls's error, through the io::Errors hyper-util and tokio-rustls wrap
/// it in. An io::Error's source() skips its own inner error, so each layer
/// is opened with get_ref().
fn tls_error<'a>(mut e: &'a (dyn std::error::Error + 'static)) -> Option<&'a rustls::Error> {
    loop {
        if let Some(r) = e.downcast_ref::<rustls::Error>() {
            return Some(r);
        }
        e = e.downcast_ref::<std::io::Error>()?.get_ref()?;
    }
}

/// `targetsOf()`: home first at its own address, then each other backend
/// the home one lists, by its tailnet address and then its public one.
pub fn targets_of(home: &str, self_name: &str, list: &[Value]) -> Vec<Target> {
    let mut out = vec![Target {
        name: self_name.into(),
        urls: vec![home.into()],
    }];
    for b in list {
        let name = b.get("name").and_then(Value::as_str).unwrap_or("");
        if name == self_name {
            continue;
        }
        let urls: Vec<String> = ["tailnet", "public"]
            .iter()
            .filter_map(|k| b.get(*k).and_then(Value::as_str))
            .filter(|u| !u.is_empty())
            .map(String::from)
            .collect();
        if !urls.is_empty() {
            out.push(Target {
                name: name.into(),
                urls,
            });
        }
    }
    out
}

/// The backends a listing verb reads (issues, prs): every one the home
/// backend lists, or home alone when `--backend` was given, when the home
/// backend lists none, or when it did not answer.
pub(crate) async fn listed_targets(ask: &impl Ask, home: &str, given: bool) -> Vec<Target> {
    if given {
        return vec![Target::home(home)];
    }
    every_target(ask, home)
        .await
        .unwrap_or_else(|_| vec![Target::home(home)])
}

/// Every backend the home one lists, in `targetsOf`'s order; home alone
/// when it lists none. Err with home's own failure when it did not answer,
/// for the callers that say so.
pub(crate) async fn every_target(ask: &impl Ask, home: &str) -> Result<Vec<Target>, AskError> {
    let home_target = Target::home(home);
    let listed = ask.ask(&home_target, "GET", "/api/backends", None).await?;
    let self_name = listed
        .get("self")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty());
    Ok(match self_name {
        Some(name) => {
            let list = listed
                .get("backends")
                .and_then(Value::as_array)
                .map_or(&[][..], Vec::as_slice);
            targets_of(home, name, list)
        }
        None => vec![home_target],
    })
}

/// `backendTargets()`: every backend the home one lists; home alone when
/// `--backend` was given without `--on`; the one `--on` names, else the
/// failure that says which names there are.
pub(crate) async fn backend_targets(
    ask: &impl Ask,
    home: &str,
    given: bool,
    on: Option<&str>,
) -> Result<Vec<Target>, String> {
    if given && on.is_none() {
        return Ok(vec![Target::home(home)]);
    }
    let all = every_target(ask, home)
        .await
        .unwrap_or_else(|_| vec![Target::home(home)]);
    let Some(name) = on else {
        return Ok(all);
    };
    match all.iter().find(|t| t.name == name) {
        Some(one) => Ok(vec![one.clone()]),
        None => Err(format!(
            "no backend named {name}; the home backend lists {}",
            all.iter()
                .map(|t| t.name.as_str())
                .collect::<Vec<_>>()
                .join(", ")
        )),
    }
}

/// "<name> did not answer: …" for an unreachable backend, else the
/// error's own words: the failure most verbs print.
pub fn did_not_answer(name: &str, e: &AskError) -> String {
    match e {
        AskError::Unreachable(m) => format!("{name} did not answer: {m}"),
        other => other.message().to_string(),
    }
}

/// "<name>: did not answer: …" or "<name>: <error>", the line a listing
/// verb prints for one backend that could not answer while the others
/// still report.
pub fn skipped_line(name: &str, e: &AskError) -> String {
    match e {
        AskError::Unreachable(m) => format!("{name}: did not answer: {m}"),
        other => format!("{name}: {}", other.message()),
    }
}

/// `take()`: pull `name` and the word after it out of `args`. Both go even
/// when nothing follows, and then the value is None.
pub fn take(args: &mut Vec<String>, name: &str) -> Option<String> {
    let i = args.iter().position(|a| a == name)?;
    args.remove(i);
    if i < args.len() {
        Some(args.remove(i))
    } else {
        None
    }
}

/// `args.shift()`.
pub fn shift(args: &mut Vec<String>) -> Option<String> {
    if args.is_empty() {
        None
    } else {
        Some(args.remove(0))
    }
}

/// `has()`: pull a bare `name` out of `args`.
pub fn has(args: &mut Vec<String>, name: &str) -> bool {
    match args.iter().position(|a| a == name) {
        Some(i) => {
            args.remove(i);
            true
        }
        None => false,
    }
}

/// `encodeURIComponent()`.
pub fn encode_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        let keep = b.is_ascii_alphanumeric()
            || matches!(
                b,
                b'-' | b'_' | b'.' | b'!' | b'~' | b'*' | b'\'' | b'(' | b')'
            );
        if keep {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// `new URLSearchParams(pairs).toString()`: form encoding, a space as `+`
/// and only `*-._` kept among the marks.
pub fn form_query(pairs: &[(&str, &str)]) -> String {
    let enc = |s: &str| {
        let mut out = String::new();
        for b in s.bytes() {
            match b {
                b' ' => out.push('+'),
                b'*' | b'-' | b'.' | b'_' => out.push(b as char),
                _ if b.is_ascii_alphanumeric() => out.push(b as char),
                _ => out.push_str(&format!("%{b:02X}")),
            }
        }
        out
    };
    pairs
        .iter()
        .map(|(k, v)| format!("{}={}", enc(k), enc(v)))
        .collect::<Vec<_>>()
        .join("&")
}

/// `/^https?:\/\/[^/\s]+$/`: a bare http(s) origin.
pub use canopy_core::pathx::is_bare_origin as is_origin;

/// What one `fetch()` answered: its status and its body's text.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Fetched {
    pub status: u16,
    pub text: String,
}

impl Fetched {
    /// `res.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    /// `await res.json()`: the body as JSON, None where Bun's parse throws.
    pub fn json(&self) -> Option<Value> {
        serde_json::from_str(&self.text).ok()
    }
}

/// One field of a multipart form, in the order `FormData` sends it.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Part {
    Text {
        name: String,
        value: String,
    },
    File {
        name: String,
        filename: String,
        mime: String,
        bytes: Vec<u8>,
    },
}

/// A request body as a verb with its own `fetch()` sends it.
#[derive(Debug, Clone, Copy)]
pub enum Body<'a> {
    Json(&'a Value),
    Form(&'a [Part]),
}

/// A form's fields as a fake reads them: each name's values in order, a
/// file as `file:<name>:<text>`, the record the TypeScript tests keep.
pub fn form_record(parts: &[Part]) -> Value {
    let mut out = serde_json::Map::new();
    for p in parts {
        let (name, value) = match p {
            Part::Text { name, value } => (name, value.clone()),
            Part::File {
                name,
                filename,
                bytes,
                ..
            } => (
                name,
                format!("file:{filename}:{}", String::from_utf8_lossy(bytes)),
            ),
        };
        if let Value::Array(list) = out
            .entry(name.clone())
            .or_insert_with(|| Value::Array(vec![]))
        {
            list.push(Value::String(value));
        }
    }
    Value::Object(out)
}

/// A fake's `fetch`: its `ask` answer as a 200, a refusal as its status
/// with `{error}`, a want of a right as a 403, and an unreachable backend
/// as the failure. A form goes to the fake as `{"form": form_record}`.
async fn fetch_through_ask<A: Ask + ?Sized>(
    a: &A,
    method: &str,
    base: &str,
    path: &str,
    body: Option<Body<'_>>,
) -> Result<Fetched, String> {
    let sent = match body {
        Some(Body::Json(v)) => Some(v.clone()),
        Some(Body::Form(parts)) => Some(serde_json::json!({ "form": form_record(parts) })),
        None => None,
    };
    let refused = |status: u16, error: String| Fetched {
        status,
        text: serde_json::json!({ "error": error }).to_string(),
    };
    match a
        .ask(&Target::home(base), method, path, sent.as_ref())
        .await
    {
        Ok(v) => Ok(Fetched {
            status: 200,
            text: v.to_string(),
        }),
        Err(AskError::Refused { message, status }) => Ok(refused(status, message)),
        Err(AskError::Denied(m)) => Ok(refused(403, m)),
        Err(AskError::Unreachable(m)) => Err(m),
    }
}

/// `"` and line breaks in a form field's name, as Bun's FormData escapes
/// them.
fn form_name(s: &str) -> String {
    s.replace('"', "%22")
        .replace('\r', "%0D")
        .replace('\n', "%0A")
}

/// A form as `multipart/form-data`: the boundary and the body's bytes.
fn multipart(parts: &[Part]) -> (String, Vec<u8>) {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let boundary = format!("----CanopyFormBoundary{stamp:x}{:x}", std::process::id());
    let mut out: Vec<u8> = Vec::new();
    for p in parts {
        out.extend_from_slice(format!("--{boundary}\r\n").as_bytes());
        match p {
            Part::Text { name, value } => {
                out.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{}\"\r\n\r\n",
                        form_name(name)
                    )
                    .as_bytes(),
                );
                out.extend_from_slice(value.as_bytes());
            }
            Part::File {
                name,
                filename,
                mime,
                bytes,
            } => {
                out.extend_from_slice(
                    format!(
                        "Content-Disposition: form-data; name=\"{}\"; filename=\"{}\"\r\nContent-Type: {mime}\r\n\r\n",
                        form_name(name),
                        form_name(filename)
                    )
                    .as_bytes(),
                );
                out.extend_from_slice(bytes);
            }
        }
        out.extend_from_slice(b"\r\n");
    }
    out.extend_from_slice(format!("--{boundary}--\r\n").as_bytes());
    (boundary, out)
}

impl Client {
    /// `fetch(base + path, {method, redirect: "manual", headers:
    /// callerHeaders(base), body})`, with a timeout only where the
    /// TypeScript sets an `AbortSignal.timeout`.
    pub async fn fetch(
        &self,
        method: &str,
        base: &str,
        path: &str,
        body: Option<Body<'_>>,
        timeout: Option<Duration>,
    ) -> Result<Fetched, String> {
        let method = Method::from_bytes(method.as_bytes()).unwrap_or(Method::GET);
        let full = format!("{base}{path}");
        let mut req = self.request(method, base, &full, timeout);
        match body {
            Some(Body::Json(v)) => {
                req = req
                    .header("content-type", "application/json")
                    .body(v.to_string());
            }
            Some(Body::Form(parts)) => {
                let (boundary, bytes) = multipart(parts);
                req = req
                    .header(
                        "content-type",
                        format!("multipart/form-data; boundary={boundary}"),
                    )
                    .body(bytes);
            }
            None => {}
        }
        let res = req.send().await.map_err(|e| fetch_words(&e, &full))?;
        let status = res.status().as_u16();
        let text = res.text().await.map_err(|e| fetch_words(&e, &full))?;
        Ok(Fetched { status, text })
    }
}

#[cfg(test)]
pub mod tests;
