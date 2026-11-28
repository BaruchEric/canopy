//! workflow.test.ts's cases for what is ported here: parseWorkflow, every
//! key and every refusal, the check line, listed, and after, when and
//! mode, with the bundled files read from lib/workflows.

use super::*;

fn meta() -> WorkflowMeta {
    WorkflowMeta {
        name: "ship".into(),
        source: "bundled".into(),
        file: "/x/ship.md".into(),
    }
}

fn named(name: &str) -> WorkflowMeta {
    WorkflowMeta {
        name: name.into(),
        ..meta()
    }
}

const SHIP: &str = "---
name: ship
label: ship it
verb: ship
blurb: Runs the gates, commits, pushes.
when: dirty-or-unpushed
expects-change: true
note: anything Claude should know
---

## Gates
tools: bun
turns: 12
check: bun run typecheck && bun test

Run the project's own gates.

## Commit
tools: git-read, git-commit, Bash(cargo fmt:*)
gate: verdict

Task: commit the current changes.

## Push
tools: git-read, git-push
gate: ask

Task: push the branch.
";

/// the workflow of an entry that parsed, else the test fails with its error
fn ok(e: Value) -> Value {
    assert_eq!(e["ok"], true, "{}", e["error"]);
    e["workflow"].clone()
}

fn error(e: Value) -> String {
    assert_eq!(e["ok"], false, "parsed: {e}");
    e["error"].as_str().unwrap().to_string()
}

fn has_tool(step: &Value, rule: &str) -> bool {
    step["tools"].as_array().unwrap().iter().any(|t| t == rule)
}

fn bundled(name: &str) -> (String, String) {
    let file = format!("{}/lib/workflows/{name}.md", crate::version::canopy_dir());
    (std::fs::read_to_string(&file).unwrap(), file)
}

