//! Peers: canopy backends that keep each machine's clones in step over git
//! (`src/core/peers.ts`). What the git write half needs is here, and the
//! config's peers and sync mode read back; the passes are not ported yet.

use serde_json::{Map, Value, json};

/// `PEER_SYNC`: the sync modes, off first.
pub const PEER_SYNC: [&str; 3] = ["off", "dry", "on"];

/// `/^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9][A-Za-z0-9._-]*$/`: an ssh alias, a
/// user and an @ allowed in front.
fn is_ssh_alias(s: &str) -> bool {
    let word = |w: &str| {
        w.bytes()
            .all(|b| b.is_ascii_alphanumeric() || b"._-".contains(&b))
    };
    let host = match s.split_once('@') {
        Some((user, host)) if !user.is_empty() && word(user) => host,
        Some(_) => return false,
        None => s,
    };
    host.as_bytes()
        .first()
        .is_some_and(u8::is_ascii_alphanumeric)
        && word(host)
}

/// `normalizePeers()`: the config's peers, each with a name, an ssh alias
/// and a root without `..`; the first of a name wins.
pub fn normalize_peers(v: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = vec![];
    for raw in v.as_array().into_iter().flatten() {
        let Some(r) = raw.as_object() else { continue };
        let Some(name) = r
            .get("name")
            .and_then(Value::as_str)
            .filter(|n| is_peer_name(n))
        else {
            continue;
        };
        let Some(alias) = r
            .get("alias")
            .and_then(Value::as_str)
            .filter(|a| is_ssh_alias(a))
        else {
            continue;
        };
        let Some(root) = r
            .get("root")
            .and_then(Value::as_str)
            .filter(|t| !t.is_empty() && !t.contains(".."))
        else {
            continue;
        };
        if out.iter().any(|p| p["name"] == name) {
            continue;
        }
        let role = r
            .get("role")
            .and_then(Value::as_str)
            .filter(|x| *x == "git" || *x == "mirror")
            .unwrap_or("git");
        let mut peer = Map::new();
        peer.insert("name".into(), json!(name));
        peer.insert("alias".into(), json!(alias));
        peer.insert("root".into(), json!(root));
        peer.insert("role".into(), json!(role));
        if let Some(repos) = r.get("repos").and_then(Value::as_array) {
            let kept: Vec<&str> = repos
                .iter()
                .filter_map(Value::as_str)
                .filter(|g| !g.is_empty())
                .collect();
            peer.insert("repos".into(), json!(kept));
        }
        out.push(Value::Object(peer));
    }
    out
}

/// The config's `peerSync`, "off" for anything but a mode.
pub fn peer_sync(raw: &Value) -> &'static str {
    let v = raw.get("peerSync").and_then(Value::as_str);
    PEER_SYNC
        .into_iter()
        .find(|m| Some(*m) == v)
        .unwrap_or("off")
}

/// The push URL a peer remote carries, so a push never goes to a peer:
/// peers are pull-only and fast-forward only.
pub const NO_PUSH: &str = "canopy-peer-no-push";

/// A peer's name: lowercase, a letter first, at most 32, never "origin".
pub fn is_peer_name(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b.iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-')
        && s != "origin"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn peers_need_a_name_an_alias_and_a_root() {
        let v = json!([
            { "name": "mini", "alias": "eric@macmini-ts", "root": "/srv/dev", "role": "mirror", "repos": ["a", "", 3] },
            { "name": "mini", "alias": "x", "root": "/y" },
            { "name": "Bad", "alias": "x", "root": "/y" },
            { "name": "gpd", "alias": "@gpd", "root": "/y" },
            { "name": "nb", "alias": "gpd", "root": "/a/../b" },
            { "name": "de-soto", "alias": "desoto", "root": "~/dev", "role": "boss" },
            "x"
        ]);
        assert_eq!(
            serde_json::to_string(&normalize_peers(&v)).unwrap(),
            r#"[{"name":"mini","alias":"eric@macmini-ts","root":"/srv/dev","role":"mirror","repos":["a"]},{"name":"de-soto","alias":"desoto","root":"~/dev","role":"git"}]"#
        );
        assert_eq!(peer_sync(&json!({ "peerSync": "dry" })), "dry");
        assert_eq!(peer_sync(&json!({ "peerSync": "yes" })), "off");
        assert!(!is_ssh_alias("-x") && !is_ssh_alias("a b") && is_ssh_alias("a.b-c_d"));
    }

    #[test]
    fn a_peer_name_is_a_lowercase_slug_that_is_not_origin() {
        assert!(is_peer_name("mini"));
        assert!(is_peer_name("de-soto2"));
        assert!(!is_peer_name("origin"));
        assert!(!is_peer_name("2mini"));
        assert!(!is_peer_name("Mini"));
        assert!(!is_peer_name(""));
        assert!(!is_peer_name(&"a".repeat(33)));
    }
}
