//! What a check or test request runs and what it answers, the same in the service's containers and
//! in a local checkout: the runner decides where commands run.

use std::collections::BTreeMap;
use std::time::{Duration, Instant};

use crate::format::{self, Counts, ParseContext, Streams};
use crate::process::ProcessResult;
use crate::protocol::{
    Change, CheckId, CheckRun, Diagnostic, RejectReason, RelativePath, RunStatus, Scope, TestResult,
};
use crate::recipe::{Check, Recipe, Test};

// What a check's answer carries of the lines no format read, and a test's of its output.
const OUTPUT_LINES: usize = 200;
const OUTPUT_BYTES: usize = 32 * 1024;
/// A report document must not be cut, so a run keeps this much of each stream.
pub const KEEP_BYTES: usize = 16 * 1024 * 1024;
// What a check's answer carries of its diagnostics, errors first.
const MAX_DIAGNOSTICS: usize = 1000;

/// A shell command, run with `sh -c` from `cwd` under the repo root. `{report}` in it names a file
/// the runner reads after the run.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Command {
    pub cwd: String,
    pub run: String,
}

/// A command's run: what it printed, and the report it wrote.
#[derive(Debug, Clone)]
pub struct Ran {
    /// The command as it ran, `{report}` filled in.
    pub run: String,
    pub result: ProcessResult,
    pub report: Option<String>,
    pub duration: Duration,
}

/// Where commands run: a container of the environment, or the machine itself.
pub trait Runner {
    /// The repo root as commands see it.
    fn root(&self) -> &str;
    fn exec(&self, command: &Command, timeout: Duration) -> impl Future<Output = Ran> + Send;
}

/// `value` as one POSIX shell word.
pub fn quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', r"'\''"))
}

fn words<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    values.into_iter().map(quote).collect::<Vec<_>>().join(" ")
}

/// `template` with `{name}` as `value`, and the space before it gone when `value` is empty.
fn fill(template: &str, name: &str, value: &str) -> String {
    let placeholder = format!("{{{name}}}");
    if value.is_empty() {
        template
            .replace(&format!(" {placeholder}"), "")
            .replace(&placeholder, "")
    } else {
        template.replace(&placeholder, value)
    }
}

/// The checks a request runs, or why it names checks the recipe does not have.
pub fn select<'a>(
    recipe: &'a Recipe,
    only: Option<&[CheckId]>,
) -> Result<Vec<&'a Check>, RejectReason> {
    let known: Vec<CheckId> = recipe.checks.iter().map(|check| check.id.clone()).collect();
    let Some(only) = only else {
        return Ok(recipe.checks.iter().collect());
    };
    let unknown: Vec<String> = only
        .iter()
        .filter(|id| !known.contains(id))
        .map(|id| id.to_string())
        .collect();
    if !unknown.is_empty() {
        return Err(RejectReason::UnknownChecks {
            ids: unknown,
            known,
        });
    }
    Ok(recipe
        .checks
        .iter()
        .filter(|check| only.contains(&check.id))
        .collect())
}

/// The command a check runs, or None when it looks at changed files and none changed under it.
pub fn check_command(check: &Check, change: &Change) -> Option<Command> {
    if !check.run.contains("{changed}") {
        return Some(Command {
            cwd: check.cwd.clone(),
            run: check.run.clone(),
        });
    }
    let prefix = if check.cwd == "." {
        String::new()
    } else {
        format!("{}/", check.cwd)
    };
    let changed: Vec<&str> = (change.files.iter())
        .filter_map(|file| file.path.strip_prefix(prefix.as_str()))
        .collect();
    (!changed.is_empty()).then(|| Command {
        cwd: check.cwd.clone(),
        run: fill(&check.run, "changed", &words(changed)),
    })
}

pub fn skipped(check: &Check) -> CheckRun {
    CheckRun {
        id: check.id.clone(),
        command: check.run.clone(),
        status: RunStatus::Skipped,
        exit_code: None,
        duration_ms: 0,
        diagnostics: vec![],
        output: vec!["No changed files under this check's directory.".to_owned()],
        truncated: false,
    }
}

