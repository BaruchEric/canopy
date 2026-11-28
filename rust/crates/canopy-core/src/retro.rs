//! The incubator retros' improvements list (`src/core/retro.ts`):
//! `incubator/improvements.json` read back (`parseImprovements`), the keys
//! on offer (`offered`) and a workflow named in advice (`adviceWorkflow`),
//! which is what `GET /api/incubator/advice` answers. Folding a retro's
//! advice in, deciding a key, the markdown and the retro itself stay in
//! the TypeScript.

use crate::js::num as js_num;
use crate::jsjson::{self, Unheld};
use crate::pathx::{js_squash_ws, js_trim};
use serde_json::{Map, Value, json};

const LESSON_MAX: usize = 300;
pub const EDIT_MAX: usize = 4000;
/// how many more sprouts bring a dismissed or accepted key back
pub const RECUR_AGAIN: f64 = 3.0;

fn slug_word(w: &str) -> bool {
    !w.is_empty()
        && w.bytes()
            .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit())
}

/// `KEY_RE`: lowercase words and digits joined by single dashes.
pub fn is_key(k: &str) -> bool {
    k.split('-').all(slug_word)
}

/// `WORKFLOW_RE`: a letter or digit, then at most 40 of them or dashes.
fn is_workflow_name(name: &str) -> bool {
    let b = name.as_bytes();
    let ok = |c: &u8| c.is_ascii_lowercase() || c.is_ascii_digit();
    !b.is_empty() && b.len() <= 41 && ok(&b[0]) && b[1..].iter().all(|c| ok(c) || *c == b'-')
}

/// `adviceWorkflow()`: the workflow a file names, by its name, its `.md` or
/// a `workflows/` or `lib/workflows/` path, else None.
pub fn advice_workflow(file: &str) -> Option<String> {
    let t = js_trim(file);
    let name_of = |rest: &str| -> Option<String> {
        let name = rest.strip_suffix(".md").unwrap_or(rest);
        let b = name.as_bytes();
        let shaped = !b.is_empty()
            && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
            && b.iter()
                .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'-');
        shaped.then(|| name.to_string())
    };
    let rest = t
        .strip_prefix("lib/workflows/")
        .or_else(|| t.strip_prefix("workflows/"));
    let name = rest.and_then(name_of).or_else(|| name_of(t))?;
    is_workflow_name(&name).then_some(name)
}

/// `oneLine()`: whitespace runs as one space, trimmed, cut to `max` UTF-16
/// units.
fn one_line(s: &str, max: usize) -> Result<String, Unheld> {
    jsjson::slice_units(js_trim(&js_squash_ws(s)), max).ok_or(Unheld)
}

/// One sprout that gave a key.
#[derive(Debug, Clone, PartialEq)]
pub struct AdviceFrom {
    pub id: String,
    pub title: String,
    pub at: f64,
}

/// The user's answer on a key, at its count then.
#[derive(Debug, Clone, PartialEq)]
pub struct Decided {
    pub accept: bool,
    pub at: f64,
    pub count: f64,
}

/// One key on the list (`AdviceEntry`).
#[derive(Debug, Clone, PartialEq)]
pub struct AdviceEntry {
    pub key: String,
    pub lesson: String,
    pub file: Option<String>,
    pub edit: Option<String>,
    pub from: Vec<AdviceFrom>,
    pub decided: Option<Decided>,
}

/// `parseImprovements()`: each entry checked and a broken one dropped;
/// Ok(None) for a file that is not the list at all, Err where a cut would
/// halve a surrogate pair or the file holds what serde_json cannot.
pub fn parse_improvements(text: &str) -> Result<Option<Vec<AdviceEntry>>, Unheld> {
    let Some(raw) = jsjson::parse(text)? else {
        return Ok(None);
    };
    let Some(entries) = raw.get("entries").and_then(Value::as_object) else {
        return Ok(None);
    };
    let mut out = vec![];
    for (key, e) in entries {
        let Some(o) = e.as_object() else { continue };
        let (Some(lesson), Some(from)) = (
            o.get("lesson").and_then(Value::as_str),
            o.get("from").and_then(Value::as_array),
        ) else {
            continue;
        };
        if o.get("key").and_then(Value::as_str) != Some(key) || !is_key(key) {
            continue;
        }
        let from = from
            .iter()
            .filter_map(|f| {
                Some(AdviceFrom {
                    id: f.get("id")?.as_str()?.to_string(),
                    title: f.get("title")?.as_str()?.to_string(),
                    at: f.get("at")?.as_f64()?,
                })
            })
            .collect();
        let decided = o.get("decided").and_then(|d| {
            Some(Decided {
                accept: d.get("accept")?.as_bool()?,
                at: d.get("at")?.as_f64()?,
                count: d.get("count")?.as_f64()?,
            })
        });
        let file = o
            .get("file")
            .and_then(Value::as_str)
            .and_then(advice_workflow);
        let edit = match o.get("edit").and_then(Value::as_str) {
            Some(e) => jsjson::slice_units(e, EDIT_MAX).ok_or(Unheld)?,
            None => String::new(),
        };
        out.push(AdviceEntry {
            key: key.clone(),
            lesson: one_line(lesson, LESSON_MAX)?,
            file,
            edit: (!edit.is_empty()).then_some(edit),
            from,
            decided,
        });
    }
    Ok(Some(out))
}

