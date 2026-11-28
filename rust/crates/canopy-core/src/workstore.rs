//! The work ledger on disk (`src/core/workstore.ts`): one JSON file per item
//! under `<configDir>/work/`, read back with each record checked as
//! `isWorkItem` checks it. The write stays in the TypeScript.

use crate::jsjson::{self, Unheld};
use crate::pathx::{join, js_cmp};
use crate::work::{WORK_STATES, is_work_id};
use serde_json::Value;

/// `<configDir>/work`
pub fn work_dir(config_dir: &str) -> String {
    join(config_dir, "work")
}

fn strings(v: Option<&Value>) -> bool {
    v.and_then(Value::as_array)
        .is_some_and(|a| a.iter().all(Value::is_string))
}

fn is_str(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_string)
}

fn is_num(v: Option<&Value>) -> bool {
    v.is_some_and(Value::is_number)
}

/// `isWorkFrom()`: a note, an issue, a coordinator's card or a trigger.
fn is_work_from(v: Option<&Value>) -> bool {
    let Some(o) = v.and_then(Value::as_object) else {
        return false;
    };
    match o.get("kind").and_then(Value::as_str) {
        Some("note") => true,
        Some("issue") => {
            is_str(o.get("service"))
                && is_str(o.get("key"))
                && o.get("link").is_none_or(Value::is_string)
        }
        Some("coordinator") => is_str(o.get("run")) && is_str(o.get("card")),
        Some("trigger") => is_str(o.get("event")),
        _ => false,
    }
}

/// `isWorkItem()`.
pub fn is_work_item(v: &Value) -> bool {
    let Some(o) = v.as_object() else {
        return false;
    };
    let every = |k: &str, f: &dyn Fn(&Value) -> bool| {
        o.get(k)
            .and_then(Value::as_array)
            .is_some_and(|a| a.iter().all(f))
    };
    let pr = |p: &Value| is_num(p.get("number")) && is_str(p.get("url")) && p.is_object();
    let note = |n: &Value| {
        n.is_object() && is_num(n.get("at")) && is_str(n.get("by")) && is_str(n.get("text"))
    };
    o.get("id").and_then(Value::as_str).is_some_and(is_work_id)
        && is_str(o.get("title"))
        && strings(o.get("repos"))
        && o.get("state")
            .and_then(Value::as_str)
            .is_some_and(|s| WORK_STATES.contains(&s))
        && is_work_from(o.get("from"))
        && strings(o.get("runs"))
        && strings(o.get("branches"))
        && every("prs", &pr)
        && strings(o.get("events"))
        && every("notes", &note)
        && is_num(o.get("createdAt"))
        && is_num(o.get("updatedAt"))
        && o.get("closedAt").is_none_or(Value::is_number)
        && o.get("reason").is_none_or(Value::is_string)
}

/// Why the items could not be read as the TypeScript reads them.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReadError {
    /// the folder is there but would not list: the TypeScript throws
    Folder(String),
    Unheld,
}

impl From<Unheld> for ReadError {
    fn from(_: Unheld) -> Self {
        ReadError::Unheld
    }
}

/// `readWorkItems()`: every valid record under `dir`, in id order, each as
/// the JSON it holds; a file that is not one, or whose name is not its id,
/// is left alone. No folder is no items.
pub fn read_work_items(dir: &str) -> Result<Vec<Value>, ReadError> {
    let entries = match std::fs::read_dir(dir) {
        Ok(d) => d,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(ReadError::Folder(e.to_string())),
    };
    let mut files: Vec<String> = entries
        .flatten()
        .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
        .map(|e| e.file_name().to_string_lossy().into_owned())
        .filter(|n| n.ends_with(".json"))
        .collect();
    files.sort_by(|a, b| js_cmp(a, b));
    let mut items = vec![];
    for file in files {
        let Ok(text) = jsjson::read_text(&join(dir, &file)) else {
            continue;
        };
        let Some(v) = jsjson::parse(&text)? else {
            continue;
        };
        let named = v
            .get("id")
            .and_then(Value::as_str)
            .is_some_and(|id| file == format!("{id}.json"));
        if is_work_item(&v) && named {
            items.push(v);
        }
    }
    // a work id is "w-" and base32, which the root locale orders as bytes do
    items.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    Ok(items)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn item(id: &str) -> Value {
        json!({ "id": id, "title": format!("work {id}"), "repos": ["r"], "state": "open", "from": { "kind": "note" }, "runs": [], "branches": [], "prs": [], "events": [], "notes": [], "createdAt": 1, "updatedAt": 1 })
    }

    #[test]
    fn one_file_per_item_read_back_in_id_order_a_bad_file_is_skipped_no_folder_is_none() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join("work1");
        let dir_s = dir.to_str().unwrap();
        assert_eq!(read_work_items(dir_s), Ok(vec![]));
        std::fs::create_dir_all(&dir).unwrap();
        for id in ["w-testbbbb", "w-testaaaa"] {
            std::fs::write(dir.join(format!("{id}.json")), format!("{:#}\n", item(id))).unwrap();
        }
        std::fs::write(dir.join("broken.json"), "{").unwrap();
        std::fs::write(
            dir.join("w-testcccc.json"),
            json!({ "id": "nope" }).to_string(),
        )
        .unwrap();
        // a record under another file's name is not that item
        std::fs::write(dir.join("w-testdddd.json"), item("w-testeeee").to_string()).unwrap();
        let ids: Vec<Value> = read_work_items(dir_s)
            .unwrap()
            .iter()
            .map(|i| i["id"].clone())
            .collect();
        assert_eq!(ids, vec![json!("w-testaaaa"), json!("w-testbbbb")]);
        assert_eq!(read_work_items(dir_s).unwrap()[0], item("w-testaaaa"));
    }

    #[test]
    fn a_record_is_checked_field_by_field() {
        assert!(is_work_item(&item("w-testaaaa")));
        let with = |k: &str, v: Value| {
            let mut i = item("w-testaaaa");
            i[k] = v;
            is_work_item(&i)
        };
        assert!(with("closedAt", json!(5)));
        assert!(!with("closedAt", json!("5")));
        assert!(with("reason", json!("why")));
        assert!(!with("state", json!("gone")));
        assert!(!with("id", json!("w-TESTAAAA")));
        assert!(!with("repos", json!(["r", 1])));
        assert!(with("prs", json!([{ "number": 4, "url": "u" }])));
        assert!(!with("prs", json!([{ "number": "4", "url": "u" }])));
        assert!(with(
            "notes",
            json!([{ "at": 1, "by": "eric", "text": "t" }])
        ));
        assert!(!with("notes", json!([{ "at": 1, "by": "eric" }])));
        assert!(with(
            "from",
            json!({ "kind": "issue", "service": "linear", "key": "K-1" })
        ));
        assert!(!with(
            "from",
            json!({ "kind": "issue", "service": "linear", "key": "K-1", "link": 3 })
        ));
        assert!(with(
            "from",
            json!({ "kind": "coordinator", "run": "r", "card": "c" })
        ));
        assert!(with("from", json!({ "kind": "trigger", "event": "e" })));
        assert!(!with("from", json!({ "kind": "mail" })));
    }

    #[test]
    fn a_folder_that_will_not_list_is_an_error_not_an_empty_ledger() {
        let root = tempfile::tempdir().unwrap();
        let file = root.path().join("work");
        std::fs::write(&file, "x").unwrap();
        assert!(matches!(
            read_work_items(file.to_str().unwrap()),
            Err(ReadError::Folder(_))
        ));
    }
}
