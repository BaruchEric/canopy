//! Screen layout profiles (`src/core/screenlayouts.ts` and the pane sizes
//! of `src/core/panesizes.ts`): the recommended presets, the layout each
//! recommends, and how a kept profile is checked. Profiles are JSON values
//! with their fields in the order the TypeScript sets them, so a route that
//! lists them sends the Bun server's bytes. Matching a profile to a screen
//! is the page's and is not here.

use serde_json::{Map, Value, json};

/// The bounds a layout's values are held to (`LAYOUT_BOUNDS`).
const SIDEBAR_WIDTH: (f64, f64) = (180.0, 560.0);
const CARDS_WIDTH: (f64, f64) = (320.0, 4800.0);
const COLUMN_WIDTH: (f64, f64) = (240.0, 4800.0);
const PANEL_ZOOM: (f64, f64) = (0.5, 2.0);
const TERM_FONT: (f64, f64) = (8.0, 24.0);

const PHONE: f64 = 760.0;
const NARROW: f64 = 1100.0;
const CARDS_MIN: f64 = 320.0;
const SEAM: f64 = 6.0;
const COLUMN_TARGET: f64 = 560.0;

/// `BOARD_LAYOUTS` in core/types.ts.
pub const BOARD_LAYOUTS: [&str; 6] = ["rail", "wall", "spotlight", "dashboard", "triage", "lanes"];

/// `PANES`: each pane's name and the px it is held to.
pub const PANES: [(&str, f64, f64); 11] = [
    ("lede", 180.0, 960.0),
    ("finder-list", 160.0, 1600.0),
    ("finder-rows", 72.0, 1600.0),
    ("sessions-side", 200.0, 800.0),
    ("sessions-agents", 72.0, 1600.0),
    ("board-rail", 200.0, 1200.0),
    ("prefs-rail", 140.0, 480.0),
    ("clips-list", 180.0, 1200.0),
    ("diff", 72.0, 4800.0),
    ("task-log", 72.0, 4800.0),
    ("job-tail", 48.0, 4800.0),
];

fn clamp(v: f64, min: f64, max: f64) -> f64 {
    v.max(min).min(max)
}

use crate::js::{num as js_num, round as js_round};

fn halves(dir: &str, a: Value, b: Value) -> Value {
    json!({ "dir": dir, "at": 0.5, "a": a, "b": b })
}

fn leaf(pane: &str) -> Value {
    json!({ "pane": pane })
}

/// `recommendTabs()`: the tab template for a screen `w` CSS px wide.
pub fn recommend_tabs(w: f64) -> Value {
    if w < NARROW {
        return json!({ "panel": [], "strip": [] });
    }
    if w < 2400.0 {
        let split = halves("row", leaf("history"), leaf("shell"));
        return json!({ "panel": ["history"], "split": split, "strip": [] });
    }
    if w < 3600.0 {
        let split = halves(
            "row",
            leaf("changes"),
            halves("col", leaf("history"), leaf("shell")),
        );
        return json!({ "panel": ["changes", "history"], "split": split, "strip": ["tasks"] });
    }
    let split = halves(
        "row",
        halves("col", leaf("changes"), leaf("files")),
        halves("col", leaf("history"), leaf("shell")),
    );
    json!({ "panel": ["changes", "files", "history"], "split": split, "strip": ["tasks", "health"] })
}

/// `recommendLayout()`: the layout for a screen `w` by `h` CSS px.
pub fn recommend_layout(w: f64, h: f64) -> Value {
    if w < PHONE {
        return json!({
            "arrange": "tabs", "carousel": false, "sidebarOpen": false, "feedOpen": false,
            "agents": "wall", "tabs": recommend_tabs(w),
        });
    }
    let tree = w >= NARROW;
    let sidebar_width = clamp(js_round((w * 0.12) / 8.0) * 8.0, 220.0, 320.0);
    let side = if tree { sidebar_width + SEAM } else { 0.0 };
    let beside = w - side - CARDS_MIN;
    let shared = (beside / COLUMN_TARGET).floor();
    let carousel = shared < 2.0;
    let room = if carousel { w - side } else { beside };
    let columns = (room / COLUMN_TARGET).floor().max(1.0);
    let column_width = clamp(((room - SEAM * columns) / columns).floor(), 440.0, 1200.0);
    let mut out = Map::new();
    out.insert("arrange".into(), json!("columns"));
    out.insert("carousel".into(), json!(carousel));
    out.insert("sidebarOpen".into(), json!(tree));
    if tree {
        out.insert("sidebarWidth".into(), js_num(sidebar_width));
    }
    out.insert("columnWidth".into(), js_num(column_width));
    out.insert("feedOpen".into(), json!(h >= 1400.0));
    out.insert("agents".into(), json!("wall"));
    out.insert("tabs".into(), recommend_tabs(w));
    Value::Object(out)
}

