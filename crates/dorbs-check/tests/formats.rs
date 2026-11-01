//! What each format reads from real tools' output, with the adapters' patterns.

use std::collections::{HashMap, HashSet};

use dorbs_check::adapter::Adapters;
use dorbs_check::format::{Counts, Format, ParseContext, Streams, parse};
use dorbs_check::protocol::Diagnostic;

fn fixture(name: &str) -> String {
    std::fs::read_to_string(format!(
        "{}/tests/fixtures/{name}.txt",
        env!("CARGO_MANIFEST_DIR")
    ))
    .unwrap()
}

/// A diagnostic as a short line, so a test reads the whole set at a glance.
fn brief(d: &Diagnostic) -> String {
    let (s, e) = (d.range.start, d.range.end);
    let code = d
        .code
        .as_deref()
        .map(|code| format!(" {code}"))
        .unwrap_or_default();
    format!(
        "{}:{}:{}-{}:{} {}{code} {}",
        d.path, s.line, s.character, e.line, e.character, d.severity as u8, d.message
    )
}

struct Run<'a> {
    format: Format,
    stdout: &'a str,
    stderr: &'a str,
    report: Option<&'a str>,
    cwd: &'a str,
    streams: Streams,
}

impl<'a> Run<'a> {
    fn errorformat(adapter: &str, stdout: &'a str) -> Self {
        let adapters = Adapters::load(None).unwrap();
        let adapter = adapters.get(adapter).unwrap();
        Run {
            format: Format::Errorformat(adapter.output.errorformat.clone()),
            stdout,
            stderr: "",
            report: None,
            cwd: ".",
            streams: Streams {
                prefixes: adapter
                    .output
                    .prefixes
                    .iter()
                    .map(|p| p.regex().clone())
                    .collect(),
                ..Streams::default()
            },
        }
    }

    fn with(format: Format, stdout: &'a str) -> Self {
        Run {
            format,
            stdout,
            stderr: "",
            report: None,
            cwd: ".",
            streams: Streams::default(),
        }
    }

    fn stderr(mut self, stderr: &'a str) -> Self {
        self.stderr = stderr;
        self
    }

    fn patterns(mut self, patterns: &[&str]) -> Self {
        self.format = Format::Errorformat(patterns.iter().map(|p| (*p).to_owned()).collect());
        self
    }

    fn parse(&self) -> (Vec<String>, Vec<String>, Option<Counts>) {
        let context = ParseContext {
            root: "/env/repo",
            cwd: self.cwd,
            source: "check",
            streams: &self.streams,
        };
        let parsed = parse(
            &self.format,
            self.stdout,
            self.stderr,
            self.report,
            &context,
        )
        .unwrap();
        (
            parsed.diagnostics.iter().map(brief).collect(),
            parsed.output,
            parsed.counts,
        )
    }
}

fn strings(lines: &[&str]) -> Vec<String> {
    lines.iter().map(|line| (*line).to_owned()).collect()
}

#[test]
fn reads_tsc_lines_with_their_continuations_relative_to_where_it_ran() {
    let tsc = fixture("tsc.stdout");
    let (diagnostics, output, _) = Run::errorformat("node", &tsc).parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "src/a.ts:0:13-0:13 1 TS2322 Type 'string' is not assignable to type 'number'.",
            "src/a.ts:3:11-3:11 1 TS2339 Property 'foo' does not exist on type 'string'.",
        ])
    );
    assert_eq!(output, Vec::<String>::new());
    let text = "src/x.ts(2,5): error TS2345: Argument of type 'string' is not assignable.\n  Type 'string' is not 'number'.\nerror TS5102: Option 'baseUrl' has been removed.\n";
    let mut nested = Run::errorformat("node", text);
    nested.cwd = "packages/core";
    let (diagnostics, output, _) = nested.parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "packages/core/src/x.ts:1:4-1:4 1 TS2345 Argument of type 'string' is not assignable.\n  Type 'string' is not 'number'."
        ])
    );
    assert_eq!(
        output,
        strings(&["error TS5102: Option 'baseUrl' has been removed."])
    );
}

