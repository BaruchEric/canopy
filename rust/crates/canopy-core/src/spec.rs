//! The shared repo spec (`spec/` at canopy's root): one SPEC.md standard and
//! one DESIGN.md for every repo, and what canopy writes into a repo to adopt
//! it. `.canopy/spec.json` records the version and a sha256 of what the spec
//! owns in each file, so a hand edit reads as drift and an older version as
//! behind. (`src/core/spec.ts`)

use crate::pathx::{basename, join};
use crate::types::SpecState;
use regex::{NoExpand, Regex};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use sha2::{Digest, Sha256};
use std::sync::{LazyLock, OnceLock};

pub const RECORD: &str = ".canopy/spec.json";
const DESIGN: &str = "DESIGN.md";
const POINTERS: [&str; 2] = ["AGENTS.md", "CLAUDE.md"];

/// Where canopy's own spec lives: `$CANOPY_SPEC_DIR`, else `spec/` in the
/// checkout this crate was built from.
pub fn spec_dir() -> String {
    std::env::var("CANOPY_SPEC_DIR").unwrap_or_else(|_| {
        crate::pathx::normalize(concat!(env!("CARGO_MANIFEST_DIR"), "/../../../spec"))
    })
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum SpecHalf {
    Doc,
    Visual,
}

#[derive(Debug, Clone, PartialEq)]
pub struct Spec {
    pub version: String,
    /// file in the repo, the block's body with `{{version}}` filled in, in manifest order
    pub blocks: Vec<(String, String)>,
    pub design: String,
    pub template: String,
}

impl Spec {
    fn block(&self, file: &str) -> &str {
        self.blocks
            .iter()
            .find(|(f, _)| f == file)
            .map_or("", |(_, b)| b.as_str())
    }
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SpecRecord {
    pub version: String,
    pub halves: Vec<SpecHalf>,
    /// file in the repo, sha256 of what the spec owns in it
    pub blocks: Map<String, Value>,
}

pub fn load_spec(dir: &str) -> std::io::Result<Spec> {
    let read = |rel: &str| std::fs::read_to_string(join(dir, rel));
    let m: Value = serde_json::from_str(&read("manifest.json")?).map_err(std::io::Error::other)?;
    let field = |k: &str| {
        m.get(k)
            .and_then(Value::as_str)
            .map(String::from)
            .ok_or_else(|| std::io::Error::other(format!("manifest has no {k}")))
    };
    let version = field("version")?;
    let fill = |s: &str| s.replace("{{version}}", &version);
    let mut blocks = Vec::new();
    if let Some(obj) = m.get("blocks").and_then(Value::as_object) {
        for (file, rel) in obj {
            let rel = rel.as_str().unwrap_or_default();
            blocks.push((
                file.clone(),
                fill(&read(rel)?)
                    .trim_end_matches(crate::pathx::js_ws)
                    .to_string(),
            ));
        }
    }
    Ok(Spec {
        version: version.clone(),
        blocks,
        design: read(&field("design")?)?,
        template: read(&field("template")?)?,
    })
}

/// canopy's own spec, read once per process: the scan asks for every repo.
fn bundled_spec() -> Option<&'static Spec> {
    static BUNDLED: OnceLock<Option<Spec>> = OnceLock::new();
    BUNDLED.get_or_init(|| load_spec(&spec_dir()).ok()).as_ref()
}

pub fn sha256(s: &str) -> String {
    Sha256::digest(s.as_bytes())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}

static BLOCK: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"<!-- spec:begin v[^\s>]+ -->\n(?s:.)*?\n<!-- spec:end -->").unwrap()
});

pub fn render_block(spec: &Spec, file: &str) -> String {
    format!(
        "<!-- spec:begin v{} -->\n{}\n<!-- spec:end -->",
        spec.version,
        spec.block(file)
    )
}

/// The marker block in a file's text, or None when it has none.
pub fn find_block(text: &str) -> Option<String> {
    BLOCK.find(text).map(|m| m.as_str().to_string())
}

/// The text with its block replaced, or the block appended when it has none.
pub fn upsert_block(text: &str, block: &str) -> String {
    if BLOCK.is_match(text) {
        return BLOCK.replacen(text, 1, NoExpand(block)).into_owned();
    }
    let body = text.trim_end_matches(crate::pathx::js_ws);
    if body.is_empty() {
        format!("{block}\n")
    } else {
        format!("{body}\n\n{block}\n")
    }
}

