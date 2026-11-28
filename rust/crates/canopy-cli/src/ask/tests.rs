//! `ask` against stub servers on loopback, ported from api.test.ts and
//! health.test.ts, plus the words each way of not answering prints.

use super::*;
use serde_json::json;
use std::sync::{Arc, Mutex};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpListener;

/// One request a stub saw: its method, path and caller token.
#[derive(Debug, Clone)]
pub struct Seen {
    pub method: String,
    pub path: String,
    pub token: Option<String>,
    pub body: String,
}

/// A stub answer: status, extra header lines, body.
pub type Answer = (u16, Vec<(String, String)>, String);

/// A loopback HTTP/1.1 server that answers each request with `answer` and
/// keeps what it saw. Every answer closes its connection.
pub struct Stub {
    pub url: String,
    pub seen: Arc<Mutex<Vec<Seen>>>,
}

impl Stub {
    pub async fn start<F>(answer: F) -> Stub
    where
        F: Fn(&Seen) -> Answer + Send + Sync + 'static,
    {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let seen: Arc<Mutex<Vec<Seen>>> = Arc::default();
        let answer = Arc::new(answer);
        let log = seen.clone();
        tokio::spawn(async move {
            loop {
                let Ok((mut sock, _)) = listener.accept().await else {
                    return;
                };
                let answer = answer.clone();
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf = Vec::new();
                    let mut chunk = [0u8; 4096];
                    let head_end = loop {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            return;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                        if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                            break i + 4;
                        }
                    };
                    let head = String::from_utf8_lossy(&buf[..head_end]).to_string();
                    let mut lines = head.split("\r\n");
                    let first: Vec<&str> = lines.next().unwrap_or("").split(' ').collect();
                    let mut token = None;
                    let mut length = 0usize;
                    for l in lines {
                        if let Some((k, v)) = l.split_once(':') {
                            let k = k.trim().to_ascii_lowercase();
                            if k == "x-canopy-token" {
                                token = Some(v.trim().to_string());
                            }
                            if k == "content-length" {
                                length = v.trim().parse().unwrap_or(0);
                            }
                        }
                    }
                    while buf.len() < head_end + length {
                        let n = sock.read(&mut chunk).await.unwrap_or(0);
                        if n == 0 {
                            break;
                        }
                        buf.extend_from_slice(&chunk[..n]);
                    }
                    let s = Seen {
                        method: first.first().unwrap_or(&"").to_string(),
                        path: first.get(1).unwrap_or(&"").to_string(),
                        token,
                        body: String::from_utf8_lossy(&buf[head_end..]).to_string(),
                    };
                    log.lock().unwrap().push(s.clone());
                    let (status, headers, body) = answer(&s);
                    let mut out = format!(
                        "HTTP/1.1 {status} X\r\ncontent-length: {}\r\nconnection: close\r\n",
                        body.len()
                    );
                    for (k, v) in headers {
                        out.push_str(&format!("{k}: {v}\r\n"));
                    }
                    out.push_str("\r\n");
                    out.push_str(&body);
                    let _ = sock.write_all(out.as_bytes()).await;
                    let _ = sock.shutdown().await;
                });
            }
        });
        Stub { url, seen }
    }

    pub fn paths(&self) -> Vec<String> {
        self.seen
            .lock()
            .unwrap()
            .iter()
            .map(|s| s.path.clone())
            .collect()
    }
}

pub fn json_answer(status: u16, body: Value) -> Answer {
    (
        status,
        vec![("content-type".into(), "application/json".into())],
        body.to_string(),
    )
}

fn client() -> Client {
    // a config dir that holds no token files, and no environment
    Client::new(Caller {
        config_dir: "/nonexistent/canopy-cli-test".into(),
        ..Default::default()
    })
}

fn target(urls: &[&str]) -> Target {
    Target {
        name: "x".into(),
        urls: urls.iter().map(|u| u.to_string()).collect(),
    }
}