/// the presets: physical size, pixel ratio, name, and the device it suits
const STEPS: [(f64, f64, f64, &str, &str); 16] = [
    (1179.0, 2556.0, 3.0, "phone", "phone"),
    (1640.0, 2360.0, 2.0, "tablet", "tablet"),
    (1280.0, 800.0, 1.0, "1280×800", "small laptop"),
    (1440.0, 900.0, 1.0, "1440×900", "laptop"),
    (1920.0, 1080.0, 1.0, "full HD", "monitor"),
    (1920.0, 1200.0, 1.0, "1920×1200", "monitor"),
    (2560.0, 1440.0, 1.0, "QHD", "monitor"),
    (2560.0, 1600.0, 2.0, "13-inch laptop", "MacBook Air 13"),
    (3024.0, 1964.0, 2.0, "14-inch laptop", "MacBook Pro 14"),
    (3456.0, 2234.0, 2.0, "16-inch laptop", "MacBook Pro 16"),
    (3440.0, 1440.0, 1.0, "ultrawide", "34-inch ultrawide"),
    (3840.0, 1600.0, 1.0, "wide ultrawide", "38-inch ultrawide"),
    (3840.0, 2160.0, 1.5, "4K", "4K monitor"),
    (
        5120.0,
        1440.0,
        1.0,
        "super ultrawide",
        "49-inch super ultrawide",
    ),
    (5120.0, 2160.0, 1.0, "5K2K", "40-inch 5K2K"),
    (7680.0, 2160.0, 1.0, "dual 4K", "57-inch dual 4K"),
];

fn preset_id(w: f64, h: f64) -> String {
    format!("preset-{}x{}", w as i64, h as i64)
}

/// `PRESETS`: the recommended presets, each laid out for its room in CSS px.
pub fn presets() -> Vec<Value> {
    STEPS
        .iter()
        .map(|&(w, h, dpr, name, device)| {
            json!({
                "id": preset_id(w, h),
                "name": name,
                "device": device,
                "width": js_num(w),
                "height": js_num(h),
                "dpr": js_num(dpr),
                "layout": recommend_layout(js_round(w / dpr), js_round(h / dpr)),
                "builtin": true,
            })
        })
        .collect()
}

pub fn is_preset_id(id: &str) -> bool {
    STEPS.iter().any(|&(w, h, ..)| preset_id(w, h) == id)
}

fn num(v: &Value) -> Option<f64> {
    v.as_f64().filter(|n| n.is_finite())
}

fn in_range(v: &Value, (min, max): (f64, f64)) -> Option<f64> {
    num(v).filter(|n| *n >= min && *n <= max)
}

/// `/^[a-z]{1,20}$/`
fn is_name(s: &str) -> bool {
    (1..=20).contains(&s.len()) && s.bytes().all(|b| b.is_ascii_lowercase())
}

const TREE_DEPTH: usize = 6;

fn parse_tree(v: &Value, seen: &mut Vec<String>, depth: usize) -> Option<Value> {
    let o = v.as_object().filter(|_| depth <= TREE_DEPTH)?;
    if let Some(p) = o.get("pane") {
        let p = p
            .as_str()
            .filter(|p| is_name(p) && !seen.iter().any(|s| s == p))?;
        seen.push(p.to_string());
        return Some(json!({ "pane": p }));
    }
    let dir = o
        .get("dir")
        .and_then(Value::as_str)
        .filter(|d| *d == "row" || *d == "col")?;
    let at = o.get("at").and_then(num)?;
    let a = parse_tree(o.get("a").unwrap_or(&Value::Null), seen, depth + 1)?;
    let b = parse_tree(o.get("b").unwrap_or(&Value::Null), seen, depth + 1)?;
    Some(json!({ "dir": dir, "at": js_num(clamp(at, 0.1, 0.9)), "a": a, "b": b }))
}

