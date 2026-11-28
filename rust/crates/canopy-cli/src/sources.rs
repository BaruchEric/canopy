//! `canopy source` and `canopy sources` with nothing after them (the
//! listing in the `case "source"` arm of src/cli/index.ts): the extra
//! folders the config names, one line each, as `loadConfig` reads them.
//! `source add` and `source rm` still go to the TypeScript CLI: they write
//! config.json through `saveConfig`, which writes the whole normalized
//! config, and that writer is not ported.

use crate::render::Paint;
use canopy_core::types::{Source, SourcePlace};

/// The listing's lines: a source's label, its id, and where it is.
pub fn source_lines(sources: &[Source], paint: Paint) -> Vec<String> {
    if sources.is_empty() {
        return vec![paint.dim("no extra folders — canopy source add <dir> [--host h]")];
    }
    sources
        .iter()
        .map(|s| {
            let at = match &s.place {
                SourcePlace::Forgejo { url, .. } => format!("{}{url}", paint.sky("forgejo ")),
                SourcePlace::Ssh { host, path } => {
                    format!("{}{path}", paint.sky(&format!("{host}:")))
                }
                SourcePlace::Local { path } => path.clone(),
            };
            format!(
                "{} {}  {at}",
                paint.bold(&s.label),
                paint.dim(&format!("({})", s.id))
            )
        })
        .collect()
}

/// The listing, from this machine's config.
pub fn sources_cmd(paint: Paint) -> Result<Vec<String>, String> {
    let cfg = canopy_core::store::load_config().map_err(|e| e.to_string())?;
    Ok(source_lines(
        &canopy_core::store::stored_sources(&cfg.raw),
        paint,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn one_line_per_folder_and_a_hint_when_there_are_none() {
        let plain = Paint::default();
        assert_eq!(
            source_lines(&[], plain),
            ["no extra folders — canopy source add <dir> [--host h]"]
        );
        let raw = json!({"sources": [
            {"id": "work", "label": "Work", "kind": "local", "path": "/w"},
            {"id": "mini", "label": "mini dev", "kind": "ssh", "host": "mini", "path": "/home/e/dev"},
            {"id": "forge", "label": "Forge", "kind": "forgejo", "url": "https://git.example", "tokenFile": "/t"},
            {"id": "bad", "label": "no path", "kind": "local"}
        ]});
        assert_eq!(
            source_lines(&canopy_core::store::stored_sources(&raw), plain),
            [
                "Work (work)  /w",
                "mini dev (mini)  mini:/home/e/dev",
                "Forge (forge)  forgejo https://git.example",
            ]
        );
        let painted = source_lines(
            &canopy_core::store::stored_sources(&json!({"sources": [raw["sources"][1].clone()]})),
            Paint { color: true },
        );
        assert_eq!(
            painted[0],
            format!(
                "{} {}  {}/home/e/dev",
                Paint { color: true }.bold("mini dev"),
                Paint { color: true }.dim("(mini)"),
                Paint { color: true }.sky("mini:")
            )
        );
    }
}
