//! The CLI's usage text (`src/core/help.ts`). The text itself is read from
//! help.ts when canopy-rs is built, so the two CLIs can never describe
//! different commands: the web UI imports that file too, so it stays put
//! after the cutover.

/// help.ts as it was when this binary was built.
const HELP_TS: &str = include_str!("../../../../src/core/help.ts");

const OPEN: &str = "export const HELP_TEXT = `";

/// `HELP_TEXT`: the template literal in help.ts, its escapes undone. It has
/// no `${}` in it (a test checks), so the text is the literal's characters.
pub fn help_text() -> String {
    let start = HELP_TS.find(OPEN).expect("HELP_TEXT in help.ts") + OPEN.len();
    let mut out = String::new();
    let mut chars = HELP_TS[start..].chars();
    while let Some(c) = chars.next() {
        match c {
            '`' => return out,
            '\\' => {
                if let Some(next) = chars.next() {
                    out.push(match next {
                        'n' => '\n',
                        't' => '\t',
                        other => other,
                    });
                }
            }
            c => out.push(c),
        }
    }
    panic!("HELP_TEXT in help.ts never closes");
}

/// `HELP` in index.ts: the help with its first word in bold.
pub fn help(color: bool) -> String {
    let text = help_text();
    let rest = &text["canopy".len()..];
    if color {
        format!("\x1b[1mcanopy\x1b[0m{rest}")
    } else {
        format!("canopy{rest}")
    }
}

/// `SAME_AS`: words the CLI takes for another command's.
fn same_as(verb: &str) -> &str {
    match verb {
        "notes" => "note",
        "clips" => "clip",
        "sources" => "source",
        "tenants" => "tenant",
        "tree" => "[dir]",
        v => v,
    }
}

/// `verbHelp()`: one command's lines from the help, each "  canopy <verb>
/// ..." line and the deeper-indented lines under it; None for a verb it
/// does not list.
pub fn verb_help(verb: &str) -> Option<String> {
    verb_help_in(verb, &help_text())
}

fn verb_help_in(verb: &str, text: &str) -> Option<String> {
    let want = same_as(verb);
    let mut out: Vec<&str> = Vec::new();
    let mut inside = false;
    for line in text.split('\n') {
        // /^ {2}canopy (\S+)/
        let head = line.strip_prefix("  canopy ").and_then(|rest| {
            let word: String = rest
                .chars()
                .take_while(|c| !canopy_core::pathx::js_ws(*c))
                .collect();
            (!word.is_empty()).then_some(word)
        });
        if let Some(word) = head {
            inside = word == want;
        } else if !deeper(line) {
            inside = false;
        }
        if inside {
            out.push(line);
        }
    }
    (!out.is_empty()).then(|| format!("usage:\n{}", out.join("\n")))
}

/// `/^ {3,}\S/`: three or more spaces, then something.
fn deeper(line: &str) -> bool {
    let spaces = line.len() - line.trim_start_matches(' ').len();
    spaces >= 3
        && line[spaces..]
            .chars()
            .next()
            .is_some_and(|c| !canopy_core::pathx::js_ws(c))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_text_is_help_ts_literal_with_nothing_interpolated() {
        let start = HELP_TS.find(OPEN).unwrap() + OPEN.len();
        let end = start + HELP_TS[start..].find('`').unwrap();
        assert!(
            !HELP_TS[start..end].contains("${"),
            "HELP_TEXT interpolates; help.rs reads it as plain text"
        );
        let text = help_text();
        assert!(text.starts_with("canopy — multi-repo git cockpit\n"));
        assert!(text.contains("\n  canopy commit "));
    }

    #[test]
    fn a_verb_takes_its_head_line_and_the_deeper_lines_under_it() {
        let text = "canopy — x\n\nusage:\n  canopy note add <text>   jot\n      more about add\n  canopy note list   list\n  canopy notes2 x\n  canopy run go\n\nfooter\n";
        assert_eq!(
            verb_help_in("note", text).as_deref(),
            Some(
                "usage:\n  canopy note add <text>   jot\n      more about add\n  canopy note list   list"
            )
        );
        assert_eq!(
            verb_help_in("notes", text),
            verb_help_in("note", text),
            "notes is note"
        );
        assert_eq!(verb_help_in("nothing", text), None);
    }

    #[test]
    fn the_bold_name_leads_only_with_color() {
        assert!(help(true).starts_with("\x1b[1mcanopy\x1b[0m — multi-repo"));
        assert!(help(false).starts_with("canopy — multi-repo"));
    }
}