#[test]
fn resolves_paths_under_pnpm_and_turbo_prefixes_to_their_package() {
    let text = [
        "packages/core typecheck: src/a.ts(1,2): error TS2322: Bad.",
        "@vben/web:typecheck: src/b.vue(3,4): error TS2304: Cannot find name 'x'.",
        "packages/core typecheck: Done",
    ]
    .join("\n");
    let mut run = Run::errorformat("node", &text);
    run.streams.packages = HashMap::from([("@vben/web".to_owned(), "apps/web".to_owned())]);
    run.streams.dirs = HashSet::from(["packages/core".to_owned()]);
    let (diagnostics, output, _) = run.parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "packages/core/src/a.ts:0:1-0:1 1 TS2322 Bad.",
            "apps/web/src/b.vue:2:3-2:3 1 TS2304 Cannot find name 'x'."
        ])
    );
    assert_eq!(output, strings(&["packages/core typecheck: Done"]));
}

#[test]
fn reads_eslint_stylish_output_file_by_file() {
    let stylish = fixture("eslint-stylish.stdout");
    let (diagnostics, output, _) = Run::errorformat("node", &stylish).parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "src/c.js:0:6-0:6 1 no-unused-vars 'a' is assigned a value but never used",
            "src/c.js:1:0-1:0 1 no-debugger Unexpected 'debugger' statement",
            "src/c.js:2:0-2:0 1 no-undef 'foo' is not defined",
        ])
    );
    assert_eq!(output, strings(&["✖ 3 problems (3 errors, 0 warnings)"]));
}

#[test]
fn reads_github_annotations_and_keeps_biome_banner_as_output() {
    let (stdout, stderr) = (
        fixture("biome-github.stdout"),
        fixture("biome-github.stderr"),
    );
    let (diagnostics, output, _) = Run::errorformat("node", &stdout).stderr(&stderr).parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "src/App.svelte:1:6-1:7 2 lint/correctness/noUnusedVariables This variable x is unused.",
            "src/a.ts:1:6-1:12 2 lint/correctness/noUnusedVariables This variable unused is unused.",
            "src/c.js:0:6-0:7 2 lint/correctness/noUnusedVariables This variable a is unused.",
            "src/b.ts:0:0-0:9 1 lint/suspicious/noDebugger This is an unexpected use of the debugger statement.",
            "src/c.js:1:0-1:9 1 lint/suspicious/noDebugger This is an unexpected use of the debugger statement.",
        ])
    );
    assert_eq!(
        output,
        strings(&[
            stderr.lines().next().unwrap().trim(),
            "× Some errors were emitted while running checks."
        ])
    );
}

#[test]
fn turns_each_file_prettier_names_into_a_warning() {
    let (stdout, stderr) = (fixture("prettier.stdout"), fixture("prettier.stderr"));
    let (diagnostics, output, _) = Run::errorformat("node", &stdout).stderr(&stderr).parse();
    assert_eq!(
        diagnostics,
        strings(&["src/b.ts:0:0-0:0 2 [warn] src/b.ts"])
    );
    assert_eq!(
        output,
        strings(&[
            "Checking formatting...",
            "[warn] Code style issues found in the above file. Run Prettier with --write to fix."
        ])
    );
}

#[test]
fn reads_svelte_check_machine_and_human_output_to_the_same_places() {
    let places = |diagnostics: &[String]| -> Vec<String> {
        diagnostics
            .iter()
            .map(|d| d.split(' ').take(2).collect::<Vec<_>>().join(" "))
            .collect()
    };
    let expected = strings(&[
        "node_modules/esrap/types/types.d.ts:0:29-0:29 1",
        "node_modules/svelte/types/index.d.ts:859:36-859:36 1",
        "src/App.svelte:1:6-1:6 1",
        "src/a.ts:0:13-0:13 1",
        "src/a.ts:3:11-3:11 1",
        "tsconfig.json:0:2-0:2 2",
    ]);
    let machine = fixture("svelte-machine.stdout");
    let (diagnostics, output, _) = Run::errorformat("node", &machine).parse();
    assert_eq!(places(&diagnostics), expected);
    assert_eq!(
        diagnostics[2],
        "src/App.svelte:1:6-1:6 1 Type 'string' is not assignable to type 'number'."
    );
    assert_eq!(output.len(), 2);
    let human = fixture("svelte-human.stdout");
    let (diagnostics, output, _) = Run::errorformat("node", &human).parse();
    assert_eq!(places(&diagnostics), expected);
    assert_eq!(
        diagnostics[2],
        "src/App.svelte:1:6-1:6 1 Type 'string' is not assignable to type 'number'."
    );
    assert_eq!(
        output,
        strings(&[
            "====================================",
            "svelte-check found 5 errors and 1 warning in 5 files"
        ])
    );
}

