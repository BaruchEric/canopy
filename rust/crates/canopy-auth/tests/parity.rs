//! The Rust answers against the TS's own, recorded by the fixture script
//! (gen-fixtures.ts) from `src/core/callers.ts`, `library.ts`, `cors.ts`
//! and `client.ts`: every path the route table names, in seven variants and
//! seven methods; normalPath's decoding edges; and the origin gate over a
//! grid of hosts, Origins, Sec-Fetch-Site values, forwarded protocols and
//! server settings.

use canopy_auth::{
    CallerKind, OriginPolicy, Req, coord_api_host, is_loopback, is_loopback_host, kind_rights,
    lane, library_origin_allowed, needs, normal_path, open_bind, parse_origins, return_leg,
    tailnet_host,
};
use serde_json::Value;

fn fixture(name: &str) -> Value {
    let path = format!("{}/tests/fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
    serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap()
}

fn s(v: &Value) -> &str {
    v.as_str().unwrap()
}

fn opt(v: &Value) -> Option<&str> {
    v.as_str()
}

#[test]
fn needs_matches_the_ts_for_every_route() {
    let f = fixture("needs.json");
    let methods: Vec<&str> = f["methods"].as_array().unwrap().iter().map(s).collect();
    let codes = f["codes"].as_object().unwrap();
    let code_of = |need: &str| s(&codes[need]).to_string();
    let mut wrong = Vec::new();
    let table = f["table"].as_array().unwrap();
    assert!(table.len() > 5000, "the fixture lost its rows");
    for row in table {
        let path = s(&row[0]);
        let want = s(&row[1]);
        let got: String = methods
            .iter()
            .map(|m| code_of(needs(m, path).as_str()))
            .collect();
        if got != want {
            wrong.push(format!("{path}: want {want}, got {got}"));
        }
    }
    assert!(
        wrong.is_empty(),
        "{} paths differ:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
}

#[test]
fn normal_path_matches_decode_uri_component() {
    let f = fixture("needs.json");
    for case in f["normal"].as_array().unwrap() {
        let input = s(&case[0]);
        assert_eq!(
            normal_path(input).as_deref(),
            opt(&case[1]),
            "normalPath({input:?})"
        );
    }
}

#[test]
fn lanes_and_kind_rights_match() {
    let f = fixture("needs.json");
    for kind in CallerKind::ALL {
        let want: Option<Vec<&str>> = f["lanes"]
            .get(kind.as_str())
            .map(|v| v.as_array().unwrap().iter().map(s).collect());
        assert_eq!(lane(kind).map(<[&str]>::to_vec), want, "lane of {kind}");
        let rights: Vec<&str> = f["kindRights"][kind.as_str()]
            .as_array()
            .unwrap()
            .iter()
            .map(s)
            .collect();
        let got: Vec<&str> = kind_rights(kind).iter().map(|r| r.as_str()).collect();
        assert_eq!(got, rights, "rights of {kind}");
    }
}

#[test]
fn the_origin_gate_matches_over_the_grid() {
    let f = fixture("origin.json");
    let g = &f["grid"];
    let list = |k: &str| g[k].as_array().unwrap().clone();
    let (hosts, origins, sites, protos, configs, paths) = (
        list("hosts"),
        list("origins"),
        list("sites"),
        list("protos"),
        list("configs"),
        list("paths"),
    );
    let policies: Vec<OriginPolicy> = configs
        .iter()
        .map(|c| OriginPolicy {
            public_origin: opt(&c["publicOrigin"]).map(str::to_string),
            open: c["open"].as_bool().unwrap(),
            origins: c["origins"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| s(v).to_string())
                .collect(),
            hosts: c["hosts"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| s(v).to_string())
                .collect(),
        })
        .collect();
    let bits = s(&g["bits"]).as_bytes();
    let mut i = 0;
    let mut wrong = Vec::new();
    for host in &hosts {
        for o in &origins {
            for site in &sites {
                for proto in &protos {
                    for (c, policy) in policies.iter().enumerate() {
                        for path in &paths {
                            let url = format!("http://{}{}", s(host), s(path));
                            let mut req = Req::new("GET", &url).unwrap();
                            if let Some(o) = opt(o) {
                                req = req.with_header("origin", o);
                            }
                            if let Some(site) = opt(site) {
                                req = req.with_header("sec-fetch-site", site);
                            }
                            if let Some(proto) = opt(proto) {
                                req = req.with_header("x-forwarded-proto", proto);
                            }
                            let want = bits[i] == b'1';
                            let want_leg = bits[i + 1] == b'1';
                            i += 2;
                            let got = library_origin_allowed(&req, policy);
                            let got_leg = library_origin_allowed(&return_leg(&req), policy);
                            if got != want || got_leg != want_leg {
                                wrong.push(format!(
                                    "{url} origin={o} site={site} proto={proto} config={c}: want {want}/{want_leg}, got {got}/{got_leg}"
                                ));
                            }
                        }
                    }
                }
            }
        }
    }
    assert_eq!(i, bits.len(), "the grid's loop order changed");
    assert!(
        wrong.is_empty(),
        "{} cases differ:\n{}",
        wrong.len(),
        wrong.join("\n")
    );
    // a POST to the return leg keeps its cross-site mark
    let post = Req::new("POST", "http://127.0.0.1:7850/api/linear/callback")
        .unwrap()
        .with_header("sec-fetch-site", "cross-site");
    let none = OriginPolicy::default();
    assert_eq!(
        library_origin_allowed(&post, &none),
        g["post"]["want"].as_bool().unwrap()
    );
    assert_eq!(
        library_origin_allowed(&return_leg(&post), &none),
        g["post"]["leg"].as_bool().unwrap()
    );
}

#[test]
fn the_small_helpers_match() {
    let f = fixture("origin.json");
    for c in f["coordApi"].as_array().unwrap() {
        assert_eq!(
            coord_api_host(opt(&c[0])).as_deref(),
            opt(&c[1]),
            "coordApiHost({:?})",
            c[0]
        );
    }
    for c in f["tailnet"].as_array().unwrap() {
        assert_eq!(
            tailnet_host(s(&c[0])),
            c[1].as_bool().unwrap(),
            "tailnetHost({:?})",
            c[0]
        );
    }
    for c in f["originsRaw"].as_array().unwrap() {
        let want: Vec<&str> = c[1].as_array().unwrap().iter().map(s).collect();
        assert_eq!(parse_origins(opt(&c[0])), want, "parseOrigins({:?})", c[0]);
    }
    for c in f["binds"].as_array().unwrap() {
        assert_eq!(
            open_bind(opt(&c[0])),
            c[1].as_bool().unwrap(),
            "openBind({:?})",
            c[0]
        );
    }
    for c in f["loopAddrs"].as_array().unwrap() {
        assert_eq!(
            is_loopback(s(&c[0])),
            c[1].as_bool().unwrap(),
            "isLoopback({:?})",
            c[0]
        );
    }
    for c in f["loopHosts"].as_array().unwrap() {
        assert_eq!(
            is_loopback_host(s(&c[0])),
            c[1].as_bool().unwrap(),
            "isLoopbackHost({:?})",
            c[0]
        );
    }
}