fn names(v: &Value, most: usize) -> Option<Vec<String>> {
    let a = v.as_array().filter(|a| a.len() <= most)?;
    let mut out: Vec<String> = vec![];
    for k in a {
        let k = k.as_str().filter(|k| is_name(k))?;
        if !out.iter().any(|o| o == k) {
            out.push(k.to_string());
        }
    }
    Some(out)
}

/// `parseTabs()`
pub fn parse_tabs(raw: &Value) -> Result<Value, String> {
    let r = raw.as_object().ok_or("tabs is an object")?;
    let mut out = Map::new();
    if let Some(v) = r.get("panel") {
        let got = names(v, 20).ok_or("tabs.panel is a list of section names")?;
        out.insert("panel".into(), json!(got));
    }
    if let Some(v) = r.get("strip") {
        let got = names(v, 20).ok_or("tabs.strip is a list of popup names")?;
        out.insert("strip".into(), json!(got));
    }
    if let Some(v) = r.get("split") {
        let tree = parse_tree(v, &mut vec![], 0)
            .filter(|t| t.get("pane").is_none())
            .ok_or("tabs.split is a split of two or more names")?;
        out.insert("split".into(), tree);
    }
    Ok(Value::Object(out))
}

/// `parsePaneSizes()`
pub fn parse_pane_sizes(raw: &Value) -> Result<Value, String> {
    let r = raw
        .as_object()
        .ok_or("paneSizes is an object of pane names and their sizes in px")?;
    let mut out = Map::new();
    for (k, v) in r {
        let Some(&(_, min, max)) = PANES.iter().find(|(name, ..)| name == k) else {
            continue;
        };
        let px = in_range(v, (min, max))
            .ok_or_else(|| format!("paneSizes.{k} is a number from {min} to {max}"))?;
        out.insert(k.clone(), js_num(js_round(px)));
    }
    Ok(Value::Object(out))
}

/// `parseLayout()`: an unknown key is left out, a known one with a bad
/// value is an error.
pub fn parse_layout(raw: Option<&Value>) -> Result<Value, String> {
    let Some(raw) = raw else {
        return Ok(json!({}));
    };
    let r = raw.as_object().ok_or("layout must be an object")?;
    let mut out = Map::new();
    if let Some(a) = r.get("arrange") {
        let a = a
            .as_str()
            .filter(|a| *a == "columns" || *a == "tabs")
            .ok_or("arrange is columns or tabs")?;
        out.insert("arrange".into(), json!(a));
    }
    for k in ["carousel", "sidebarOpen", "feedOpen"] {
        if let Some(v) = r.get(k) {
            let b = v.as_bool().ok_or_else(|| format!("{k} is true or false"))?;
            out.insert(k.into(), json!(b));
        }
    }
    let bounded = [
        ("sidebarWidth", SIDEBAR_WIDTH),
        ("cardsWidth", CARDS_WIDTH),
        ("columnWidth", COLUMN_WIDTH),
        ("panelZoom", PANEL_ZOOM),
        ("termFont", TERM_FONT),
    ];
    for (k, b) in bounded {
        if let Some(v) = r.get(k) {
            let n = in_range(v, b).ok_or_else(|| {
                format!("{k} is a number from {} to {}", js_num(b.0), js_num(b.1))
            })?;
            let kept = if k == "panelZoom" || k == "termFont" {
                n
            } else {
                js_round(n)
            };
            out.insert(k.into(), js_num(kept));
        }
    }
    if let Some(l) = r.get("level") {
        let l = l
            .as_str()
            .filter(|l| *l == "intermediate" || *l == "advanced")
            .ok_or("level is intermediate or advanced")?;
        out.insert("level".into(), json!(l));
    }
    if let Some(a) = r.get("agents") {
        let a = a
            .as_str()
            .filter(|a| BOARD_LAYOUTS.contains(a))
            .ok_or_else(|| format!("agents is one of {}", BOARD_LAYOUTS.join(", ")))?;
        out.insert("agents".into(), json!(a));
    }
    if let Some(v) = r.get("sectionsHidden") {
        let bad = "sectionsHidden is a list of section names";
        let list = v.as_array().filter(|a| a.len() <= 20).ok_or(bad)?;
        let mut keys: Vec<&str> = vec![];
        for k in list {
            let k = k.as_str().filter(|k| is_name(k)).ok_or(bad)?;
            if !keys.contains(&k) {
                keys.push(k);
            }
        }
        out.insert("sectionsHidden".into(), json!(keys));
    }
    if let Some(v) = r.get("tabs") {
        out.insert("tabs".into(), parse_tabs(v)?);
    }
    if let Some(v) = r.get("paneSizes") {
        out.insert("paneSizes".into(), parse_pane_sizes(v)?);
    }
    Ok(Value::Object(out))
}