#[tokio::test]
async fn ask_text_hands_back_the_body_and_reads_a_refusal_as_the_typescript_does() {
    let stub = Stub::start(|s| match s.path.as_str() {
        "/md" => (200, vec![], "# title\n".into()),
        "/json-error" => json_answer(404, json!({"error": "no item w-x"})),
        "/text-error" => (500, vec![], "it broke".into()),
        "/empty" => (502, vec![], String::new()),
        "/forbidden" => json_answer(403, json!({"why": "no"})),
        "/need" => json_answer(403, json!({"need": "admin"})),
        "/gate" => (401, vec![], "sign in".into()),
        _ => (302, vec![("location".into(), "/x".into())], String::new()),
    })
    .await;
    let c = client();
    let t = target(&[&stub.url]);
    assert_eq!(c.ask_text(&t, "/md").await.unwrap(), "# title\n");
    let e = |r: Result<String, AskError>| r.unwrap_err().message().to_string();
    assert_eq!(e(c.ask_text(&t, "/json-error").await), "no item w-x");
    assert_eq!(e(c.ask_text(&t, "/text-error").await), "it broke");
    assert_eq!(e(c.ask_text(&t, "/empty").await), "x answered 502");
    assert_eq!(e(c.ask_text(&t, "/forbidden").await), "x answered 403");
    assert_eq!(
        e(c.ask_text(&t, "/need").await),
        "x refused: it needs the admin right"
    );
    let gate = c.ask_text(&t, "/gate").await.unwrap_err();
    assert_eq!(
        gate,
        AskError::Unreachable(format!("{}: needs a sign-in", stub.url))
    );
    let moved = c.ask_text(&t, "/moved").await.unwrap_err();
    assert_eq!(
        moved,
        AskError::Unreachable(format!("{}: needs a sign-in", stub.url))
    );
}

#[tokio::test]
async fn backend_targets_take_home_alone_the_one_on_names_or_every_one() {
    let listed = json!({"self": "mac", "backends": [{"name": "mini", "tailnet": "http://mini"}, {"name": "far"}]});
    let fake = Fake(|_: &Target, _: &str, _: &str, _: Option<&Value>| Ok(listed.clone()));
    let names = |ts: Vec<Target>| ts.into_iter().map(|t| t.name).collect::<Vec<_>>();
    assert_eq!(
        names(
            backend_targets(&fake, "http://h", true, None)
                .await
                .unwrap()
        ),
        ["home"]
    );
    assert_eq!(
        names(
            backend_targets(&fake, "http://h", false, None)
                .await
                .unwrap()
        ),
        ["mac", "mini"]
    );
    assert_eq!(
        names(
            backend_targets(&fake, "http://h", true, Some("mini"))
                .await
                .unwrap()
        ),
        ["mini"]
    );
    assert_eq!(
        backend_targets(&fake, "http://h", false, Some("far"))
            .await
            .unwrap_err(),
        "no backend named far; the home backend lists mac, mini"
    );
}

#[test]
fn a_form_query_encodes_as_urlsearchparams_does() {
    assert_eq!(
        form_query(&[("repo", "a b/c"), ("state", "open")]),
        "repo=a+b%2Fc&state=open"
    );
    assert_eq!(form_query(&[("x", "*-._~!'()")]), "x=*-._%7E%21%27%28%29");
}

#[tokio::test]
async fn a_403_with_need_is_final_and_a_401_without_need_tries_the_next_address() {
    let stub = Stub::start(|s| match s.path.as_str() {
        "/forbidden" => json_answer(403, json!({"error": "this needs admin", "need": "admin"})),
        "/gate" => (401, vec![], "sign in".into()),
        _ => json_answer(200, json!({"ok": true})),
    })
    .await;
    let a = stub.url.clone();
    let dead = "http://127.0.0.1:1";
    let c = client();
    let e = c
        .ask(
            &target(&[&a, &format!("{a}/second")]),
            "POST",
            "/forbidden",
            Some(&json!({})),
        )
        .await
        .unwrap_err();
    assert_eq!(e, AskError::Denied("this needs admin".into()));
    assert_eq!(stub.paths(), ["/forbidden"]);
    let two = c
        .ask(&target(&[dead, &a]), "GET", "/fine", None)
        .await
        .unwrap();
    assert_eq!(two["ok"], json!(true));
    stub.seen.lock().unwrap().clear();
    let e = c
        .ask(&target(&[&a, &a]), "GET", "/gate", None)
        .await
        .unwrap_err();
    assert_eq!(
        e,
        AskError::Unreachable(format!("{a}: needs a sign-in; {a}: needs a sign-in"))
    );
    assert_eq!(stub.paths(), ["/gate", "/gate"]);
}

#[tokio::test]
async fn the_environment_token_goes_to_the_home_backend_only() {
    let stub = Stub::start(|_| json_answer(200, json!({"ok": true}))).await;
    let a = stub.url.clone();
    let mut c = client();
    c.caller.env_token = Some("cnp_cli_env".into());
    c.caller.home_base = Some(a.clone());
    c.ask(&target(&[&a]), "GET", "/fine", None).await.unwrap();
    assert_eq!(
        stub.seen.lock().unwrap().last().unwrap().token.as_deref(),
        Some("cnp_cli_env")
    );
    c.caller.home_base = None;
    c.ask(&target(&[&a]), "GET", "/fine", None).await.unwrap();
    assert_eq!(stub.seen.lock().unwrap().last().unwrap().token, None);
}

