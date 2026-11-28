//! Port of the origin-gate cases of `src/core/library.test.ts` and of
//! `src/core/cors.test.ts`. The rest of library.test.ts drives the Python
//! library worker, which this crate does not hold.

use canopy_auth::{
    OriginPolicy, PREFLIGHT_HEADERS, Req, coord_api_host, cors_headers, library_origin_allowed,
    open_bind, parse_origins, tailnet_host,
};

fn req(host: &str, path: &str, headers: &[(&str, &str)]) -> Req {
    Req::new("GET", &format!("http://{host}{path}"))
        .unwrap()
        .with_headers(headers.iter().copied())
}

fn lib(host: &str, headers: &[(&str, &str)]) -> Req {
    req(host, "/library/", headers)
}

fn public(origin: Option<&str>) -> OriginPolicy {
    OriginPolicy {
        public_origin: origin.map(str::to_string),
        ..OriginPolicy::default()
    }
}

fn open() -> OriginPolicy {
    OriginPolicy {
        open: true,
        ..OriginPolicy::default()
    }
}

fn strings(v: &[&str]) -> Vec<String> {
    v.iter().map(|s| s.to_string()).collect()
}

#[test]
fn public_library_requests_require_the_configured_https_proxy_origin() {
    let origin = "https://canopy.example";
    let https = ("x-forwarded-proto", "https");
    let allowed =
        |host: &str, h: &[(&str, &str)], p: &OriginPolicy| library_origin_allowed(&lib(host, h), p);
    assert!(allowed("canopy.example", &[https], &public(Some(origin))));
    assert!(allowed(
        "canopy.example",
        &[https, ("origin", origin)],
        &public(Some(origin))
    ));
    assert!(!allowed("canopy.example", &[https], &public(None)));
    assert!(!allowed("canopy.example", &[], &public(Some(origin))));
    assert!(!allowed(
        "canopy.example.evil",
        &[https],
        &public(Some(origin))
    ));
    assert!(!allowed(
        "canopy.example",
        &[https, ("origin", "https://evil.example")],
        &public(Some(origin))
    ));
}

#[test]
fn a_server_listening_beyond_loopback_takes_same_origin_requests_by_a_tailnet_name() {
    let allowed =
        |host: &str, h: &[(&str, &str)], p: &OriginPolicy| library_origin_allowed(&lib(host, h), p);
    // the tailnet is the edge: an address literal, a MagicDNS name, a bare machine name
    assert!(allowed("100.68.139.95:7850", &[], &open()));
    assert!(allowed("macmini-2018.tail2d2c60.ts.net:7850", &[], &open()));
    assert!(allowed(
        "macmini-2018:7850",
        &[("origin", "http://macmini-2018:7850")],
        &open()
    ));
    // an Origin that is not the page's own, or a cross-site fetch, is still out
    assert!(!allowed(
        "macmini-2018:7850",
        &[("origin", "http://evil.example")],
        &open()
    ));
    assert!(!allowed(
        "macmini-2018:7850",
        &[("sec-fetch-site", "cross-site")],
        &open()
    ));
    // a dotted public name could be an attacker's domain pointed at the same address
    assert!(!allowed("canopy.attacker.example:7850", &[], &open()));
    // and none of it applies while the server binds loopback
    assert!(!allowed(
        "100.68.139.95:7850",
        &[],
        &OriginPolicy::default()
    ));
    assert!(!allowed("macmini-2018:7850", &[], &OriginPolicy::default()));
}

#[test]
fn a_listed_origin_may_call_from_another_site_and_its_own_page_may_by_host() {
    let listed = OriginPolicy {
        origins: strings(&[
            "https://canopy.beric.ca",
            "https://erics-macbook-pro.tail2d2c60.ts.net:7850",
        ]),
        ..OriginPolicy::default()
    };
    let tree = |host: &str, h: &[(&str, &str)]| req(host, "/api/tree", h);
    let ts = "erics-macbook-pro.tail2d2c60.ts.net:7850";
    // another canopy page, cross-site to the browser
    let other = tree(
        "127.0.0.1:7850",
        &[
            ("origin", "https://canopy.beric.ca"),
            ("sec-fetch-site", "cross-site"),
        ],
    );
    assert!(library_origin_allowed(&other, &listed));
    // the page tailscale serve hands out: https to the browser, http here, no Origin on a GET
    assert!(library_origin_allowed(
        &tree(ts, &[("sec-fetch-site", "same-origin")]),
        &listed
    ));
    // the same page's POST carries its https Origin
    let own = format!("https://{ts}");
    assert!(library_origin_allowed(
        &tree(ts, &[("origin", &own)]),
        &listed
    ));
    // unlisted stays out, and so does a cross-site request with no Origin to a listed host
    assert!(!library_origin_allowed(
        &tree("127.0.0.1:7850", &[("origin", "https://evil.example")]),
        &listed
    ));
    assert!(!library_origin_allowed(
        &tree(ts, &[("sec-fetch-site", "cross-site")]),
        &listed
    ));
    // no list, no change from before
    let bare = tree("127.0.0.1:7850", &[("origin", "https://canopy.beric.ca")]);
    assert!(!library_origin_allowed(&bare, &OriginPolicy::default()));
}

