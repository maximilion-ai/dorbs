//! How a run's output becomes diagnostics and test counts. Each format reads one kind of report;
//! whatever it does not read comes back as output lines, so nothing a tool says is dropped.

mod errorformat;
mod junit;
mod sarif;
mod tap;

use std::collections::{HashMap, HashSet};

use regex::Regex;
use serde::Serialize;

use crate::protocol::{Diagnostic, Position, Range, RelativePath, Severity};
pub use errorformat::Errorformat;
use errorformat::Line;

/// A tool's report format.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    /// SARIF 2.1, as ruff, golangci-lint and semgrep write it.
    Sarif,
    /// Lines read with vim's errorformat patterns.
    Errorformat(Vec<String>),
    /// JUnit XML from a test runner: counts only.
    Junit,
    /// The Test Anything Protocol, as node --test writes it: counts only.
    Tap,
    /// Nothing to read: every line is output.
    Raw,
}

impl Format {
    /// Checks that the format can be used, so a bad pattern fails when its recipe loads.
    pub fn validate(&self) -> Result<(), String> {
        match self {
            Format::Errorformat(patterns) => Errorformat::new(patterns).map(|_| ()),
            _ => Ok(()),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Counts {
    pub passed: u64,
    pub failed: u64,
    pub skipped: u64,
}

impl std::iter::Sum for Counts {
    fn sum<I: Iterator<Item = Counts>>(iter: I) -> Counts {
        iter.fold(Counts::default(), |a, b| a + b)
    }
}

impl std::ops::Add for Counts {
    type Output = Counts;
    fn add(self, other: Counts) -> Counts {
        Counts {
            passed: self.passed + other.passed,
            failed: self.failed + other.failed,
            skipped: self.skipped + other.skipped,
        }
    }
}

/// How lines that carry a package prefix, as `pnpm -r` and turbo print them, map to the package's
/// directory, whose paths they name relative to it.
#[derive(Debug, Clone, Default)]
pub struct Streams {
    /// Regexes with a `line` group and a `dir` or `package` group.
    pub prefixes: Vec<Regex>,
    /// Package directories by package name.
    pub packages: HashMap<String, String>,
    /// Every directory of the repo, so a `dir` prefix counts only when it names one.
    pub dirs: HashSet<String>,
}

pub struct ParseContext<'a> {
    /// The repo root as the tool sees it, such as /env/repo.
    pub root: &'a str,
    /// The directory the tool ran in, relative to the repo root, "." for the root.
    pub cwd: &'a str,
    /// What the diagnostics name as their source: the check's id.
    pub source: &'a str,
    pub streams: &'a Streams,
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Parsed {
    pub diagnostics: Vec<Diagnostic>,
    /// Lines no format read, trimmed, blank ones and repeats dropped.
    pub output: Vec<String>,
    pub counts: Option<Counts>,
}

/// Reads a run's output in `format`: from `report`, the file the run wrote, when it wrote one, else
/// from stdout and stderr. Every line not read ends up in the output.
pub fn parse(
    format: &Format,
    stdout: &str,
    stderr: &str,
    report: Option<&str>,
    context: &ParseContext,
) -> Result<Parsed, String> {
    let mut into = Collector::default();
    let mut counts = None;
    let streams: Vec<&str> = match report {
        Some(report) => {
            into.raw(stdout);
            into.raw(stderr);
            vec![report]
        }
        None => vec![stdout, stderr],
    };
    match format {
        Format::Raw => streams.iter().for_each(|text| into.raw(text)),
        Format::Errorformat(patterns) => {
            let errorformat = Errorformat::new(patterns)?;
            for text in streams {
                for (cwd, lines) in demux(context, text) {
                    let stream = StreamContext {
                        root: context.root,
                        cwd: &cwd,
                        source: context.source,
                    };
                    errorformat.parse(&stream, &lines, &mut into);
                }
            }
        }
        Format::Sarif => {
            let stream = StreamContext {
                root: context.root,
                cwd: context.cwd,
                source: context.source,
            };
            let (document, rest) = streams.split_first().expect("one stream at least");
            sarif::parse(&stream, document, &mut into);
            rest.iter().for_each(|text| into.raw(text));
        }
        Format::Junit | Format::Tap => {
            let (document, rest) = streams.split_first().expect("one stream at least");
            counts = if *format == Format::Junit {
                junit::counts(document)
            } else {
                tap::counts(document)
            };
            if report.is_none() {
                into.raw(document);
            }
            rest.iter().for_each(|text| into.raw(text));
        }
    }
    let output = into
        .output
        .into_iter()
        .filter(|line| !line.is_empty())
        .collect();
    Ok(Parsed {
        diagnostics: into.diagnostics,
        output,
        counts,
    })
}

/// The output split into one stream per package directory, by the prefix before each line, so a
/// multi-line message stays whole when packages' lines interleave.
fn demux(context: &ParseContext, text: &str) -> Vec<(String, Vec<Line>)> {
    let mut streams: Vec<(String, Vec<Line>)> = Vec::new();
    for printed in text.split('\n') {
        let raw = printed.trim_end().to_owned();
        let (cwd, body) = context
            .streams
            .prefixes
            .iter()
            .find_map(|prefix| {
                let caps = prefix.captures(&raw)?;
                let body = caps.name("line")?.as_str().to_owned();
                if let Some(dir) = caps.name("dir") {
                    let dir = join(context.cwd, dir.as_str());
                    return context.streams.dirs.contains(&dir).then_some((dir, body));
                }
                let dir = context
                    .streams
                    .packages
                    .get(caps.name("package")?.as_str())?;
                Some((dir.clone(), body))
            })
            .unwrap_or_else(|| (context.cwd.to_owned(), raw.clone()));
        let line = Line { body, raw };
        match streams.iter_mut().find(|(dir, _)| *dir == cwd) {
            Some((_, lines)) => lines.push(line),
            None => streams.push((cwd, vec![line])),
        }
    }
    streams
}

fn join(cwd: &str, path: &str) -> String {
    if cwd == "." {
        path.to_owned()
    } else {
        format!("{cwd}/{path}")
    }
}

/// One stream's directory, which the paths in it are relative to.
pub(crate) struct StreamContext<'a> {
    root: &'a str,
    cwd: &'a str,
    source: &'a str,
}

/// A diagnostic as a tool reports it: one-based positions, the path as printed.
pub(crate) struct Located {
    pub path: String,
    pub line: u32,
    pub column: u32,
    pub end_line: Option<u32>,
    pub end_column: Option<u32>,
    pub severity: Severity,
    pub code: Option<String>,
    pub message: String,
}

impl StreamContext<'_> {
    /// The diagnostic, or None when its file is outside the repo.
    fn diagnostic(&self, located: Located) -> Option<Diagnostic> {
        let path = self.repo_path(&located.path)?;
        let position = |line: u32, column: u32| Position {
            line: line.saturating_sub(1),
            character: column.saturating_sub(1),
        };
        let start = position(located.line, located.column);
        let end = match located.end_line {
            Some(line) => position(line, located.end_column.unwrap_or(located.column)),
            None => start,
        };
        Some(Diagnostic {
            path,
            range: Range { start, end },
            severity: located.severity,
            code: located.code.filter(|code| !code.is_empty()),
            source: self.source.to_owned(),
            message: located.message,
        })
    }

    /// `path`, as the tool printed it from its directory, relative to the repo root.
    fn repo_path(&self, path: &str) -> Option<RelativePath> {
        let path = path.strip_prefix("file://").unwrap_or(path);
        let joined = if path.starts_with('/') {
            path.to_owned()
        } else if self.cwd == "." {
            format!("{}/{path}", self.root)
        } else {
            format!("{}/{}/{path}", self.root, self.cwd)
        };
        let mut names: Vec<&str> = Vec::new();
        for name in joined.split('/') {
            match name {
                "" | "." => {}
                ".." => {
                    names.pop()?;
                }
                name => names.push(name),
            }
        }
        let normalized = format!("/{}", names.join("/"));
        let relative = normalized.strip_prefix(self.root)?.strip_prefix('/')?;
        RelativePath::try_from(relative).ok()
    }
}

/// Collects diagnostics and leftover lines, each once, in the order they came.
#[derive(Default)]
pub(crate) struct Collector {
    diagnostics: Vec<Diagnostic>,
    seen: HashSet<Diagnostic>,
    output: Vec<String>,
    lines: HashSet<String>,
}

impl Collector {
    fn diagnostic(&mut self, diagnostic: Diagnostic) {
        if self.seen.insert(diagnostic.clone()) {
            self.diagnostics.push(diagnostic);
        }
    }

    fn raw(&mut self, text: &str) {
        for line in text.split('\n') {
            self.raw_line(line);
        }
    }

    /// Keeps one line as output; answers where it went, unless it was blank or there already.
    fn raw_line(&mut self, line: &str) -> Option<usize> {
        let trimmed = line.trim();
        if trimmed.is_empty() || !self.lines.insert(trimmed.to_owned()) {
            return None;
        }
        self.output.push(trimmed.to_owned());
        Some(self.output.len() - 1)
    }

    /// Takes back the output line at `at`, which a diagnostic turned out to read.
    fn claim(&mut self, at: usize) {
        if let Some(line) = self.output.get_mut(at) {
            self.lines.remove(line.as_str());
            line.clear();
        }
    }
}