/// What the spec owns in a file: DESIGN.md whole, otherwise its block.
pub fn owned_text(file: &str, text: Option<&str>) -> Option<String> {
    let text = text?;
    if file == DESIGN {
        Some(text.to_string())
    } else {
        find_block(text)
    }
}

/// The files a sync touches. The pointer goes into AGENTS.md and CLAUDE.md
/// where they exist, and into a new AGENTS.md when neither does.
pub fn managed_files(halves: &[SpecHalf], exists: impl Fn(&str) -> bool) -> Vec<String> {
    let mut out = Vec::new();
    if halves.contains(&SpecHalf::Doc) {
        out.push("SPEC.md".to_string());
        let pointers: Vec<String> = POINTERS
            .iter()
            .filter(|p| exists(p))
            .map(|p| p.to_string())
            .collect();
        if pointers.is_empty() {
            out.push("AGENTS.md".into());
        } else {
            out.extend(pointers);
        }
    }
    if halves.contains(&SpecHalf::Visual) {
        out.push(DESIGN.into());
    }
    out
}

pub fn parse_record(text: Option<&str>) -> Option<SpecRecord> {
    let v: Value = serde_json::from_str(text?).ok()?;
    let version = v.get("version")?.as_str()?.to_string();
    let halves = v.get("halves")?.as_array()?;
    let blocks = v.get("blocks")?.as_object()?.clone();
    let halves = halves
        .iter()
        .filter_map(|h| serde_json::from_value(h.clone()).ok())
        .collect();
    Some(SpecRecord {
        version,
        halves,
        blocks,
    })
}

/// A file's text in a repo, None when it is missing.
pub type Files = Vec<(String, Option<String>)>;

fn current<'a>(files: &'a Files, f: &str) -> Option<&'a str> {
    files
        .iter()
        .find(|(k, _)| k == f)
        .and_then(|(_, v)| v.as_deref())
}

pub struct Plan {
    pub writes: Vec<(String, String)>,
    pub removes: Vec<String>,
    pub record: SpecRecord,
}

/// The bytes a sync writes, the files it removes, and the record it leaves.
/// A DESIGN.md the last sync wrote goes when the visual half is dropped,
/// unless it was edited since: then it is the repo's own.
pub fn plan_sync(
    spec: &Spec,
    files: &Files,
    halves: &[SpecHalf],
    name: &str,
    old: Option<&SpecRecord>,
) -> Plan {
    let mut writes = Vec::new();
    let mut blocks = Map::new();
    for file in managed_files(halves, |f| current(files, f).is_some()) {
        let next = if file == DESIGN {
            spec.design.clone()
        } else {
            let block = render_block(spec, &file);
            let had = current(files, &file);
            match had {
                None if file == "SPEC.md" => {
                    spec.template
                        .replace("{{name}}", name)
                        .replacen("{{block}}", &block, 1)
                }
                _ => upsert_block(had.unwrap_or(""), &block),
            }
        };
        if Some(next.as_str()) != current(files, &file) {
            writes.push((file.clone(), next.clone()));
        }
        blocks.insert(
            file.clone(),
            Value::String(sha256(&owned_text(&file, Some(&next)).unwrap_or_default())),
        );
    }
    let mut removes = Vec::new();
    let design = current(files, DESIGN);
    let wrote = old
        .and_then(|o| o.blocks.get(DESIGN))
        .and_then(Value::as_str);
    if let (false, Some(d), Some(w)) = (halves.contains(&SpecHalf::Visual), design, wrote)
        && sha256(d) == w
    {
        removes.push(DESIGN.to_string());
    }
    Plan {
        writes,
        removes,
        record: SpecRecord {
            version: spec.version.clone(),
            halves: halves.to_vec(),
            blocks,
        },
    }
}

/// Where a repo stands against the spec. Drift wins over behind: a hand edit
/// is what a sync would overwrite, so it is the thing to look at.
pub fn spec_state(spec: &Spec, record: Option<&SpecRecord>, files: &Files) -> SpecState {
    let Some(record) = record else {
        return SpecState::NotAdopted;
    };
    for (file, hash) in &record.blocks {
        let owned = owned_text(file, current(files, file));
        if owned.is_none_or(|o| Some(sha256(&o).as_str()) != hash.as_str()) {
            return SpecState::Drifted;
        }
    }
    if record.version == spec.version {
        SpecState::InSync
    } else {
        SpecState::Behind
    }
}