#[tokio::test]
async fn a_redirect_is_a_sign_in_and_never_carries_the_token_on() {
    let other = Stub::start(|_| json_answer(200, json!({"ok": true}))).await;
    let to = format!("{}/signin", other.url);
    let first =
        Stub::start(move |_| (302, vec![("location".into(), to.clone())], String::new())).await;
    let a = first.url.clone();
    let mut c = client();
    c.caller.env_token = Some("cnp_cli_env".into());
    c.caller.home_base = Some(a.clone());
    let e = c
        .ask(&target(&[&a]), "GET", "/api/x", None)
        .await
        .unwrap_err();
    assert_eq!(e, AskError::Unreachable(format!("{a}: needs a sign-in")));
    assert!(other.paths().is_empty());
}

#[tokio::test]
async fn a_refusal_carries_the_backend_words_or_its_status_and_a_bad_body_reads_as_empty() {
    let stub = Stub::start(|s| match s.path.as_str() {
        "/words" => json_answer(404, json!({"error": "no note by that id"})),
        "/bare" => (500, vec![], "<html>oops</html>".into()),
        _ => (200, vec![], "not json".into()),
    })
    .await;
    let c = client();
    let t = target(&[&stub.url]);
    assert_eq!(
        c.ask(&t, "DELETE", "/words", None).await.unwrap_err(),
        AskError::Refused {
            message: "no note by that id".into(),
            status: 404
        }
    );
    assert_eq!(
        c.ask(&t, "GET", "/bare", None).await.unwrap_err(),
        AskError::Refused {
            message: "x answered 500".into(),
            status: 500
        }
    );
    assert_eq!(c.ask(&t, "GET", "/text", None).await.unwrap(), json!({}));
}

