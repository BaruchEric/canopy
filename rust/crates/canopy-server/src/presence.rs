//! Who is on (`src/core/presence.ts` and the streams half of
//! src/server/index.ts): each page's event stream says which browser it is,
//! the devices list is those browsers, and a change to it reaches every
//! stream 300 ms after the last open or close, as a `devices` event and
//! then a `people` one.

use serde_json::{Map, Value, json};
use std::collections::BTreeMap;
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

/// `DEVICE_PLATFORMS` in core/types.ts.
pub const DEVICE_PLATFORMS: [&str; 6] = ["mac", "android", "windows", "linux", "ios", "other"];

/// how long a change to the list waits for the next before it is told
pub const TELL_AFTER: std::time::Duration = std::time::Duration::from_millis(300);

/// One page's stream: the browser it says it is.
#[derive(Debug, Clone, PartialEq)]
pub struct Stream {
    pub id: String,
    pub name: String,
    pub platform: String,
    pub address: String,
    pub since: f64,
    pub person: Option<String>,
}

/// The first `n` UTF-16 units of `s`, as JavaScript's `slice` cuts.
fn js_slice(s: &str, n: usize) -> String {
    let mut units = 0;
    let mut out = String::new();
    for c in s.chars() {
        units += c.len_utf16();
        if units > n {
            break;
        }
        out.push(c);
    }
    out
}

/// One query value as `URLSearchParams.get` reads it: `+` a space, the
/// percent escapes decoded, the first of a repeated key.
fn param(query: &str, key: &str) -> Option<String> {
    form_urlencoded::parse(query.as_bytes())
        .find(|(k, _)| k == key)
        .map(|(_, v)| v.into_owned())
}

/// `parseStream()`: the browser a stream's query names, or None when its
/// id is not one.
pub fn parse_stream(query: &str, address: &str, now: f64) -> Option<Stream> {
    let id = param(query, "client").unwrap_or_default();
    if id.len() != 16
        || !id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return None;
    }
    let name = js_slice(param(query, "name").unwrap_or_default().trim(), 40);
    let platform = param(query, "platform").unwrap_or_else(|| "other".into());
    Some(Stream {
        id,
        name: if name.is_empty() {
            "a browser".into()
        } else {
            name
        },
        platform: if DEVICE_PLATFORMS.contains(&platform.as_str()) {
            platform
        } else {
            "other".into()
        },
        address: address.into(),
        since: now,
        person: None,
    })
}

/// `devicesOf()`: one device per browser, its streams counted, named as
/// its newest stream names it, the first on first.
pub fn devices_of<'a>(streams: impl Iterator<Item = &'a Stream>) -> Vec<Value> {
    let mut by_id: Vec<(Map<String, Value>, f64, f64)> = vec![];
    for s in streams {
        let Some((d, since, named)) = by_id.iter_mut().find(|(d, ..)| d["id"] == s.id.as_str())
        else {
            let mut d = Map::new();
            d.insert("id".into(), json!(s.id));
            d.insert("name".into(), json!(s.name));
            d.insert("platform".into(), json!(s.platform));
            d.insert("address".into(), json!(s.address));
            d.insert("since".into(), ms(s.since));
            d.insert("streams".into(), json!(1));
            if let Some(p) = &s.person {
                d.insert("person".into(), json!(p));
            }
            by_id.push((d, s.since, s.since));
            continue;
        };
        let n = d["streams"].as_u64().unwrap_or(0) + 1;
        d.insert("streams".into(), json!(n));
        if s.since < *since {
            *since = s.since;
            d.insert("since".into(), ms(s.since));
        }
        if s.since >= *named {
            d.insert("name".into(), json!(s.name));
            *named = s.since;
            match &s.person {
                Some(p) => {
                    d.insert("person".into(), json!(p));
                }
                None => {
                    d.shift_remove("person");
                }
            }
        }
    }
    // a stable sort, as JavaScript's is
    by_id.sort_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
    by_id.into_iter().map(|(d, ..)| Value::Object(d)).collect()
}