fn status(result: &ProcessResult) -> RunStatus {
    match (result.timed_out, result.exit_code) {
        (true, _) => RunStatus::TimedOut,
        (false, Some(0)) => RunStatus::Passed,
        _ => RunStatus::Failed,
    }
}

/// A check's answer from its run.
pub fn check_run(check: &Check, ran: &Ran, root: &str, streams: &Streams) -> CheckRun {
    let context = ParseContext {
        root,
        cwd: &check.cwd,
        source: &check.id,
        streams,
    };
    let result = &ran.result;
    let parsed = format::parse(
        &check.format,
        &result.stdout,
        &result.stderr,
        ran.report.as_deref(),
        &context,
    )
    .unwrap_or_else(|error| format::Parsed {
        output: vec![error],
        ..Default::default()
    });
    let mut diagnostics: Vec<Diagnostic> = parsed.diagnostics;
    diagnostics.sort_by_key(|d| d.severity);
    let cut_diagnostics = diagnostics.len() > MAX_DIAGNOSTICS;
    diagnostics.truncate(MAX_DIAGNOSTICS);
    let (output, cut_output) = cap_lines(parsed.output);
    CheckRun {
        id: check.id.clone(),
        command: ran.run.clone(),
        status: status(result),
        exit_code: result.exit_code,
        duration_ms: ran.duration.as_millis() as u64,
        diagnostics,
        output,
        truncated: result.truncated || cut_output || cut_diagnostics,
    }
}

/// The first output lines, within a line and a byte cap.
fn cap_lines(lines: Vec<String>) -> (Vec<String>, bool) {
    let mut bytes = 0;
    let mut kept = Vec::new();
    for line in lines {
        bytes += line.len() + 1;
        if kept.len() >= OUTPUT_LINES || bytes > OUTPUT_BYTES {
            return (kept, true);
        }
        kept.push(line);
    }
    (kept, false)
}

pub struct Timings {
    pub env_key: String,
    pub started: Instant,
    pub setup_ms: u64,
    pub overlay_ms: u64,
}

pub fn check_result(
    checks: &[&Check],
    runs: Vec<CheckRun>,
    timings: Timings,
) -> crate::protocol::CheckResult {
    crate::protocol::CheckResult {
        env_key: timings.env_key,
        duration_ms: timings.started.elapsed().as_millis() as u64,
        setup_ms: timings.setup_ms,
        overlay_ms: timings.overlay_ms,
        scope: if checks.iter().any(|check| check.run.contains("{changed}")) {
            Scope::Changed
        } else {
            Scope::Repo
        },
        complete: runs.iter().all(|run| {
            matches!(run.status, RunStatus::Passed | RunStatus::Failed) && !run.truncated
        }),
        checks: runs,
    }
}