/// `text()`: a string whose trimmed length is at most `max`, trimmed.
fn text(v: &Value, max: usize) -> Option<String> {
    let s = v.as_str()?.trim();
    (s.encode_utf16().count() <= max).then(|| s.to_string())
}

/// `parseProfile()`: a name, a device, an optional model, a physical size
/// in whole px, an optional pixel ratio and a layout, in that order.
pub fn parse_profile(raw: &Value) -> Result<Map<String, Value>, String> {
    let r = raw.as_object().ok_or("a profile is an object")?;
    let name = r
        .get("name")
        .and_then(|v| text(v, 60))
        .filter(|n| !n.is_empty())
        .ok_or("a profile needs a name, at most 60 characters")?;
    let device = match r.get("device") {
        None => String::new(),
        Some(v) => text(v, 60).ok_or("device is text, at most 60 characters")?,
    };
    let model = match r.get("model") {
        None => None,
        Some(Value::String(s)) if s.is_empty() => None,
        Some(v) => Some(text(v, 80).ok_or("model is text, at most 80 characters")?),
    };
    let size = (200.0, 20000.0);
    let whole = |k: &str| {
        r.get(k)
            .and_then(|v| in_range(v, size))
            .filter(|n| n.fract() == 0.0)
    };
    let (Some(width), Some(height)) = (whole("width"), whole("height")) else {
        return Err("width and height are whole physical pixels from 200 to 20000".into());
    };
    let dpr = match r.get("dpr") {
        None => None,
        Some(v) => Some(in_range(v, (0.5, 5.0)).ok_or("dpr is a number from 0.5 to 5")?),
    };
    let layout = parse_layout(r.get("layout"))?;
    let mut out = Map::new();
    out.insert("name".into(), json!(name));
    out.insert("device".into(), json!(device));
    if let Some(m) = model.filter(|m| !m.is_empty()) {
        out.insert("model".into(), json!(m));
    }
    out.insert("width".into(), js_num(width));
    out.insert("height".into(), js_num(height));
    if let Some(d) = dpr {
        out.insert("dpr".into(), js_num(d));
    }
    out.insert("layout".into(), layout);
    Ok(out)
}

/// `/^p-[0-9a-f]{12}$/`
fn is_profile_id(s: &str) -> bool {
    s.len() == 14
        && s.starts_with("p-")
        && s.bytes()
            .skip(2)
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}

