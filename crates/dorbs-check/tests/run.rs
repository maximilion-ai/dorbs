//! What a request runs, and what it answers from what ran.

use std::time::{Duration, Instant};

use dorbs_check::adapter::Adapters;
use dorbs_check::format::{Format, Streams};
use dorbs_check::local::Checkout;
use dorbs_check::process::ProcessResult;
use dorbs_check::protocol::{CheckId, RunStatus, Scope};
use dorbs_check::recipe::{Check, Test};
use dorbs_check::run::{self, Command, Ran, Timings};

fn test(run: &str, filter_flag: Option<&str>) -> Test {
    Test {
        run: run.to_owned(),
        cwd: ".".to_owned(),
        packages: None,
        filter_flag: filter_flag.map(str::to_owned),
        all: String::new(),
        format: Format::Raw,
    }
}

fn commands(
    test: &Test,
    files: &[&str],
    filter: Option<&str>,
) -> Result<Vec<(String, String)>, String> {
    let files: Vec<String> = files.iter().map(|f| (*f).to_owned()).collect();
    run::test_commands(test, &files, filter)
        .map(|commands| commands.into_iter().map(|c| (c.run, c.cwd)).collect())
}

fn at_root(runs: &[&str]) -> Result<Vec<(String, String)>, String> {
    Ok(runs
        .iter()
        .map(|run| ((*run).to_owned(), ".".to_owned()))
        .collect())
}

#[test]
fn fills_in_the_files_and_the_filter_quoted_for_the_shell() {
    let vitest = test("pnpm exec vitest run {files} {filter}", Some("-t"));
    assert_eq!(
        commands(
            &vitest,
            &["test/a b.test.ts", "test/it's.test.ts"],
            Some("adds $x")
        ),
        at_root(&[r"pnpm exec vitest run 'test/a b.test.ts' 'test/it'\''s.test.ts' -t 'adds $x'"])
    );
    assert_eq!(
        commands(&vitest, &[], None),
        at_root(&["pnpm exec vitest run"])
    );
}

#[test]
fn passes_pytest_ids_through_and_cargos_filter_positionally() {
    let pytest = test("pytest -q {files} {filter}", Some("-k"));
    assert_eq!(
        commands(&pytest, &["tests/test_a.py::test_b"], None),
        at_root(&["pytest -q 'tests/test_a.py::test_b'"])
    );
    let cargo = test("cargo test {filter}", Some(""));
    assert_eq!(
        commands(&cargo, &[], Some("routing::nest")),
        at_root(&["cargo test 'routing::nest'"])
    );
    assert_eq!(
        commands(&cargo, &["src/lib.rs"], None),
        Err("This repo's test command takes a name filter, not files. Pass filter instead.".into())
    );
    let make = test("make test", None);
    assert_eq!(
        commands(&make, &[], Some("x")),
        Err("This repo's test command takes no name filter. Pass files instead.".into())
    );
    assert_eq!(
        commands(&make, &["a"], None),
        Err("This repo's test command runs every test and takes no files.".into())
    );
}

#[test]
fn tests_the_go_packages_of_the_files_or_every_package() {
    let mut go = test("go test -v {dirs} {filter}", Some("-run"));
    go.all = "./...".to_owned();
    assert_eq!(
        commands(
            &go,
            &[
                "pkg/cmd/pr/pr_test.go",
                "pkg/cmd/pr/view.go",
                "main_test.go"
            ],
            Some("TestPR")
        ),
        at_root(&["go test -v './pkg/cmd/pr' '.' -run 'TestPR'"])
    );
    assert_eq!(commands(&go, &[], None), at_root(&["go test -v ./..."]));
}