/// a clock reading in ms as JSON writes it
fn ms(at: f64) -> Value {
    if at.fract() == 0.0 {
        json!(at as i64)
    } else {
        json!(at)
    }
}

/// The streams open now, in the order they opened.
#[derive(Default)]
pub struct Presence {
    streams: Mutex<BTreeMap<u64, Stream>>,
    next: AtomicU64,
    /// the last change told; a tell that finds a newer one leaves it to that
    told: AtomicU64,
}

impl Presence {
    pub fn devices(&self) -> Vec<Value> {
        let streams = self.streams.lock().unwrap_or_else(|e| e.into_inner());
        devices_of(streams.values())
    }

    /// Keeps the stream until its key is dropped.
    pub fn open(&self, s: Stream) -> u64 {
        let key = self.next.fetch_add(1, Ordering::SeqCst);
        self.streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .insert(key, s);
        key
    }

    pub fn close(&self, key: u64) -> bool {
        self.streams
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .remove(&key)
            .is_some()
    }

    /// A ticket for the next tell: the tell goes out only if no change came
    /// after it.
    pub fn changed(&self) -> u64 {
        self.told.fetch_add(1, Ordering::SeqCst) + 1
    }

    pub fn latest(&self, ticket: u64) -> bool {
        self.told.load(Ordering::SeqCst) == ticket
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_stream_names_its_browser_or_is_none() {
        let s = parse_stream(
            "client=0123456789abcdef&name=+Eric%27s+Mac+&platform=mac",
            "127.0.0.1",
            5.0,
        )
        .unwrap();
        assert_eq!(
            (s.name.as_str(), s.platform.as_str(), s.since),
            ("Eric's Mac", "mac", 5.0)
        );
        let other = parse_stream("client=0123456789abcdef&platform=beos", "a", 1.0).unwrap();
        assert_eq!(
            (other.name.as_str(), other.platform.as_str()),
            ("a browser", "other")
        );
        assert!(parse_stream("client=0123456789ABCDEF", "a", 1.0).is_none());
        assert!(parse_stream("name=x", "a", 1.0).is_none());
        let long = parse_stream(
            &format!("client=0123456789abcdef&name={}", "é".repeat(50)),
            "a",
            1.0,
        )
        .unwrap();
        assert_eq!(long.name.chars().count(), 40);
    }

    #[test]
    fn one_device_per_browser_named_by_its_newest_stream() {
        let s = |id: &str, name: &str, since: f64, person: Option<&str>| Stream {
            id: id.into(),
            name: name.into(),
            platform: "mac".into(),
            address: "a".into(),
            since,
            person: person.map(String::from),
        };
        let list = [
            s("bbbbbbbbbbbbbbbb", "phone", 20.0, None),
            s("aaaaaaaaaaaaaaaa", "old", 10.0, Some("owner")),
            s("aaaaaaaaaaaaaaaa", "new", 30.0, None),
        ];
        assert_eq!(
            serde_json::to_string(&devices_of(list.iter())).unwrap(),
            r#"[{"id":"aaaaaaaaaaaaaaaa","name":"new","platform":"mac","address":"a","since":10,"streams":2},{"id":"bbbbbbbbbbbbbbbb","name":"phone","platform":"mac","address":"a","since":20,"streams":1}]"#
        );
    }

    #[test]
    fn a_tell_goes_out_only_when_it_is_the_last_change() {
        let p = Presence::default();
        let a = p.changed();
        let b = p.changed();
        assert!(!p.latest(a) && p.latest(b));
        let k = p.open(parse_stream("client=0123456789abcdef", "a", 1.0).unwrap());
        assert_eq!(p.devices().len(), 1);
        assert!(p.close(k) && !p.close(k));
        assert!(p.devices().is_empty());
    }
}