#[test]
fn reads_the_frontmatter_and_every_step() {
    let w = ok(parse_workflow(SHIP, &meta()));
    assert_eq!(w["name"], "ship");
    assert_eq!(w["label"], "ship it");
    assert_eq!(w["verb"], "ship");
    assert_eq!(w["when"], "dirty-or-unpushed");
    assert_eq!(w["expectsChange"], true);
    assert_eq!(w["notePlaceholder"], "anything Claude should know");
    assert_eq!(w["noteRequired"], false);
    assert_eq!(w["source"], "bundled");
    assert_eq!(w["file"], "/x/ship.md");
    let names: Vec<&str> = w["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s["name"].as_str().unwrap())
        .collect();
    assert_eq!(names, ["Gates", "Commit", "Push"]);
    let (gates, commit, push) = (&w["steps"][0], &w["steps"][1], &w["steps"][2]);
    assert_eq!(gates["turns"], 12);
    assert_eq!(gates["check"], "bun run typecheck && bun test");
    assert_eq!(gates["gate"], "continue");
    assert!(has_tool(gates, "Bash(bun run:*)"));
    assert_eq!(gates["body"], "Run the project's own gates.");
    assert!(has_tool(commit, "Bash(git commit:*)"));
    assert!(has_tool(commit, "Bash(cargo fmt:*)"));
    assert_eq!(commit["gate"], "verdict");
    assert_eq!(commit["turns"], 30);
    assert_eq!(push["gate"], "ask");
    assert_eq!(push["check"], Value::Null);
}

#[test]
fn a_step_and_a_workflow_keep_the_typescripts_key_order() {
    let w = ok(parse_workflow(SHIP, &meta()));
    let keys: Vec<&String> = w.as_object().unwrap().keys().collect();
    assert_eq!(
        keys,
        [
            "name",
            "label",
            "verb",
            "blurb",
            "when",
            "expectsChange",
            "notePlaceholder",
            "noteRequired",
            "steps",
            "budget",
            "source",
            "file"
        ]
    );
    let step: Vec<&String> = w["steps"][0].as_object().unwrap().keys().collect();
    assert_eq!(
        step,
        [
            "name", "tools", "turns", "check", "gate", "body", "retries", "back", "evidence",
            "mode", "after", "when"
        ]
    );
}

const GIT_READ_RULES: [&str; 8] = [
    "Bash(git status:*)",
    "Bash(git diff:*)",
    "Bash(git log:*)",
    "Bash(git show:*)",
    "Bash(git branch:*)",
    "Bash(git remote:*)",
    "Bash(git rev-parse:*)",
    "Bash(git fetch:*)",
];

#[test]
fn defaults_name_from_the_file_label_from_the_name_verb_from_the_label_git_read_tools_when_any() {
    let w = ok(parse_workflow(
        "---\nblurb: b\n---\n\n## Only\n\nDo it.\n",
        &named("tidy"),
    ));
    assert_eq!(w["name"], "tidy");
    assert_eq!(w["label"], "tidy");
    assert_eq!(w["verb"], "tidy");
    assert_eq!(w["when"], "any");
    assert_eq!(w["expectsChange"], false);
    assert_eq!(w["steps"][0]["tools"], json!(GIT_READ_RULES));
}

#[test]
fn a_check_only_step_has_no_body() {
    let w = ok(parse_workflow(
        "---\nblurb: b\n---\n\n## Gates\ncheck: bun test\n\n## Do\n\nWork.\n",
        &meta(),
    ));
    assert_eq!(w["steps"][0]["body"], "");
    assert_eq!(w["steps"][0]["check"], "bun test");
}

#[test]
fn note_required_makes_the_note_the_task() {
    let w = ok(parse_workflow(
        "---\nblurb: b\nnote: what to do\nnote-required: true\n---\n\n## Do\n\nWork.\n",
        &meta(),
    ));
    assert_eq!(w["noteRequired"], true);
}

#[test]
fn agent_a_steps_own_profile_else_the_workflows_else_none() {
    let text = "---\nblurb: b\nagent: deep\n---\n\n## Plan\n\nThink.\n\n## Review\nagent: review\ntools: git-read\n\nLook.\n\n## Check\ncheck: bun test\n";
    let w = ok(parse_workflow(text, &meta()));
    let agents: Vec<&Value> = w["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| &s["agent"])
        .collect();
    assert_eq!(agents, [&json!("deep"), &json!("review"), &json!("deep")]);
    assert!(has_tool(&w["steps"][1], "Bash(git status:*)"));
    let plain = ok(parse_workflow(
        "---\nblurb: b\n---\n\n## Do\n\nWork.\n",
        &meta(),
    ));
    assert!(plain["steps"][0].get("agent").is_none());
    // an empty line is no pick
    let empty = ok(parse_workflow(
        "---\nblurb: b\n---\n\n## Do\nagent:\n\nWork.\n",
        &meta(),
    ));
    assert!(empty["steps"][0].get("agent").is_none());
}

#[test]
fn a_bare_tools_line_falls_back_to_git_read() {
    let w = ok(parse_workflow(
        "---\nblurb: b\n---\n\n## Do\ntools:\n\nWork.\n",
        &meta(),
    ));
    assert_eq!(w["steps"][0]["tools"], json!(GIT_READ_RULES));
}

#[test]
fn rejects_each_broken_file_naming_it() {
    for (label, text, word) in [
        ("no frontmatter", "## Do\n\nWork.\n", "frontmatter"),
        ("no blurb", "---\nname: x\n---\n\n## Do\n\nWork.\n", "blurb"),
        (
            "bad name",
            "---\nname: Bad Name\nblurb: b\n---\n\n## Do\n\nWork.\n",
            "name",
        ),
        (
            "bad when",
            "---\nblurb: b\nwhen: sometimes\n---\n\n## Do\n\nWork.\n",
            "when",
        ),
        ("no steps", "---\nblurb: b\n---\n\nJust prose.\n", "step"),
        (
            "bad gate",
            "---\nblurb: b\n---\n\n## Do\ngate: maybe\n\nWork.\n",
            "gate",
        ),
        (
            "bad turns",
            "---\nblurb: b\n---\n\n## Do\nturns: lots\n\nWork.\n",
            "turns",
        ),
        (
            "duplicate step",
            "---\nblurb: b\n---\n\n## Do\n\nA.\n\n## Do\n\nB.\n",
            "twice",
        ),
        (
            "empty step",
            "---\nblurb: b\n---\n\n## Do\n\n## Next\n\nB.\n",
            "neither a prompt nor a check",
        ),
        (
            "bad step agent",
            "---\nblurb: b\n---\n\n## Do\nagent: Deep One\n\nWork.\n",
            "step Do: agent must name a profile",
        ),
        (
            "bad workflow agent",
            "---\nblurb: b\nagent: --yolo\n---\n\n## Do\n\nWork.\n",
            "agent must name a profile",
        ),
    ] {
        let e = parse_workflow(text, &meta());
        assert_eq!(e["name"], "ship", "{label}");
        assert_eq!(e["file"], "/x/ship.md", "{label}");
        assert!(error(e).contains(word), "{label}");
    }
}

#[test]
fn a_check_line_parses_with_its_check_kept_character_for_character() {
    let check = r#"[ ! -f package.json ] || for s in typecheck lint test build; do grep -q "\"$s\"" package.json && { bun run "$s" || exit 1; }; done; exit 0"#;
    let w = ok(parse_workflow(
        &format!("---\nblurb: b\n---\n\n## Gates\ncheck: {check}\n\nRun them.\n"),
        &meta(),
    ));
    assert_eq!(w["steps"][0]["check"], check);
}

#[test]
fn the_bundled_ship_file_checks_its_gates_step_with_the_repos_gates() {
    let (text, file) = bundled("ship");
    let w = ok(parse_workflow(
        &text,
        &WorkflowMeta {
            name: "ship".into(),
            source: "bundled".into(),
            file,
        },
    ));
    assert_eq!(w["steps"][0]["check"], "@gates");
}

#[test]
fn the_bundled_issue_fix_file_is_one_unlisted_step_that_commits_and_never_pushes() {
    let (text, file) = bundled("issue-fix");
    let w = ok(parse_workflow(
        &text,
        &WorkflowMeta {
            name: "issue-fix".into(),
            source: "bundled".into(),
            file,
        },
    ));
    assert_eq!(w["listed"], false);
    assert_eq!(w["expectsChange"], true);
    assert_eq!(w["steps"].as_array().unwrap().len(), 1);
    let step = &w["steps"][0];
    assert!(has_tool(step, "Bash(git commit:*)"));
    assert!(
        !step["tools"]
            .as_array()
            .unwrap()
            .iter()
            .any(|t| t.as_str().unwrap().contains("push"))
    );
    assert!(step["body"].as_str().unwrap().contains("do not push"));
}

#[test]
fn the_bundled_spec_converge_file_is_a_read_only_check_and_a_gated_fix() {
    let (text, file) = bundled("spec-converge");
    let w = ok(parse_workflow(
        &text,
        &WorkflowMeta {
            name: "spec-converge".into(),
            source: "bundled".into(),
            file,
        },
    ));
    assert!(w.get("listed").is_none());
    assert_eq!(w["expectsChange"], true);
    assert_eq!(w["when"], "any");
    let (check, fix) = (&w["steps"][0], &w["steps"][1]);
    assert_eq!(
        (check["name"].as_str(), fix["name"].as_str()),
        (Some("Check"), Some("Fix"))
    );
    assert!(!check["tools"].as_array().unwrap().iter().any(|t| {
        let t = t.as_str().unwrap();
        t == "Edit" || t == "Write" || t.contains("git commit")
    }));
    assert!(has_tool(check, "Bash(git log:*)"));
    assert_eq!(check["check"], Value::Null);
    assert!(check["body"].as_str().unwrap().contains("drift: none"));
    assert!(has_tool(fix, "Bash(git commit:*)"));
    assert!(has_tool(fix, "Edit"));
    assert_eq!(fix["check"], "@gates");
    assert_eq!(fix["retries"], 1);
    assert!(fix["body"].as_str().unwrap().contains("do not push"));
    assert!(fix["body"].as_str().unwrap().contains("spec:begin"));
}

fn three(keys: &str, front: &str) -> String {
    format!(
        "---\nblurb: b\n{front}---\n\n## First\n\nOne.\n\n## Second\n{keys}\n\nTwo.\n\n## Third\n\nThree.\n"
    )
}

#[test]
fn defaults_no_retries_back_to_itself_no_evidence_no_budget() {
    let w = ok(parse_workflow(
        "---\nblurb: b\n---\n\n## Do\n\nWork.\n",
        &meta(),
    ));
    assert_eq!(w["budget"], Value::Null);
    assert_eq!(w["steps"][0]["retries"], 0);
    assert_eq!(w["steps"][0]["back"], "Do");
    assert_eq!(w["steps"][0]["evidence"], json!([]));
}

#[test]
fn reads_every_key() {
    let w = ok(parse_workflow(
        &three(
            "gate: judge\nretries: 2\nback: First\nevidence: .canopy/intent.md .canopy/research.md",
            "budget: 30 runs, 6h\n",
        ),
        &meta(),
    ));
    assert_eq!(w["budget"], json!({"runs": 30, "hours": 6}));
    let s = &w["steps"][1];
    assert_eq!(s["gate"], "judge");
    assert_eq!(s["retries"], 2);
    assert_eq!(s["back"], "First");
    assert_eq!(
        s["evidence"],
        json!([".canopy/intent.md", ".canopy/research.md"])
    );
}

#[test]
fn a_single_run_and_fractional_hours() {
    let w = ok(parse_workflow(&three("", "budget: 1 run, 0.5h\n"), &meta()));
    assert_eq!(w["budget"], json!({"runs": 1, "hours": 0.5}));
}

#[test]
fn refuses_bad_retries_back_evidence_and_budget() {
    for (keys, front, want) in [
        (
            "retries: -1",
            "",
            "retries must be a whole number from 0 to 10",
        ),
        (
            "retries: 11",
            "",
            "retries must be a whole number from 0 to 10",
        ),
        (
            "retries: two",
            "",
            "retries must be a whole number from 0 to 10",
        ),
        (
            "back: Third",
            "",
            "back must name this step or an earlier one, not Third",
        ),
        ("back: Nope", "", "back names no step called Nope"),
        (
            "gate: judge\nevidence: /etc/passwd",
            "",
            "evidence must be paths inside the repo, not /etc/passwd",
        ),
        (
            "gate: judge\nevidence: ../x.md",
            "",
            "evidence must be paths inside the repo, not ../x.md",
        ),
        ("evidence: a.md", "", "evidence is only read by gate: judge"),
        (
            "",
            "budget: lots\n",
            "budget must read like \"30 runs, 6h\", not lots",
        ),
        (
            "",
            "budget: 0 runs, 1h\n",
            "budget must read like \"30 runs, 6h\", not 0 runs, 1h",
        ),
        (
            "",
            "budget: 3 runs, 0h\n",
            "budget must read like \"30 runs, 6h\", not 3 runs, 0h",
        ),
    ] {
        let got = error(parse_workflow(&three(keys, front), &meta()));
        assert!(got.contains(want), "{keys:?} {front:?}: {got}");
    }
}

fn check_only(keys: &str) -> String {
    format!(
        "---\nblurb: b\n---\n\n## First\n\nOne.\n\n## Gate\ncheck: true\n{keys}\n\n## Third\n\nThree.\n"
    )
}

#[test]
fn allows_retries_on_a_check_only_step_that_goes_back_to_itself() {
    let w = ok(parse_workflow(&check_only("retries: 2"), &meta()));
    assert_eq!(w["steps"][1]["retries"], 2);
    assert_eq!(w["steps"][1]["back"], "Gate");
}

#[test]
fn check_minutes_sets_how_long_the_steps_check_may_run() {
    let w = ok(parse_workflow(&check_only("check-minutes: 30"), &meta()));
    assert_eq!(w["steps"][1]["checkMinutes"], 30);
    let none = ok(parse_workflow(&check_only(""), &meta()));
    assert!(none["steps"][1].get("checkMinutes").is_none());
}

#[test]
fn check_minutes_is_a_whole_number_from_1_to_120_on_a_step_that_has_a_check() {
    for bad in ["0", "121", "1.5", "ten"] {
        let got = error(parse_workflow(
            &check_only(&format!("check-minutes: {bad}")),
            &meta(),
        ));
        assert!(got.contains(&format!(
            "step Gate: check-minutes must be a whole number from 1 to 120, not {bad}"
        )));
    }
    let got = error(parse_workflow(
        "---\nblurb: b\n---\n\n## Do\ncheck-minutes: 20\n\nWork.\n",
        &meta(),
    ));
    assert!(got.contains("step Do: check-minutes needs a check"));
}

#[test]
fn allows_retries_on_a_check_only_step_that_goes_back_to_an_earlier_one() {
    ok(parse_workflow(
        &check_only("retries: 2\nback: First"),
        &meta(),
    ));
}

#[test]
fn allows_a_check_only_step_with_no_retries() {
    ok(parse_workflow(&check_only(""), &meta()));
}

#[test]
fn listed_absent_or_true_is_listed_false_marks_it_anything_else_is_an_error() {
    let text = |line: &str| format!("---\nblurb: b\n{line}---\n\n## A\n\nDo it.\n");
    let m = WorkflowMeta {
        name: "w".into(),
        source: "bundled".into(),
        file: "/w.md".into(),
    };
    assert!(ok(parse_workflow(&text(""), &m)).get("listed").is_none());
    assert!(
        ok(parse_workflow(&text("listed: true\n"), &m))
            .get("listed")
            .is_none()
    );
    assert_eq!(
        ok(parse_workflow(&text("listed: false\n"), &m))["listed"],
        false
    );
    error(parse_workflow(&text("listed: maybe\n"), &m));
}

fn graph(review: &str, fix: &str, docs: &str) -> String {
    format!(
        "---\nblurb: b\n---\n\n## Build\ntools: git-read, git-commit\n\nbuild\n\n## Review\ntools: read\ngate: verdict\n{review}\n\nreview\n\n## Fix\nafter: Review\n{fix}\n\nfix\n\n## Docs\nafter: Build\ntools: read\n{docs}\n\ndocs\n"
    )
}

fn column(w: &Value, key: &str) -> Vec<Value> {
    w["steps"]
        .as_array()
        .unwrap()
        .iter()
        .map(|s| s[key].clone())
        .collect()
}

#[test]
fn reads_the_keys_and_writes_the_chain_out_where_a_step_has_none() {
    let w = ok(parse_workflow(
        &graph(
            "",
            "when: verdict partial, verdict blocked\nmode: manual",
            "",
        ),
        &meta(),
    ));
    assert_eq!(
        column(&w, "after"),
        [
            json!([]),
            json!(["Build"]),
            json!(["Review"]),
            json!(["Build"])
        ]
    );
    assert_eq!(
        column(&w, "when"),
        [
            json!(["always"]),
            json!(["always"]),
            json!(["verdict partial", "verdict blocked"]),
            json!(["always"])
        ]
    );
    assert_eq!(
        column(&w, "mode"),
        [json!("auto"), json!("auto"), json!("manual"), json!("auto")]
    );
    assert!(w["steps"][2].get("modeFrom").is_none());
}

#[test]
fn after_is_trimmed_and_deduped() {
    let w = ok(parse_workflow(
        "---\nblurb: b\n---\n\n## A\n\na\n\n## B\n\nb\n\n## C\nafter: A ,, B, A\n\nc\n",
        &meta(),
    ));
    assert_eq!(w["steps"][2]["after"], json!(["A", "B"]));
}

#[test]
fn after_none_makes_a_later_step_a_second_root_starting_with_the_first() {
    let w = ok(parse_workflow(
        "---\nblurb: b\n---\n\n## Gates\ntools: bun\n\ngates\n\n## Docs\nafter: none\ntools: read\n\ndocs\n\n## Commit\nafter: Gates, Docs\n\ncommit\n",
        &meta(),
    ));
    assert_eq!(
        column(&w, "after"),
        [json!([]), json!([]), json!(["Gates", "Docs"])]
    );
}

#[test]
fn an_empty_when_list_defaults_to_always() {
    let w = ok(parse_workflow(
        "---\nblurb: b\n---\n\n## A\nwhen: , ,\n\na\n",
        &meta(),
    ));
    assert_eq!(w["steps"][0]["when"], json!(["always"]));
}

#[test]
fn refuses_a_bad_after_when_or_mode_in_the_typescripts_words() {
    for (text, want) in [
        (
            graph("", "after: Nope", ""),
            "step Fix: after names no step called Nope",
        ),
        (graph("", "after: Fix", ""), "step Fix: after names itself"),
        (
            graph("", "after: Docs", ""),
            "step Fix: after names a later step, Docs",
        ),
        (
            graph("", "when: sometimes", ""),
            "step Fix: when must be one of always, verdict done, verdict partial, verdict blocked, judge meets, judge partly, judge misses, check pass, check fail, changed, unchanged, skipped, not sometimes",
        ),
        (
            graph("", "", "when: verdict done"),
            "step Docs: when verdict done needs a step before it with gate: verdict",
        ),
        (
            graph("", "when: judge meets", ""),
            "step Fix: when judge meets needs a step before it with gate: judge",
        ),
        (
            graph("", "when: check fail", ""),
            "step Fix: when check fail needs a step before it with a check",
        ),
        (
            graph("", "mode: sometimes", ""),
            "step Fix: mode must be one of auto, manual, not sometimes",
        ),
        (
            "---\nblurb: b\n---\n\n## A\nwhen: always\n\na\n".into(),
            "step A: when needs a step before it to wait on",
        ),
        (
            "---\nblurb: b\n---\n\n## A\n\na\n\n## B\nafter: none, A\n\nb\n".into(),
            "step B: after none waits for nothing, so it names no other step",
        ),
        (
            "---\nblurb: b\n---\n\n## A\n\na\n\n## B\nafter: none\nwhen: changed\n\nb\n".into(),
            "step B: when needs a step before it to wait on",
        ),
        (
            "---\nblurb: b\n---\n\n## none\n\na\n\n## B\nafter: none\n\nb\n".into(),
            "step B: after none is reserved, so rename the step called none",
        ),
    ] {
        assert_eq!(error(parse_workflow(&text, &meta())), want);
    }
}

#[test]
fn retries_back_and_after_go_together() {
    ok(parse_workflow(
        &graph("", "after: Review\nretries: 1\nback: Build", ""),
        &meta(),
    ));
}

#[test]
fn every_bundled_workflow_and_the_example_are_chains_but_for_ship_and_sentry_triage_fix() {
    let dir = format!("{}/lib/workflows", crate::version::canopy_dir());
    let mut files: Vec<String> = std::fs::read_dir(&dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .map(|e| e.path().to_string_lossy().into_owned())
        .filter(|p| p.ends_with(".md"))
        .collect();
    files.push(format!(
        "{}/docs/workflows/example-update-deps.md",
        crate::version::canopy_dir()
    ));
    for file in files {
        let text = std::fs::read_to_string(&file).unwrap();
        let w = ok(parse_workflow(
            &text,
            &WorkflowMeta {
                name: "x".into(),
                source: "bundled".into(),
                file: file.clone(),
            },
        ));
        let steps = w["steps"].as_array().unwrap();
        let plain = steps.iter().enumerate().all(|(i, s)| {
            let chain = if i == 0 {
                json!([])
            } else {
                json!([steps[i - 1]["name"]])
            };
            s["after"] == chain && s["when"] == json!(["always"]) && s["mode"] == "auto"
        });
        let base = crate::pathx::basename(&file);
        let graph = base == "ship.md" || base == "sentry-triage-fix.md";
        assert_eq!(plain, !graph, "{file}");
    }
}

#[test]
fn numbers_read_as_javascripts_number_reads_them() {
    assert_eq!(to_number(""), 0.0);
    assert_eq!(to_number(" 12 "), 12.0);
    assert_eq!(to_number("0x10"), 16.0);
    assert_eq!(to_number("1e2"), 100.0);
    assert_eq!(to_number("12.0"), 12.0);
    assert_eq!(to_number(".5"), 0.5);
    assert_eq!(to_number("-1"), -1.0);
    assert_eq!(to_number("Infinity"), f64::INFINITY);
    for nan in [
        "lots", "inf", "NaN", "1_000", "0x", "1e", "-0x1", ".", "1.2.3",
    ] {
        assert!(to_number(nan).is_nan(), "{nan}");
    }
}

#[test]
fn a_heading_reads_as_the_typescripts_pattern_reads_it() {
    assert_eq!(heading("## Build"), Some("Build".into()));
    assert_eq!(heading("##   Say \"hi\"  "), Some("Say \"hi\"".into()));
    assert_eq!(heading("##Build"), None);
    assert_eq!(heading("### Build"), None);
    assert_eq!(heading("## "), None);
    assert_eq!(heading("##   "), Some(" ".into()));
}