#[test]
fn runs_once_per_workspace_package_with_files_relative_to_it() {
    let mut npm = test("npm test -w {dir} -- {files}", None);
    npm.packages = Some(vec![".".into(), "apps/web".into(), "packages/core".into()]);
    assert_eq!(
        commands(
            &npm,
            &[
                "apps/web/src/a.test.ts",
                "packages/core/b.test.ts",
                "apps/web/c.test.ts",
                "scripts/x.test.ts"
            ],
            None
        ),
        at_root(&[
            "npm test -w '.' -- 'scripts/x.test.ts'",
            "npm test -w 'apps/web' -- 'src/a.test.ts' 'c.test.ts'",
            "npm test -w 'packages/core' -- 'b.test.ts'",
        ])
    );
    // Without files the repo's whole suite runs from the root.
    assert_eq!(commands(&npm, &[], None), at_root(&["npm test -w '.' --"]));
    let mut vitest = test(
        "cd {dir} && pnpm exec vitest run {files} {filter}",
        Some("-t"),
    );
    vitest.packages = Some(vec![".".into(), "test/unit".into()]);
    assert_eq!(
        commands(
            &vitest,
            &["test/unit/test/a.test.ts", "scripts/b.test.ts"],
            Some("x")
        ),
        at_root(&[
            "cd '.' && pnpm exec vitest run 'scripts/b.test.ts' -t 'x'",
            "cd 'test/unit' && pnpm exec vitest run 'test/a.test.ts' -t 'x'"
        ])
    );
}

#[test]
fn refuses_a_file_outside_the_repo_or_the_tests_directory() {
    let mut vitest = test("vitest run {files}", None);
    assert_eq!(
        commands(&vitest, &["../x.test.ts"], None),
        Err("../x.test.ts is not a path inside the repo.".into())
    );
    vitest.cwd = "packages/a".to_owned();
    assert_eq!(
        commands(&vitest, &["packages/a/x.test.ts"], None),
        Ok(vec![("vitest run 'x.test.ts'".into(), "packages/a".into())])
    );
    assert_eq!(
        commands(&vitest, &["b.test.ts"], None),
        Err("b.test.ts is outside packages/a, where the tests run.".into())
    );
}

fn ran(stdout: &str, exit_code: Option<i32>, timed_out: bool) -> Ran {
    Ran {
        run: "x".to_owned(),
        result: ProcessResult {
            stdout: stdout.to_owned(),
            stderr: String::new(),
            exit_code,
            timed_out,
            truncated: false,
        },
        report: None,
        duration: Duration::from_millis(5),
    }
}

fn timings() -> Timings {
    Timings {
        env_key: "k".to_owned(),
        started: Instant::now(),
        setup_ms: 7,
        overlay_ms: 3,
    }
}

#[test]
fn answers_a_check_with_errors_first_and_the_lines_no_format_read() {
    let check = Check {
        id: CheckId::try_from("typecheck").unwrap(),
        run: "tsc".to_owned(),
        cwd: ".".to_owned(),
        format: Format::Errorformat(vec![
            "%f:%l:%c: %trror: %m".into(),
            "%f:%l:%c: %tarning: %m".into(),
        ]),
    };
    let output = "a.ts:1:1: warning: w\nb.ts:2:2: error: e\nFound 1 error.\n";
    let run = run::check_run(
        &check,
        &ran(output, Some(1), false),
        "/env/repo",
        &Streams::default(),
    );
    assert_eq!(run.status, RunStatus::Failed);
    assert_eq!(
        run.diagnostics
            .iter()
            .map(|d| d.path.to_string())
            .collect::<Vec<_>>(),
        vec!["b.ts", "a.ts"]
    );
    assert_eq!(run.output, vec!["Found 1 error."]);
    let timed_out = run::check_run(
        &check,
        &ran("", None, true),
        "/env/repo",
        &Streams::default(),
    );
    let result = run::check_result(&[&check], vec![run, timed_out], timings());
    assert_eq!(
        (result.scope, result.complete, result.setup_ms),
        (Scope::Repo, false, 7)
    );
    assert_eq!(result.checks[1].status, RunStatus::TimedOut);
}