#[test]
fn reads_two_line_formats_under_pnpm_prefixes_with_packages_interleaved() {
    let text = [
        "docs check$ svelte-check --tsconfig ./tsconfig.json",
        "docs check: /env/repo/docs/src/lib/colors.ts:12:14",
        "packages/cli check: /env/repo/packages/cli/src/a.ts:1:1",
        "docs check: Error: Type 'string' is not assignable to type 'number'. (ts)",
        "packages/cli check: Warn: Unused import.",
        "docs check: svelte-check found 1 error and 0 warnings in 1 file",
    ]
    .join("\n");
    let mut run = Run::errorformat("node", &text);
    run.streams.dirs = HashSet::from(["docs".to_owned(), "packages/cli".to_owned()]);
    let (diagnostics, output, _) = run.parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "docs/src/lib/colors.ts:11:13-11:13 1 Type 'string' is not assignable to type 'number'.",
            "packages/cli/src/a.ts:0:0-0:0 2 Unused import.",
        ])
    );
    assert_eq!(
        output,
        strings(&[
            "docs check$ svelte-check --tsconfig ./tsconfig.json",
            "docs check: svelte-check found 1 error and 0 warnings in 1 file"
        ])
    );
}

#[test]
fn reads_mypy_and_pyright_lines() {
    let mypy = fixture("mypy.stdout");
    let (diagnostics, output, _) = Run::errorformat("python", &mypy).parse();
    assert_eq!(
        diagnostics,
        strings(&[
            r#"pkg/a.py:0:0-0:0 1 assignment Incompatible types in assignment (expression has type "str", variable has type "int")"#,
            r#"pkg/a.py:4:0-4:0 1 return-value Incompatible return value type (got "int", expected "str")"#,
        ])
    );
    assert_eq!(
        output,
        strings(&["Found 2 errors in 1 file (checked 1 source file)"])
    );
    let pyright = [
        "/env/repo/searx/webapp.py",
        "  /env/repo/searx/webapp.py:10:5 - error: \"x\" is not defined (reportUndefinedVariable)",
        "  /env/repo/searx/webapp.py:12:1 - warning: Import cycle",
        "2 errors, 1 warning, 0 notes",
    ]
    .join("\n");
    let (diagnostics, output, _) = Run::errorformat("python", &pyright).parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "searx/webapp.py:9:4-9:4 1 reportUndefinedVariable \"x\" is not defined",
            "searx/webapp.py:11:0-11:0 2 Import cycle",
        ])
    );
    assert_eq!(
        output,
        strings(&["/env/repo/searx/webapp.py", "2 errors, 1 warning, 0 notes"])
    );
}

#[test]
fn reads_go_build_errors_and_vet_findings() {
    let build = fixture("go-build.stderr");
    let (diagnostics, output, _) = Run::errorformat("go", "").stderr(&build).parse();
    assert_eq!(
        diagnostics,
        strings(&[
            r#"pkg/a/b.go:2:12-2:12 1 cannot use "x" (untyped string constant) as int value in variable declaration"#
        ])
    );
    assert_eq!(output, strings(&["# example.com/w/pkg/a"]));
    let vet = format!(
        "{}\n# example.com/w/pkg/b\npkg/b/a.go:5:24: fmt.Printf format %d has arg \"x\" of wrong type string\n",
        fixture("go-vet-build-error.stderr")
    );
    let (diagnostics, _, _) = Run::errorformat("go", "")
        .stderr(&vet)
        .patterns(&["%Evet: %f:%l:%c: %m", "%W%f:%l:%c: %m"])
        .parse();
    assert_eq!(
        diagnostics,
        strings(&[
            r#"pkg/a/b.go:2:12-2:12 1 cannot use "x" (untyped string constant) as int value in variable declaration"#,
            r#"pkg/b/a.go:4:23-4:23 2 fmt.Printf format %d has arg "x" of wrong type string"#,
        ])
    );
}