/// `new ScreenLayouts().list()` over the text of `screen-layouts.json`:
/// the presets, changed ones as changed, then the user's own. A record
/// that does not check out is left out, never the rest.
pub fn list_profiles(raw: Option<&str>) -> Vec<Value> {
    let v: Value = raw
        .and_then(|t| serde_json::from_str(t).ok())
        .unwrap_or(Value::Null);
    let empty = Map::new();
    let kept = v.as_object().unwrap_or(&empty);
    let mut own: Vec<Value> = vec![];
    for p in kept
        .get("profiles")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let Some(id) = p
            .get("id")
            .and_then(Value::as_str)
            .filter(|i| is_profile_id(i))
        else {
            continue;
        };
        if own.iter().any(|o| o["id"] == id) {
            continue;
        }
        if let Ok(fields) = parse_profile(p) {
            let mut one = Map::new();
            one.insert("id".into(), json!(id));
            one.extend(fields);
            own.push(Value::Object(one));
        }
    }
    let changed = kept.get("presets").and_then(Value::as_object);
    let mut out: Vec<Value> = presets()
        .into_iter()
        .map(|p| {
            let id = p["id"].as_str().unwrap_or_default().to_string();
            match changed
                .and_then(|c| c.get(&id))
                .and_then(|c| parse_profile(c).ok())
            {
                Some(mut fields) => {
                    fields.insert("id".into(), json!(id));
                    fields.insert("builtin".into(), json!(true));
                    fields.insert("edited".into(), json!(true));
                    Value::Object(fields)
                }
                None => p,
            }
        })
        .collect();
    out.extend(own);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_screen_gets_the_layout_its_width_recommends() {
        assert_eq!(recommend_layout(393.0, 852.0)["arrange"], "tabs");
        let laptop = recommend_layout(1440.0, 900.0);
        assert_eq!(laptop["sidebarWidth"], 220);
        assert_eq!(laptop["carousel"], true);
        assert_eq!(laptop["columnWidth"], 601);
        let wide = recommend_layout(3840.0, 1600.0);
        assert_eq!(wide["sidebarWidth"], 320);
        assert_eq!(wide["carousel"], false);
        assert_eq!(wide["columnWidth"], 632);
        assert_eq!(wide["feedOpen"], true);
        assert_eq!(wide["tabs"]["strip"], json!(["tasks", "health"]));
        let small = recommend_layout(853.0, 533.0);
        assert!(small.get("sidebarWidth").is_none());
    }

    #[test]
    fn there_are_sixteen_presets_and_only_they_are_presets() {
        let p = presets();
        assert_eq!(p.len(), 16);
        assert_eq!(p[12]["id"], "preset-3840x2160");
        assert_eq!(p[12]["dpr"], json!(1.5));
        assert!(is_preset_id("preset-1179x2556"));
        assert!(!is_preset_id("preset-1x1"));
    }

    #[test]
    fn a_profile_is_checked_field_by_field() {
        let ok = parse_profile(&json!({
            "name": " desk ", "model": "", "width": 2560, "height": 1440.0, "dpr": 2,
            "layout": { "termFont": 12.5, "sidebarWidth": 240.5, "x": 1, "sectionsHidden": ["a", "a"],
                        "tabs": { "split": { "dir": "row", "at": 0.95, "a": { "pane": "x" }, "b": { "pane": "y" } } },
                        "paneSizes": { "lede": 200.4, "nope": 1 } }
        }))
        .unwrap();
        assert_eq!(
            serde_json::to_string(&ok).unwrap(),
            r#"{"name":"desk","device":"","width":2560,"height":1440,"dpr":2,"layout":{"sidebarWidth":241,"termFont":12.5,"sectionsHidden":["a"],"tabs":{"split":{"dir":"row","at":0.9,"a":{"pane":"x"},"b":{"pane":"y"}}},"paneSizes":{"lede":200}}}"#
        );
        assert!(parse_profile(&json!({ "name": "", "width": 300, "height": 300 })).is_err());
        assert!(parse_profile(&json!({ "name": "a", "width": 300.5, "height": 300 })).is_err());
        let e = parse_profile(
            &json!({ "name": "a", "width": 300, "height": 300, "layout": { "panelZoom": 3 } }),
        );
        assert_eq!(e.unwrap_err(), "panelZoom is a number from 0.5 to 2");
        let twice = json!({ "name": "a", "width": 300, "height": 300, "layout": { "tabs": { "split": { "dir": "row", "at": 0.5, "a": { "pane": "x" }, "b": { "pane": "x" } } } } });
        assert!(parse_profile(&twice).is_err());
    }

    #[test]
    fn the_list_is_the_presets_changed_ones_as_changed_then_the_users() {
        assert_eq!(list_profiles(None).len(), 16);
        assert_eq!(list_profiles(Some("not json")).len(), 16);
        let file = json!({
            "profiles": [
                { "id": "p-0123456789ab", "name": "mine", "width": 1000, "height": 800 },
                { "id": "p-0123456789ab", "name": "again", "width": 1000, "height": 800 },
                { "id": "bad", "name": "bad", "width": 1000, "height": 800 }
            ],
            "presets": { "preset-1920x1080": { "name": "office", "width": 1920, "height": 1080 }, "preset-1x1": {} }
        })
        .to_string();
        let all = list_profiles(Some(&file));
        assert_eq!(all.len(), 17);
        assert_eq!(
            serde_json::to_string(&all[4]).unwrap(),
            r#"{"name":"office","device":"","width":1920,"height":1080,"layout":{},"id":"preset-1920x1080","builtin":true,"edited":true}"#
        );
        assert_eq!(
            serde_json::to_string(&all[16]).unwrap(),
            r#"{"id":"p-0123456789ab","name":"mine","device":"","width":1000,"height":800,"layout":{}}"#
        );
    }
}