#[test]
fn skips_a_check_of_changed_files_when_none_changed_under_it() {
    let check = Check {
        id: CheckId::try_from("fmt").unwrap(),
        run: "prettier --check {changed}".to_owned(),
        cwd: "web".to_owned(),
        format: Format::Raw,
    };
    let change: dorbs_check::protocol::Change = serde_json::from_value(serde_json::json!({
        "files": [{ "path": "web/a b.ts", "content": "" }, { "path": "api/c.ts", "content": "" }],
        "deleted": [],
    }))
    .unwrap();
    assert_eq!(
        run::check_command(&check, &change),
        Some(Command {
            cwd: "web".into(),
            run: "prettier --check 'a b.ts'".into()
        })
    );
    assert_eq!(run::check_command(&check, &Default::default()), None);
    assert_eq!(
        run::check_result(&[&check], vec![run::skipped(&check)], timings()).scope,
        Scope::Changed
    );
}

#[test]
fn sums_test_counts_across_runs_and_keeps_the_end_of_the_output() {
    let mut tap = test("node --test", None);
    tap.format = Format::Tap;
    let runs = [
        ran("ok 1 - a\nnot ok 2 - b\n", Some(1), false),
        ran("ok 1 - c\n", Some(0), false),
    ];
    let result = run::test_result(&tap, &runs, timings());
    assert_eq!(
        (result.passed, result.failed, result.skipped),
        (Some(2), Some(1), Some(0))
    );
    assert_eq!(
        (result.status, result.exit_code),
        (RunStatus::Failed, Some(1))
    );
    let long = "x".repeat(40 * 1024);
    let result = run::test_result(
        &test("go test", None),
        &[ran(&long, Some(0), false)],
        timings(),
    );
    assert_eq!(
        (result.passed, result.output.len(), result.truncated),
        (None, 32 * 1024, true)
    );
}

/// A checkout with only make, sh and git, so the test runs anywhere the crate builds.
fn checkout(files: &[(&str, &str)]) -> (tempdir::Dir, Checkout) {
    let dir = tempdir::Dir::new();
    for (path, content) in files {
        let path = dir.0.join(path);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, content).unwrap();
    }
    let checkout = Checkout::open(&dir.0, Adapters::load(None).unwrap()).unwrap();
    (dir, checkout)
}

mod tempdir {
    pub struct Dir(pub std::path::PathBuf);
    impl Dir {
        pub fn new() -> Dir {
            static NEXT: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let n = NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            let dir =
                std::env::temp_dir().join(format!("dorbs-check-test-{}-{n}", std::process::id()));
            std::fs::create_dir_all(&dir).unwrap();
            Dir(dir)
        }
    }
    impl Drop for Dir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

#[tokio::test]
async fn checks_and_tests_a_local_checkout_with_its_own_commands() {
    let (_dir, checkout) = checkout(&[
        ("go.mod", "module x\n"),
        (
            "Makefile",
            "typecheck:\n\t@echo 'main.go:3:7: undefined: x' >&2; exit 1\nlint:\n\t@echo clean\n",
        ),
        (
            ".dorbs/check.json",
            r#"{"test":{"run":"sh test.sh {report} {files}","format":"tap"}}"#,
        ),
        (
            "test.sh",
            "printf 'ok 1 - a\\nnot ok 2 - b # TODO later\\n' > \"$1\"; shift; echo \"ran $*\"\n",
        ),
    ]);
    let result = checkout.check(None).await.unwrap();
    let summary: Vec<(String, RunStatus, usize)> = result
        .checks
        .iter()
        .map(|run| (run.id.to_string(), run.status, run.diagnostics.len()))
        .collect();
    assert_eq!(
        summary,
        vec![
            ("typecheck".into(), RunStatus::Failed, 1),
            ("lint".into(), RunStatus::Passed, 0)
        ]
    );
    assert_eq!(result.checks[0].command, "make typecheck");
    assert_eq!(result.checks[0].diagnostics[0].message, "undefined: x");
    let only = [CheckId::try_from("lint").unwrap()];
    assert_eq!(checkout.check(Some(&only)).await.unwrap().checks.len(), 1);
    let tested = checkout
        .test(&["a_test.go".to_owned()], None)
        .await
        .unwrap();
    assert_eq!(
        (tested.status, tested.passed, tested.skipped),
        (RunStatus::Passed, Some(1), Some(1))
    );
    assert!(tested.output.contains("ran a_test.go"), "{}", tested.output);
}
