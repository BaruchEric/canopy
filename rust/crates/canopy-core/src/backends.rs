//! The backends a page talks to (`src/core/backends.ts`): the config's
//! `backends` list read field by field, and this backend's own name.

use serde_json::{Map, Value, json};

use crate::peers::is_peer_name;

/// Whether `v` is exactly a URL origin with one of these schemes.
fn is_origin(v: &Value, schemes: &[&str]) -> bool {
    let Some(s) = v.as_str() else { return false };
    let Ok(u) = url::Url::parse(s) else {
        return false;
    };
    schemes.contains(&u.scheme()) && u.origin().ascii_serialization() == s
}

/// The config's `backends`: a peer name, at least one url, `public` https,
/// `tailnet` http or https, names unique (the first wins).
pub fn normalize_backends(v: &Value) -> Vec<Value> {
    let Some(list) = v.as_array() else {
        return vec![];
    };
    let mut out: Vec<Value> = vec![];
    for raw in list {
        let Some(r) = raw.as_object() else { continue };
        let Some(name) = r.get("name").and_then(Value::as_str) else {
            continue;
        };
        if !is_peer_name(name) || out.iter().any(|b| b["name"] == name) {
            continue;
        }
        let mut entry = Map::new();
        entry.insert("name".into(), json!(name));
        if let Some(p) = r.get("public") {
            if !is_origin(p, &["https"]) {
                continue;
            }
            entry.insert("public".into(), p.clone());
        }
        if let Some(t) = r.get("tailnet") {
            if !is_origin(t, &["http", "https"]) {
                continue;
            }
            entry.insert("tailnet".into(), t.clone());
        }
        if !entry.contains_key("public") && !entry.contains_key("tailnet") {
            continue;
        }
        out.push(Value::Object(entry));
    }
    out
}

/// This backend's name: its peer name when set, else its hostname's first
/// label as a peer-name slug.
pub fn self_name(own: Option<&str>, host: &str) -> String {
    if let Some(s) = own.filter(|s| !s.is_empty()) {
        return s.into();
    }
    let first = host.split('.').next().unwrap_or("").to_lowercase();
    // slice(0, 30) counts UTF-16 units; every unit that is not a slug
    // character becomes one dash
    let label: String = first
        .encode_utf16()
        .take(30)
        .map(|u| match char::from_u32(u32::from(u)) {
            Some(c) if c.is_ascii_lowercase() || c.is_ascii_digit() || c == '-' => c,
            _ => '-',
        })
        .collect();
    if label.is_empty() {
        return "canopy".into();
    }
    if label.starts_with(|c: char| c.is_ascii_lowercase()) {
        label
    } else {
        format!("b-{label}")
    }
}

/// The config's `self`: a peer name, else none.
pub fn config_self(raw: &Value) -> Option<String> {
    raw.get("self")
        .and_then(Value::as_str)
        .filter(|s| is_peer_name(s))
        .map(String::from)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn backends_keep_valid_entries_and_the_first_of_a_name() {
        let got = normalize_backends(&json!([
            { "name": "mini", "tailnet": "http://100.1.2.3:7850" },
            { "name": "mini", "tailnet": "http://other:7850" },
            { "name": "bad name!" , "tailnet": "http://x" },
            { "name": "pub", "public": "http://not-https.example" },
            { "name": "web", "public": "https://canopy.example.com" },
            { "name": "slash", "public": "https://canopy.example.com/" },
            { "name": "none" },
            "junk"
        ]));
        assert_eq!(
            got,
            vec![
                json!({ "name": "mini", "tailnet": "http://100.1.2.3:7850" }),
                json!({ "name": "web", "public": "https://canopy.example.com" }),
            ]
        );
        assert!(normalize_backends(&json!({})).is_empty());
    }

    #[test]
    fn self_name_slugs_the_hostname_when_unset() {
        assert_eq!(self_name(Some("scratch"), "x"), "scratch");
        assert_eq!(
            self_name(None, "Erics-MacBook-Pro.local"),
            "erics-macbook-pro"
        );
        assert_eq!(self_name(None, "42box.lan"), "b-42box");
        assert_eq!(self_name(None, ".lan"), "canopy");
        assert_eq!(self_name(None, "my_host"), "my-host");
    }
}