#[tokio::test]
async fn a_body_goes_as_json() {
    let stub = Stub::start(|_| json_answer(200, json!({}))).await;
    let c = client();
    c.ask(
        &target(&[&stub.url]),
        "POST",
        "/api/notes",
        Some(&json!({"text": "hi"})),
    )
    .await
    .unwrap();
    let seen = stub.seen.lock().unwrap();
    assert_eq!(seen[0].method, "POST");
    assert_eq!(seen[0].body, r#"{"text":"hi"}"#);
}

#[tokio::test]
async fn each_way_of_not_answering_reads_as_bun_words_it() {
    let c = client();
    let words = |e: AskError| e.message().to_string();
    // refused
    let e = c
        .ask(&target(&["http://127.0.0.1:1"]), "GET", "/x", None)
        .await
        .unwrap_err();
    assert_eq!(
        words(e),
        "http://127.0.0.1:1: ECONNREFUSED: Unable to connect. Is the computer able to access the url?"
    );
    // no such host
    let e = c
        .ask(&target(&["http://no-such-host.invalid"]), "GET", "/x", None)
        .await
        .unwrap_err();
    assert_eq!(
        words(e),
        "http://no-such-host.invalid: getaddrinfo ENOTFOUND no-such-host.invalid"
    );
    // not a URL
    let e = c
        .ask(&target(&["http://127.0.0.1:99999"]), "GET", "/x", None)
        .await
        .unwrap_err();
    assert_eq!(words(e), "http://127.0.0.1:99999: fetch() URL is invalid");
    // a listener that accepts and never answers
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let quiet = format!("http://{}", silent.local_addr().unwrap());
    let hold = tokio::spawn(async move {
        let mut held = Vec::new();
        while let Ok((s, _)) = silent.accept().await {
            held.push(s);
        }
    });
    let e = c
        .ask_within(
            &target(&[&quiet]),
            "GET",
            "/x",
            None,
            Duration::from_millis(300),
        )
        .await
        .unwrap_err();
    assert_eq!(words(e), format!("{quiet}: The operation timed out."));
    hold.abort();
    // TLS to a plain HTTP server, which answers the hello with a 400 as
    // Bun's server does
    let plain = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let tls = format!("https://{}", plain.local_addr().unwrap());
    let answer = tokio::spawn(async move {
        while let Ok((mut s, _)) = plain.accept().await {
            let mut hello = [0u8; 512];
            let _ = s.read(&mut hello).await;
            let _ = s
                .write_all(b"HTTP/1.1 400 Bad Request\r\nconnection: close\r\n\r\n")
                .await;
        }
    });
    let e = c
        .ask(&target(&[&tls]), "GET", "/x", None)
        .await
        .unwrap_err();
    assert_eq!(
        words(e),
        format!("{tls}: EPROTO: The TLS handshake failed. Does the server speak TLS on this port?")
    );
    answer.abort();
    // no address at all
    let e = c.ask(&target(&[]), "GET", "/x", None).await.unwrap_err();
    assert_eq!(words(e), "no address");
}

#[test]
fn targets_of_puts_home_first_then_each_other_backend_by_tailnet_then_public() {
    let ts = targets_of(
        "http://127.0.0.1:7850",
        "mac",
        &[
            json!({"name": "mac", "public": "https://canopy-mac.example", "tailnet": "https://mac.ts:7850"}),
            json!({"name": "mini", "public": "https://canopy.example", "tailnet": "https://mini.ts:7849"}),
            json!({"name": "gpd"}),
        ],
    );
    assert_eq!(
        ts,
        vec![
            Target {
                name: "mac".into(),
                urls: vec!["http://127.0.0.1:7850".into()]
            },
            Target {
                name: "mini".into(),
                urls: vec![
                    "https://mini.ts:7849".into(),
                    "https://canopy.example".into()
                ]
            },
        ]
    );
}

#[test]
fn take_and_has_splice_as_health_ts_does() {
    let mut a: Vec<String> = ["list", "--backend", "http://x", "--all"]
        .map(String::from)
        .to_vec();
    assert_eq!(take(&mut a, "--backend").as_deref(), Some("http://x"));
    assert!(has(&mut a, "--all"));
    assert_eq!(a, ["list"]);
    let mut b: Vec<String> = ["list", "--backend"].map(String::from).to_vec();
    assert_eq!(take(&mut b, "--backend"), None);
    assert_eq!(b, ["list"]);
}

#[test]
fn encode_component_and_is_origin_follow_javascript() {
    assert_eq!(encode_component("a b/c?d=é"), "a%20b%2Fc%3Fd%3D%C3%A9");
    assert_eq!(encode_component("n_1-x.y~*'()!"), "n_1-x.y~*'()!");
    assert!(is_origin("http://127.0.0.1:7850"));
    assert!(is_origin("https://canopy.example"));
    assert!(!is_origin("http://x/"));
    assert!(!is_origin("ftp://x"));
    assert!(!is_origin("http://"));
    assert!(!is_origin("http://a b"));
}

/// A backend that answers from a function, for the verbs' tests.
pub struct Fake<F>(pub F);

impl<F> Ask for Fake<F>
where
    F: Fn(&Target, &str, &str, Option<&Value>) -> Result<Value, AskError>,
{
    async fn ask(
        &self,
        t: &Target,
        method: &str,
        path: &str,
        body: Option<&Value>,
    ) -> Result<Value, AskError> {
        (self.0)(t, method, path, body)
    }

    /// a text answer is the closure's string, asked for as a GET
    async fn ask_text(&self, t: &Target, path: &str) -> Result<String, AskError> {
        (self.0)(t, "GET", path, None).map(|v| match v {
            Value::String(s) => s,
            other => other.to_string(),
        })
    }
}

#[tokio::test]
async fn fetch_takes_one_address_as_it_answers_and_sends_a_form_as_multipart() {
    let stub = Stub::start(|s| match s.path.as_str() {
        "/made" => json_answer(201, json!({"id": "x"})),
        "/moved" => (302, vec![("location".into(), "/x".into())], String::new()),
        _ => (200, vec![], s.body.clone()),
    })
    .await;
    let c = client();
    let body = json!({"a": 1});
    let made = c
        .fetch("POST", &stub.url, "/made", Some(Body::Json(&body)), None)
        .await;
    assert_eq!(
        made,
        Ok(Fetched {
            status: 201,
            text: r#"{"id":"x"}"#.into()
        })
    );
    assert!(made.unwrap().ok());
    let moved = c
        .fetch("GET", &stub.url, "/moved", None, None)
        .await
        .unwrap();
    assert_eq!((moved.status, moved.ok(), moved.json()), (302, false, None));
    let form = [
        Part::Text {
            name: "text".into(),
            value: "a \"coin\" counter".into(),
        },
        Part::File {
            name: "file".into(),
            filename: "memo.md".into(),
            mime: "text/markdown".into(),
            bytes: b"count".to_vec(),
        },
    ];
    let echoed = c
        .fetch("POST", &stub.url, "/form", Some(Body::Form(&form)), None)
        .await
        .unwrap();
    let boundary = echoed.text.lines().next().unwrap().to_string();
    assert!(boundary.starts_with("------CanopyFormBoundary"));
    assert_eq!(
        echoed.text,
        format!(
            "{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\na \"coin\" counter\r\n\
             {boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"memo.md\"\r\nContent-Type: text/markdown\r\n\r\ncount\r\n\
             {boundary}--\r\n"
        )
    );
    assert_eq!(
        form_record(&form),
        json!({"text": ["a \"coin\" counter"], "file": ["file:memo.md:count"]})
    );
    let down = c.fetch("GET", "http://127.0.0.1:1", "/x", None, None).await;
    assert_eq!(
        down,
        Err("ECONNREFUSED: Unable to connect. Is the computer able to access the url?".into())
    );
}