/// The commands a test request runs: one, or one per workspace package of its files.
pub fn test_commands(
    test: &Test,
    files: &[String],
    filter: Option<&str>,
) -> Result<Vec<Command>, String> {
    for file in files {
        // A pytest id names its test after ::.
        let path = file.split("::").next().unwrap_or_default();
        if RelativePath::try_from(path).is_err() {
            return Err(format!("{file} is not a path inside the repo."));
        }
    }
    let takes_files = test.run.contains("{files}") || test.run.contains("{dirs}");
    if filter.is_some() && (test.filter_flag.is_none() || !test.run.contains("{filter}")) {
        return Err(
            "This repo's test command takes no name filter. Pass files instead.".to_owned(),
        );
    }
    if !files.is_empty() && !takes_files {
        return Err(if test.filter_flag.is_some() {
            "This repo's test command takes a name filter, not files. Pass filter instead."
                .to_owned()
        } else {
            "This repo's test command runs every test and takes no files.".to_owned()
        });
    }
    let filter = match (filter, test.filter_flag.as_deref()) {
        (Some(filter), Some("")) => quote(filter),
        (Some(filter), Some(flag)) => format!("{flag} {}", quote(filter)),
        _ => String::new(),
    };
    let command = |cwd: &str, dir: Option<&str>, files: &[&str]| {
        let mut dirs: Vec<String> = Vec::new();
        for file in files {
            let dir = file
                .split("::")
                .next()
                .unwrap_or_default()
                .rsplit_once('/')
                .map_or(".".to_owned(), |(dir, _)| format!("./{dir}"));
            if !dirs.contains(&dir) {
                dirs.push(dir);
            }
        }
        let (files, dirs) = if files.is_empty() {
            (test.all.clone(), test.all.clone())
        } else {
            (
                words(files.iter().copied()),
                words(dirs.iter().map(String::as_str)),
            )
        };
        let mut run = fill(&test.run, "files", &files);
        run = fill(&run, "dirs", &dirs);
        run = fill(&run, "filter", &filter);
        if let Some(dir) = dir {
            run = fill(&run, "dir", &quote(dir));
        }
        Command {
            cwd: cwd.to_owned(),
            run,
        }
    };
    let Some(packages) = &test.packages else {
        let prefix = if test.cwd == "." {
            String::new()
        } else {
            format!("{}/", test.cwd)
        };
        let mut relative = Vec::new();
        for file in files {
            match file.strip_prefix(prefix.as_str()) {
                Some(file) => relative.push(file),
                None => {
                    return Err(format!(
                        "{file} is outside {}, where the tests run.",
                        test.cwd
                    ));
                }
            }
        }
        return Ok(vec![command(&test.cwd, None, &relative)]);
    };
    if files.is_empty() {
        return Ok(vec![command(&test.cwd, Some("."), &[])]);
    }
    let mut members: Vec<&String> = packages.iter().filter(|dir| *dir != ".").collect();
    members.sort_by_key(|dir| std::cmp::Reverse(dir.len()));
    let mut groups: BTreeMap<&str, Vec<&str>> = BTreeMap::new();
    for file in files {
        let dir = members
            .iter()
            .find(|dir| file.starts_with(&format!("{dir}/")))
            .map_or(".", |dir| dir.as_str());
        let relative = if dir == "." {
            file.as_str()
        } else {
            &file[dir.len() + 1..]
        };
        groups.entry(dir).or_default().push(relative);
    }
    Ok(groups
        .into_iter()
        .map(|(dir, files)| command(&test.cwd, Some(dir), &files))
        .collect())
}

/// A test's answer from its runs.
pub fn test_result(test: &Test, runs: &[Ran], timings: Timings) -> TestResult {
    let output: String = (runs.iter())
        .map(|ran| {
            let result = &ran.result;
            if result.stderr.is_empty() {
                result.stdout.clone()
            } else {
                format!("{}\n{}", result.stdout, result.stderr)
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    let streams = Streams::default();
    let counts: Option<Counts> = (runs.iter())
        .map(|ran| {
            let context = ParseContext {
                root: "/",
                cwd: ".",
                source: "test",
                streams: &streams,
            };
            let r = &ran.result;
            format::parse(
                &test.format,
                &r.stdout,
                &r.stderr,
                ran.report.as_deref(),
                &context,
            )
            .ok()?
            .counts
        })
        .sum();
    let failed = runs.iter().find(|ran| ran.result.exit_code != Some(0));
    // A run's failures and summary come last, so its end is what stays.
    let cut = output.len() > OUTPUT_BYTES;
    let output = if cut {
        let mut at = output.len() - OUTPUT_BYTES;
        while !output.is_char_boundary(at) {
            at += 1;
        }
        output[at..].to_owned()
    } else {
        output
    };
    TestResult {
        env_key: timings.env_key,
        duration_ms: timings.started.elapsed().as_millis() as u64,
        setup_ms: timings.setup_ms,
        overlay_ms: timings.overlay_ms,
        command: runs
            .iter()
            .map(|ran| ran.run.as_str())
            .collect::<Vec<_>>()
            .join(" && "),
        status: if runs.iter().any(|ran| ran.result.timed_out) {
            RunStatus::TimedOut
        } else if failed.is_some() {
            RunStatus::Failed
        } else {
            RunStatus::Passed
        },
        exit_code: failed.map_or(Some(0), |ran| ran.result.exit_code),
        passed: counts.map(|c| c.passed),
        failed: counts.map(|c| c.failed),
        skipped: counts.map(|c| c.skipped),
        output,
        truncated: cut || runs.iter().any(|ran| ran.result.truncated),
    }
}