#[test]
fn the_coordinators_address_passes_by_its_exact_host_and_nothing_near_it_does() {
    let hosts: Vec<String> = coord_api_host(Some("http://10.250.14.1:7850"))
        .into_iter()
        .collect();
    assert_eq!(hosts, ["10.250.14.1:7850"]);
    let with_hosts = OriginPolicy {
        open: true,
        hosts,
        ..OriginPolicy::default()
    };
    let about = |host: &str, h: &[(&str, &str)]| req(host, "/api/about", h);
    // curl from the coord container: no Origin, nothing marked cross-site
    assert!(!library_origin_allowed(
        &about("10.250.14.1:7850", &[]),
        &open()
    ));
    assert!(library_origin_allowed(
        &about("10.250.14.1:7850", &[]),
        &with_hosts
    ));
    assert!(library_origin_allowed(
        &about("10.250.14.1:7850", &[("origin", "http://10.250.14.1:7850")]),
        &with_hosts
    ));
    // a page elsewhere, a rebound name or another port is refused
    assert!(!library_origin_allowed(
        &about("10.250.14.1:7850", &[("origin", "http://evil.example")]),
        &with_hosts
    ));
    assert!(!library_origin_allowed(
        &about("10.250.14.1:7850", &[("sec-fetch-site", "cross-site")]),
        &with_hosts
    ));
    for host in [
        "10.250.14.1:7851",
        "10.250.14.2:7850",
        "rebound.example:7850",
    ] {
        assert!(
            !library_origin_allowed(&about(host, &[]), &with_hosts),
            "{host}"
        );
    }
}

#[test]
fn coord_api_host_takes_an_http_urls_host_and_nothing_else() {
    assert_eq!(
        coord_api_host(Some("http://10.250.14.1:7850")).as_deref(),
        Some("10.250.14.1:7850")
    );
    assert_eq!(
        coord_api_host(Some(" http://10.250.14.1:7850/ ")).as_deref(),
        Some("10.250.14.1:7850")
    );
    for raw in [
        None,
        Some(""),
        Some("10.250.14.1:7850"),
        Some("ftp://10.250.14.1:7850"),
    ] {
        assert_eq!(coord_api_host(raw), None, "{raw:?}");
    }
}

#[test]
fn a_library_given_origins_lets_its_own_listed_ts_net_page_through_the_gate() {
    let policy = OriginPolicy {
        origins: strings(&["https://box.tail0000.ts.net:7850"]),
        ..OriginPolicy::default()
    };
    let delete = Req::new("DELETE", "http://box.tail0000.ts.net:7850/api/library")
        .unwrap()
        .with_header("sec-fetch-site", "same-origin");
    assert!(library_origin_allowed(&delete, &policy));
}

#[test]
fn tailnet_host_and_open_bind() {
    for (host, want) in [
        ("100.64.0.1", true),
        ("100.127.255.254", true),
        ("100.63.0.1", false),
        ("100.128.0.1", false),
        ("mini.tail2d2c60.ts.net", true),
        ("mini", true),
        ("", false),
        ("mini.example.com", false),
    ] {
        assert_eq!(tailnet_host(host), want, "{host:?}");
    }
    assert!(!open_bind(None));
    assert!(!open_bind(Some("127.0.0.1")));
    assert!(open_bind(Some("0.0.0.0")));
    assert!(open_bind(Some("100.68.139.95")));
}

#[test]
fn rejects_foreign_origins_lookalike_hosts_and_cross_site_navigations() {
    let none = OriginPolicy::default();
    let open_req = |h: &[(&str, &str)]| req("127.0.0.1:7850", "/library/open", h);
    assert!(!library_origin_allowed(
        &open_req(&[("Origin", "https://evil.example")]),
        &none
    ));
    assert!(!library_origin_allowed(
        &open_req(&[("Sec-Fetch-Site", "cross-site")]),
        &none
    ));
    assert!(!library_origin_allowed(
        &req("127.0.0.1.evil.example", "/library/", &[]),
        &none
    ));
    // and the plain loopback page passes
    assert!(library_origin_allowed(&open_req(&[]), &none));
}

mod cors {
    use super::*;

    #[test]
    fn parse_origins_keeps_exact_http_and_https_origins_trimmed_in_order() {
        assert_eq!(
            parse_origins(Some(" https://canopy.beric.ca , http://macmini-2018:7850 ")),
            ["https://canopy.beric.ca", "http://macmini-2018:7850"]
        );
    }

    #[test]
    fn parse_origins_drops_a_path_a_wildcard_another_scheme_and_empties() {
        assert_eq!(
            parse_origins(Some(
                "https://a.example/x,*,ftp://b.example,,https://c.example"
            )),
            ["https://c.example"]
        );
    }

    #[test]
    fn nothing_set_is_no_origins() {
        assert!(parse_origins(None).is_empty());
        assert!(parse_origins(Some("")).is_empty());
    }

    #[test]
    fn a_listed_origin_gets_itself_back_with_credentials() {
        let origins = strings(&["https://canopy.beric.ca"]);
        assert_eq!(
            cors_headers(Some("https://canopy.beric.ca"), &origins).unwrap(),
            [
                (
                    "Access-Control-Allow-Origin",
                    "https://canopy.beric.ca".to_string()
                ),
                ("Access-Control-Allow-Credentials", "true".to_string()),
                ("Vary", "Origin".to_string()),
            ]
        );
    }

    #[test]
    fn an_unlisted_or_missing_origin_gets_nothing() {
        let origins = strings(&["https://canopy.beric.ca"]);
        assert!(cors_headers(Some("https://evil.example"), &origins).is_none());
        assert!(cors_headers(None, &origins).is_none());
    }

    #[test]
    fn the_preflight_answer_never_names_a_wildcard() {
        assert!(!PREFLIGHT_HEADERS.iter().any(|(_, v)| v.contains('*')));
    }

    #[test]
    fn the_preflight_allows_every_method_the_api_answers_patch_included() {
        let methods = PREFLIGHT_HEADERS
            .iter()
            .find(|(k, _)| *k == "Access-Control-Allow-Methods")
            .unwrap()
            .1;
        assert_eq!(
            methods.split(", ").collect::<Vec<_>>(),
            ["GET", "POST", "DELETE", "PATCH"]
        );
    }
}