#[test]
fn reads_cargo_short_messages() {
    let stderr = "    Checking repo v0.1.0 (/env/repo)\nsrc/lib.rs:1:20: error[E0308]: mismatched types: expected `u32`, found `&str`\nerror: could not compile `repo` (lib) due to 1 previous error\n";
    let (diagnostics, output, _) = Run::errorformat("rust", "").stderr(stderr).parse();
    assert_eq!(
        diagnostics,
        strings(&["src/lib.rs:0:19-0:19 1 E0308 mismatched types: expected `u32`, found `&str`"])
    );
    assert_eq!(
        output,
        strings(&[
            "Checking repo v0.1.0 (/env/repo)",
            "error: could not compile `repo` (lib) due to 1 previous error"
        ])
    );
}

#[test]
fn keeps_a_line_about_a_file_outside_the_repo_as_output() {
    let text = "/home/agent/.ssh/id_rsa(1,1): error TS1005: secret\n../../etc/passwd:1:1: oops\n";
    let (diagnostics, output, _) = Run::errorformat("node", text).parse();
    assert_eq!(diagnostics, Vec::<String>::new());
    assert_eq!(
        output,
        strings(&[
            "/home/agent/.ssh/id_rsa(1,1): error TS1005: secret",
            "../../etc/passwd:1:1: oops"
        ])
    );
}

#[test]
fn reads_sarif_results_and_keeps_what_is_not_sarif() {
    let sarif = r#"warning: a banner
{"version":"2.1.0","runs":[{"tool":{"driver":{"name":"ruff"}},"originalUriBaseIds":{"ROOT":{"uri":"file:///env/repo/"}},"results":[
 {"ruleId":"F401","level":"error","message":{"text":"`os` imported but unused"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"file:///env/repo/pkg/a%20b.py"},"region":{"startLine":2,"startColumn":8,"endLine":2,"endColumn":10}}}]},
 {"ruleId":"E501","message":{"text":"Line too long"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"pkg/c.py","uriBaseId":"ROOT"},"region":{"startLine":3}}}]},
 {"ruleId":"X1","level":"note","message":{"text":"outside"},"locations":[{"physicalLocation":{"artifactLocation":{"uri":"file:///etc/passwd"}}}]}
]}]}"#;
    let (diagnostics, output, _) = Run::with(Format::Sarif, sarif)
        .stderr("Found 3 errors.")
        .parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "pkg/a b.py:1:7-1:9 1 F401 `os` imported but unused",
            "pkg/c.py:2:0-2:0 2 E501 Line too long"
        ])
    );
    assert_eq!(
        output,
        strings(&[
            "warning: a banner",
            "file:///etc/passwd: outside",
            "Found 3 errors."
        ])
    );
    let (diagnostics, output, _) =
        Run::with(Format::Sarif, "Oops! Something went wrong!\n").parse();
    assert_eq!(
        (diagnostics, output),
        (vec![], strings(&["Oops! Something went wrong!"]))
    );
}

#[test]
fn counts_junit_testcases_from_a_report() {
    let junit = r#"<?xml version="1.0" encoding="UTF-8" ?>
<testsuites name="vitest tests" tests="4" failures="1" errors="0">
  <testsuite name="test/basic.test.ts" tests="4">
    <testcase classname="test/basic.test.ts" name="adds" time="0.001"></testcase>
    <testcase classname="test/basic.test.ts" name="subtracts" time="0.001"/>
    <testcase classname="test/basic.test.ts" name="divides" time="0.002">
      <failure message="expected 1 to be 2" type="AssertionError">AssertionError: expected 1 to be 2</failure>
    </testcase>
    <testcase classname="test/basic.test.ts" name="later"><skipped/></testcase>
  </testsuite>
</testsuites>"#;
    let mut run = Run::with(
        Format::Junit,
        " RUN  v3.2.4\n FAIL  test/basic.test.ts > divides\n",
    );
    run.report = Some(junit);
    let (_, output, counts) = run.parse();
    assert_eq!(
        counts,
        Some(Counts {
            passed: 2,
            failed: 1,
            skipped: 1
        })
    );
    assert_eq!(
        output,
        strings(&["RUN  v3.2.4", "FAIL  test/basic.test.ts > divides"])
    );
    assert_eq!(Run::with(Format::Junit, "no report").parse().2, None);
}