fn read_text(path: &str) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

fn read_files<'a>(repo: &str, files: impl IntoIterator<Item = &'a str>) -> Files {
    files
        .into_iter()
        .map(|f| (f.to_string(), read_text(&join(repo, f))))
        .collect()
}

/// A local checkout's state: not adopted without a record, None when
/// canopy's own spec will not read.
pub fn repo_spec_state(repo: &str, spec: Option<&Spec>) -> Option<SpecState> {
    let Some(record) = parse_record(read_text(&join(repo, RECORD)).as_deref()) else {
        return Some(SpecState::NotAdopted);
    };
    let spec: &Spec = match spec {
        Some(s) => s,
        None => bundled_spec()?,
    };
    let files = read_files(repo, record.blocks.keys().map(String::as_str));
    Some(spec_state(spec, Some(&record), &files))
}

pub struct Synced {
    pub written: Vec<String>,
    pub removed: Vec<String>,
    pub record: SpecRecord,
}

/// Write the spec into a local checkout. Halves default to the repo's
/// recorded ones, then to the doc half alone: the visual half is opt-in.
pub fn sync_repo(
    repo: &str,
    halves: Option<Vec<SpecHalf>>,
    spec: Option<&Spec>,
) -> std::io::Result<Synced> {
    let loaded;
    let spec = match spec {
        Some(s) => s,
        None => {
            loaded = load_spec(&spec_dir())?;
            &loaded
        }
    };
    let old = parse_record(read_text(&join(repo, RECORD)).as_deref());
    let halves = halves
        .or_else(|| old.as_ref().map(|o| o.halves.clone()))
        .unwrap_or_else(|| vec![SpecHalf::Doc]);
    let files = read_files(repo, ["SPEC.md", "AGENTS.md", "CLAUDE.md", DESIGN]);
    let plan = plan_sync(spec, &files, &halves, &basename(repo), old.as_ref());
    for (file, text) in &plan.writes {
        std::fs::write(join(repo, file), text)?;
    }
    for file in &plan.removes {
        let _ = std::fs::remove_file(join(repo, file));
    }
    std::fs::create_dir_all(join(repo, ".canopy"))?;
    let json = serde_json::to_string_pretty(&plan.record).map_err(std::io::Error::other)?;
    std::fs::write(join(repo, RECORD), format!("{json}\n"))?;
    Ok(Synced {
        written: plan.writes.into_iter().map(|w| w.0).collect(),
        removed: plan.removes,
        record: plan.record,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn spec() -> Spec {
        Spec {
            version: "1.0.0".into(),
            blocks: vec![
                ("SPEC.md".into(), "keep seven sections".into()),
                ("AGENTS.md".into(), "read SPEC.md".into()),
                ("CLAUDE.md".into(), "read SPEC.md".into()),
            ],
            design: "---\nname: x\n---\n## Overview\n".into(),
            template: "# {{name}}\n\n{{block}}\n\n## What it is\n".into(),
        }
    }

    fn next() -> Spec {
        let mut s = spec();
        s.version = "1.1.0".into();
        s.blocks[0].1 = "keep eight sections".into();
        s
    }

    fn empty() -> Files {
        ["SPEC.md", "AGENTS.md", "CLAUDE.md", "DESIGN.md"]
            .iter()
            .map(|f| (f.to_string(), None))
            .collect()
    }

    fn with(files: &Files, writes: &[(String, String)]) -> Files {
        files
            .iter()
            .map(|(k, v)| {
                (
                    k.clone(),
                    writes
                        .iter()
                        .find(|(w, _)| w == k)
                        .map(|(_, t)| t.clone())
                        .or_else(|| v.clone()),
                )
            })
            .collect()
    }

    fn set(files: &Files, key: &str, value: Option<String>) -> Files {
        files
            .iter()
            .map(|(k, v)| (k.clone(), if k == key { value.clone() } else { v.clone() }))
            .collect()
    }

    #[test]
    fn upsert_appends_once_then_replaces_in_place() {
        let block = render_block(&spec(), "AGENTS.md");
        let once = upsert_block("# Agents\n\nhouse rules\n", &block);
        assert_eq!(once, format!("# Agents\n\nhouse rules\n\n{block}\n"));
        let newer = render_block(&next(), "AGENTS.md");
        let twice = upsert_block(&once, &newer);
        assert_eq!(twice, format!("# Agents\n\nhouse rules\n\n{newer}\n"));
        assert_eq!(find_block(&twice), Some(newer));
    }

    #[test]
    fn a_replacement_is_taken_literally() {
        let mut odd = spec();
        odd.blocks = vec![("AGENTS.md".into(), "costs $& and $1".into())];
        let text = upsert_block(
            &upsert_block("", &render_block(&spec(), "AGENTS.md")),
            &render_block(&odd, "AGENTS.md"),
        );
        assert!(text.contains("costs $& and $1"));
    }

    #[test]
    fn the_pointer_goes_where_the_agent_files_are() {
        assert_eq!(
            managed_files(&[SpecHalf::Doc], |_| false),
            vec!["SPEC.md", "AGENTS.md"]
        );
        assert_eq!(
            managed_files(&[SpecHalf::Doc], |f| f == "CLAUDE.md"),
            vec!["SPEC.md", "CLAUDE.md"]
        );
        assert_eq!(
            managed_files(&[SpecHalf::Doc, SpecHalf::Visual], |_| true),
            vec!["SPEC.md", "AGENTS.md", "CLAUDE.md", "DESIGN.md"]
        );
    }

    #[test]
    fn a_new_repo_gets_spec_md_from_the_template() {
        let plan = plan_sync(&spec(), &empty(), &[SpecHalf::Doc], "app", None);
        assert_eq!(
            plan.writes.iter().map(|w| w.0.as_str()).collect::<Vec<_>>(),
            vec!["SPEC.md", "AGENTS.md"]
        );
        assert!(plan.writes[0].1.starts_with(
            "# app\n\n<!-- spec:begin v1.0.0 -->\nkeep seven sections\n<!-- spec:end -->"
        ));
        assert_eq!(plan.record.version, "1.0.0");
        assert_eq!(plan.record.halves, vec![SpecHalf::Doc]);
        assert_eq!(
            spec_state(&spec(), Some(&plan.record), &with(&empty(), &plan.writes)),
            SpecState::InSync
        );
    }

    #[test]
    fn not_adopted_in_sync_behind_and_drifted() {
        assert_eq!(spec_state(&spec(), None, &empty()), SpecState::NotAdopted);
        let plan = plan_sync(
            &spec(),
            &empty(),
            &[SpecHalf::Doc, SpecHalf::Visual],
            "app",
            None,
        );
        let files = with(&empty(), &plan.writes);
        let r = Some(&plan.record);
        assert_eq!(spec_state(&spec(), r, &files), SpecState::InSync);
        assert_eq!(spec_state(&next(), r, &files), SpecState::Behind);
        let notes = format!("{}\nour notes\n", current(&files, "SPEC.md").unwrap());
        assert_eq!(
            spec_state(&spec(), r, &set(&files, "SPEC.md", Some(notes))),
            SpecState::InSync
        );
        let edited = current(&files, "AGENTS.md")
            .unwrap()
            .replace("read SPEC.md", "skim SPEC.md");
        assert_eq!(
            spec_state(&next(), r, &set(&files, "AGENTS.md", Some(edited))),
            SpecState::Drifted
        );
        assert_eq!(
            spec_state(
                &spec(),
                r,
                &set(
                    &files,
                    "DESIGN.md",
                    Some(format!("{}\nmore", spec().design))
                )
            ),
            SpecState::Drifted
        );
        assert_eq!(
            spec_state(&spec(), r, &set(&files, "DESIGN.md", None)),
            SpecState::Drifted
        );
    }

    #[test]
    fn a_second_sync_with_nothing_changed_writes_nothing() {
        let first = plan_sync(&spec(), &empty(), &[SpecHalf::Doc], "app", None);
        let again = plan_sync(
            &spec(),
            &with(&empty(), &first.writes),
            &[SpecHalf::Doc],
            "app",
            None,
        );
        assert!(again.writes.is_empty());
        assert_eq!(again.record, first.record);
    }

    #[test]
    fn a_record_that_is_not_one() {
        assert_eq!(parse_record(Some("{")), None);
        assert_eq!(parse_record(Some(r#"{"version":"1.0.0"}"#)), None);
        assert_eq!(parse_record(None), None);
    }

    #[test]
    fn on_disk_sync_and_drift() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_str().unwrap();
        std::fs::write(join(dir, "CLAUDE.md"), "# CLAUDE.md\n\nown rules\n").unwrap();
        assert_eq!(
            repo_spec_state(dir, Some(&spec())),
            Some(SpecState::NotAdopted)
        );
        let first = sync_repo(
            dir,
            Some(vec![SpecHalf::Doc, SpecHalf::Visual]),
            Some(&spec()),
        )
        .unwrap();
        let mut written = first.written.clone();
        written.sort();
        assert_eq!(written, vec!["CLAUDE.md", "DESIGN.md", "SPEC.md"]);
        assert!(
            std::fs::read_to_string(join(dir, "CLAUDE.md"))
                .unwrap()
                .starts_with("# CLAUDE.md\n\nown rules\n\n<!-- spec:begin v1.0.0 -->")
        );
        assert_eq!(repo_spec_state(dir, Some(&spec())), Some(SpecState::InSync));
        assert_eq!(repo_spec_state(dir, Some(&next())), Some(SpecState::Behind));
        let upgraded = sync_repo(dir, None, Some(&next())).unwrap();
        assert_eq!(
            upgraded.record.halves,
            vec![SpecHalf::Doc, SpecHalf::Visual]
        );
        assert_eq!(upgraded.written, vec!["SPEC.md", "CLAUDE.md"]);
        assert_eq!(repo_spec_state(dir, Some(&next())), Some(SpecState::InSync));
        std::fs::write(join(dir, "DESIGN.md"), "hand-made\n").unwrap();
        assert_eq!(
            repo_spec_state(dir, Some(&next())),
            Some(SpecState::Drifted)
        );
    }

    #[test]
    fn going_back_to_the_doc_half_removes_only_an_unedited_design() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().to_str().unwrap();
        sync_repo(
            dir,
            Some(vec![SpecHalf::Doc, SpecHalf::Visual]),
            Some(&spec()),
        )
        .unwrap();
        let back = sync_repo(dir, Some(vec![SpecHalf::Doc]), Some(&spec())).unwrap();
        assert_eq!(back.removed, vec!["DESIGN.md"]);
        assert!(!back.record.blocks.contains_key("DESIGN.md"));
        assert!(!std::path::Path::new(&join(dir, "DESIGN.md")).exists());
        assert_eq!(repo_spec_state(dir, Some(&spec())), Some(SpecState::InSync));
        sync_repo(
            dir,
            Some(vec![SpecHalf::Doc, SpecHalf::Visual]),
            Some(&spec()),
        )
        .unwrap();
        std::fs::write(join(dir, "DESIGN.md"), "the repo's own now\n").unwrap();
        let kept = sync_repo(dir, Some(vec![SpecHalf::Doc]), Some(&spec())).unwrap();
        assert!(kept.removed.is_empty());
        assert_eq!(
            std::fs::read_to_string(join(dir, "DESIGN.md")).unwrap(),
            "the repo's own now\n"
        );
    }

    #[test]
    fn the_bundled_spec_reads() {
        let s = load_spec(&spec_dir()).unwrap();
        assert!(Regex::new(r"^\d+\.\d+\.\d+$").unwrap().is_match(&s.version));
        for f in ["SPEC.md", "AGENTS.md", "CLAUDE.md"] {
            assert!(s.block(f).contains(&s.version));
            assert!(!s.block(f).contains("{{"));
        }
        assert!(s.template.contains("{{block}}"));
    }

    #[test]
    fn the_record_writes_as_the_typescript_does() {
        let plan = plan_sync(&spec(), &empty(), &[SpecHalf::Doc], "app", None);
        let json = serde_json::to_string_pretty(&plan.record).unwrap();
        assert!(json.starts_with("{\n  \"version\": \"1.0.0\",\n  \"halves\": [\n    \"doc\"\n  ],\n  \"blocks\": {\n    \"SPEC.md\": \""));
    }
}