fn count_of(e: &AdviceEntry) -> f64 {
    e.from.len() as f64
}

fn last_at(e: &AdviceEntry) -> f64 {
    e.from.iter().fold(0.0, |m, f| m.max(f.at))
}

/// A comparator's `b - a` as an order: most first, and -0 equal to 0 as
/// JavaScript's sort takes it.
fn most_first(a: f64, b: f64) -> std::cmp::Ordering {
    (b - a)
        .partial_cmp(&0.0)
        .unwrap_or(std::cmp::Ordering::Equal)
}

fn is_offered(e: &AdviceEntry) -> bool {
    e.decided
        .as_ref()
        .is_none_or(|d| count_of(e) >= d.count + RECUR_AGAIN)
}

/// `offered()`: the keys on offer, most repeated first, then the newest,
/// then by key (a key is lowercase letters, digits and dashes, which the
/// root locale orders as bytes do), each as `AdviceOffer`.
pub fn offered(entries: &[AdviceEntry]) -> Vec<Value> {
    let mut on: Vec<&AdviceEntry> = entries.iter().filter(|e| is_offered(e)).collect();
    on.sort_by(|a, b| {
        most_first(count_of(a), count_of(b))
            .then(most_first(last_at(a), last_at(b)))
            .then_with(|| a.key.cmp(&b.key))
    });
    on.into_iter()
        .map(|e| {
            let mut from: Vec<&AdviceFrom> = e.from.iter().collect();
            from.sort_by(|a, b| most_first(a.at, b.at));
            let titles: Vec<&str> = from.iter().take(5).map(|f| f.title.as_str()).collect();
            let mut o = Map::new();
            o.insert("key".into(), json!(e.key));
            o.insert("lesson".into(), json!(e.lesson));
            if let Some(f) = &e.file {
                o.insert("file".into(), json!(f));
            }
            if let Some(x) = &e.edit {
                o.insert("edit".into(), json!(x));
            }
            o.insert("count".into(), js_num(count_of(e)));
            o.insert("titles".into(), json!(titles));
            o.insert("lastAt".into(), js_num(last_at(e)));
            Value::Object(o)
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn entry(key: &str, from: &[(&str, &str, f64)], decided: Option<Decided>) -> AdviceEntry {
        AdviceEntry {
            key: key.into(),
            lesson: key.into(),
            file: None,
            edit: None,
            from: from
                .iter()
                .map(|(id, title, at)| AdviceFrom {
                    id: (*id).into(),
                    title: (*title).into(),
                    at: *at,
                })
                .collect(),
            decided,
        }
    }

    #[test]
    fn advice_workflow_takes_a_name_a_md_or_a_lib_workflows_path_and_nothing_else() {
        assert_eq!(advice_workflow("scout").as_deref(), Some("scout"));
        assert_eq!(advice_workflow("scout.md").as_deref(), Some("scout"));
        assert_eq!(
            advice_workflow("lib/workflows/build-new.md").as_deref(),
            Some("build-new")
        );
        assert_eq!(
            advice_workflow("workflows/scout.md").as_deref(),
            Some("scout")
        );
        assert_eq!(advice_workflow("../scout.md"), None);
        assert_eq!(advice_workflow("lib/workflows/../x.md"), None);
        assert_eq!(advice_workflow("Scout"), None);
        assert_eq!(advice_workflow(""), None);
        // past WORKFLOW_RE's 41 characters
        assert_eq!(advice_workflow(&"a".repeat(42)), None);
        assert_eq!(advice_workflow(" scout.md\n").as_deref(), Some("scout"));
    }

    #[test]
    fn parse_improvements_keeps_good_entries_and_drops_broken_ones() {
        let good = json!({ "key": "a", "lesson": "l", "file": "lib/workflows/scout.md", "from": [{ "id": "sp_1", "title": "One", "at": 1 }], "decided": { "accept": false, "at": 2, "count": 1 } });
        let text = json!({ "entries": { "a": good, "b": { "key": "x", "lesson": "l", "from": [] }, "c d": { "key": "c d", "lesson": "l", "from": [] } } }).to_string();
        let st = parse_improvements(&text).unwrap().unwrap();
        assert_eq!(
            st,
            vec![AdviceEntry {
                key: "a".into(),
                lesson: "l".into(),
                file: Some("scout".into()),
                edit: None,
                from: vec![AdviceFrom {
                    id: "sp_1".into(),
                    title: "One".into(),
                    at: 1.0
                }],
                decided: Some(Decided {
                    accept: false,
                    at: 2.0,
                    count: 1.0
                }),
            }]
        );
        assert_eq!(parse_improvements("nope"), Ok(None));
        assert_eq!(parse_improvements("[]"), Ok(None));
    }

    #[test]
    fn a_lesson_is_one_line_cut_and_an_edit_is_cut_and_a_cut_that_halves_a_pair_is_unheld() {
        let long = format!("  a\n\tb {}", "x".repeat(400));
        let text = json!({ "entries": { "k": { "key": "k", "lesson": long, "edit": "e".repeat(5000), "from": [] } } }).to_string();
        let st = parse_improvements(&text).unwrap().unwrap();
        assert_eq!(st[0].lesson.encode_utf16().count(), LESSON_MAX);
        assert!(st[0].lesson.starts_with("a b xx"));
        assert_eq!(st[0].edit.as_ref().map(String::len), Some(EDIT_MAX));
        let halved = format!("{}😀", "x".repeat(299));
        let text =
            json!({ "entries": { "k": { "key": "k", "lesson": halved, "from": [] } } }).to_string();
        assert_eq!(parse_improvements(&text), Err(Unheld));
    }

    #[test]
    fn a_dismissed_key_comes_back_after_three_more_sprouts_an_accepted_one_too() {
        for accept in [false, true] {
            let d = Some(Decided {
                accept,
                at: 11.0,
                count: 1.0,
            });
            let one = [("sp_1", "One", 10.0)];
            assert!(offered(&[entry("a", &one, d.clone())]).is_empty());
            let three = [
                ("sp_1", "One", 10.0),
                ("sp_2", "Two", 20.0),
                ("sp_3", "Three", 30.0),
            ];
            assert!(offered(&[entry("a", &three, d.clone())]).is_empty());
            let four = [
                ("sp_1", "One", 10.0),
                ("sp_2", "Two", 20.0),
                ("sp_3", "Three", 30.0),
                ("sp_4", "Four", 40.0),
            ];
            let o = offered(&[entry("a", &four, d)]);
            assert_eq!(
                o.iter().map(|x| x["count"].clone()).collect::<Vec<_>>(),
                vec![json!(4)]
            );
        }
    }

    #[test]
    fn offers_sort_by_count_then_the_newest() {
        let st = [
            entry("x", &[("sp_1", "One", 10.0), ("sp_3", "Three", 30.0)], None),
            entry("y", &[("sp_2", "Two", 20.0)], None),
            entry("z", &[("sp_4", "Four", 40.0)], None),
        ];
        let keys: Vec<Value> = offered(&st).iter().map(|o| o["key"].clone()).collect();
        assert_eq!(keys, vec![json!("x"), json!("z"), json!("y")]);
        let x = &offered(&st)[0];
        assert_eq!(x["titles"], json!(["Three", "One"]));
        assert_eq!(x["lastAt"], json!(30));
        // a tie on both goes by key, a dash before a digit before a letter
        let tie = [
            entry("b", &[("s", "S", 5.0)], None),
            entry("a-b", &[("s", "S", 5.0)], None),
            entry("a1", &[("s", "S", 5.0)], None),
        ];
        let keys: Vec<Value> = offered(&tie).iter().map(|o| o["key"].clone()).collect();
        assert_eq!(keys, vec![json!("a-b"), json!("a1"), json!("b")]);
    }

    #[test]
    fn an_offer_lists_its_five_newest_titles_and_nothing_given_is_last_at_zero() {
        let from: Vec<(String, String, f64)> = (1..=7)
            .map(|i| (format!("sp_{i}"), format!("T{i}"), i as f64))
            .collect();
        let from: Vec<(&str, &str, f64)> = from
            .iter()
            .map(|(a, b, c)| (a.as_str(), b.as_str(), *c))
            .collect();
        let o = &offered(&[entry("k", &from, None)])[0];
        assert_eq!(o["titles"], json!(["T7", "T6", "T5", "T4", "T3"]));
        let none = &offered(&[entry("k", &[], None)])[0];
        assert_eq!(none["lastAt"], json!(0));
        assert_eq!(none["count"], json!(0));
    }
}