#[test]
fn counts_tap_tests_but_not_the_files_and_suites_that_hold_them() {
    let tap = "TAP version 13\n# Subtest: src/greet.test.ts\n    # Subtest: greets\n    ok 1 - greets\n      ---\n      duration_ms: 1\n      ...\n    not ok 2 - shouts\n    ok 3 - whispers # SKIP not yet\n    1..3\nnot ok 1 - src/greet.test.ts\nok 2 - flat # TODO later\n1..2\n# pass 1\n# fail 1\n";
    assert_eq!(
        Run::with(Format::Tap, tap).parse().2,
        Some(Counts {
            passed: 1,
            failed: 1,
            skipped: 2
        })
    );
}

#[test]
fn keeps_every_line_as_output_in_raw() {
    let (diagnostics, output, counts) = Run::with(Format::Raw, "a\n\n  b  \na\n")
        .stderr("src/a.ts:1:1: c")
        .parse();
    assert_eq!(
        (diagnostics, output, counts),
        (vec![], strings(&["a", "b", "src/a.ts:1:1: c"]), None)
    );
}

#[test]
fn counts_vitest_and_jest_summaries_in_raw_output() {
    let vitest =
        " ✓ src/a.test.ts (4 tests) 3ms\n\n Test Files  1 passed (1)\n      Tests  4 passed (4)\n";
    let failing = " Test Files  1 failed (1)\n      Tests  1 failed | 2 passed | 1 skipped (4)\n";
    let jest = "Test Suites: 1 failed, 1 total\nTests:       1 failed, 2 todo, 3 passed, 6 total\n";
    let counts = |stdout: &str| Run::with(Format::Raw, stdout).parse().2;
    assert_eq!(
        counts(vitest),
        Some(Counts {
            passed: 4,
            failed: 0,
            skipped: 0
        })
    );
    assert_eq!(
        counts(&format!("{vitest}{failing}")),
        Some(Counts {
            passed: 6,
            failed: 1,
            skipped: 1
        })
    );
    assert_eq!(
        counts(jest),
        Some(Counts {
            passed: 3,
            failed: 1,
            skipped: 2
        })
    );
}

#[test]
fn reads_oxlint_github_annotations_with_the_rule_last() {
    let stdout = fixture("oxlint-github.stdout");
    let (diagnostics, output, _) = Run::errorformat("node", &stdout).parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "packages/shared/src/__probe.ts:1:4-1:5 1 eslint(no-unused-vars) packages/shared/src/__probe.ts:2:5: Variable 'b' is declared but never used. Unused variables should start with a '_'.",
            "packages/shared/src/__probe.ts:1:11-1:20 2 eslint(no-debugger) packages/shared/src/__probe.ts:2:12: `debugger` statement is not allowed",
        ])
    );
    assert_eq!(
        output,
        strings(&[
            "Found 1 warning and 1 error.",
            "Finished in 297ms on 1 file with 200 rules using 4 threads."
        ])
    );
}

#[test]
fn reads_tsc_errors_under_the_package_vp_run_names() {
    let stdout = fixture("vp-typecheck.stdout");
    let (diagnostics, _, _) = Run::errorformat("node", &stdout).parse();
    assert_eq!(
        diagnostics,
        strings(&[
            "packages/shared/src/String.ts:9:13-9:13 1 TS2322 Type 'string' is not assignable to type 'number'.",
            "scripts/a.ts:1:0-1:0 1 TS2304 Cannot find name 'x'.",
        ])
    );
}

#[test]
fn refuses_a_pattern_it_cannot_read() {
    let adapters = Adapters::load(None).unwrap();
    for adapter in &adapters.list {
        assert_eq!(
            Format::Errorformat(adapter.output.errorformat.clone()).validate(),
            Ok(()),
            "{}",
            adapter.name
        );
    }
    assert!(
        Format::Errorformat(vec!["%G%f".to_owned()])
            .validate()
            .is_err()
    );
    assert!(
        Format::Errorformat(vec!["%f:%[a-z".to_owned()])
            .validate()
            .is_err()
    );
}
