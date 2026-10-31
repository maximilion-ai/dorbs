//! The repo's own commands for the interface's parts: package.json scripts, Makefile targets,
//! justfile recipes and mise tasks named typecheck, lint, check or test.

use std::collections::BTreeMap;

use regex::Regex;

use crate::adapter::Role;
use crate::view::View;

/// What a repo command does for the interface.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Part {
    Check(Role),
    Test,
}

/// The names each part goes by, in the order they are tried.
const NAMES: [(Part, &[&str]); 4] = [
    (
        Part::Check(Role::Typecheck),
        &[
            "typecheck",
            "type-check",
            "check:type",
            "check:types",
            "check-types",
            "types:check",
            "tsc",
        ],
    ),
    (Part::Check(Role::Lint), &["lint"]),
    (Part::Check(Role::Check), &["check"]),
    (Part::Test, &["test"]),
];

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Source {
    PackageJson,
    Justfile,
    Mise,
    Makefile,
}

impl Source {
    /// The key an adapter's `commands` table names the source by.
    pub fn key(self) -> &'static str {
        match self {
            Source::PackageJson => "package.json",
            Source::Justfile => "justfile",
            Source::Mise => "mise.toml",
            Source::Makefile => "Makefile",
        }
    }

    /// How a command of this source runs where the host has the tool, as in a local checkout.
    pub fn local_runner(self) -> Option<&'static str> {
        match self {
            Source::PackageJson => None,
            Source::Justfile => Some("just {name}"),
            Source::Mise => Some("mise run {name}"),
            Source::Makefile => Some("make {name}"),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RepoCommand {
    pub part: Part,
    pub source: Source,
    /// The command's name in its source, such as check:type.
    pub name: String,
    /// What it runs, for adapters that ask whether it covers a check of theirs.
    pub body: String,
    /// Whether arguments after the command reach it, so a test run can pass files.
    pub takes_args: bool,
}

/// The repo's commands, at most one per part, from the sources in their order of precedence.
pub fn discover(view: &View) -> Vec<RepoCommand> {
    let mut found: Vec<RepoCommand> = Vec::new();
    let sources = [
        (Source::PackageJson, package_json(view)),
        (Source::Justfile, justfile(view)),
        (Source::Mise, mise(view)),
        (Source::Makefile, makefile(view)),
    ];
    for (part, names) in NAMES {
        let command = sources.iter().find_map(|(source, commands)| {
            names.iter().find_map(|name| {
                let (body, takes_args) = commands.get(*name)?;
                Some(RepoCommand {
                    part,
                    source: *source,
                    name: (*name).to_owned(),
                    body: body.clone(),
                    takes_args: *takes_args,
                })
            })
        });
        found.extend(command);
    }
    found
}

/// A source's commands by name: what each runs, and whether it takes arguments.
type Commands = BTreeMap<String, (String, bool)>;

fn package_json(view: &View) -> Commands {
    let Some(json) = view
        .read("package.json")
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
    else {
        return Commands::new();
    };
    (json["scripts"].as_object().into_iter().flatten())
        .filter_map(|(name, body)| Some((name.clone(), (body.as_str()?.to_owned(), true))))
        .collect()
}

fn makefile(view: &View) -> Commands {
    let Some(text) = ["GNUmakefile", "makefile", "Makefile"]
        .iter()
        .find_map(|name| view.read(name))
    else {
        return Commands::new();
    };
    let target = Regex::new(r"^([A-Za-z0-9][\w.-]*)\s*:(?:[^=]|$)").expect("a valid regex");
    recipes(
        text,
        |line| {
            target
                .captures(line)
                .map(|caps| (caps[1].to_owned(), false))
        },
        |line| line.starts_with('\t'),
    )
}

fn justfile(view: &View) -> Commands {
    let Some(text) = ["justfile", ".justfile"]
        .iter()
        .find_map(|name| view.read(name))
    else {
        return Commands::new();
    };
    let recipe =
        Regex::new(r"^@?([A-Za-z0-9][\w-]*)((?:\s+[^:=]*)?):(?:[^=]|$)").expect("a valid regex");
    recipes(
        text,
        |line| {
            recipe
                .captures(line)
                .map(|caps| (caps[1].to_owned(), caps[2].contains(['*', '+'])))
        },
        |line| line.starts_with([' ', '\t']),
    )
}

/// Commands whose header lines `header` reads, each with the indented lines under it as its body.
fn recipes(
    text: &str,
    header: impl Fn(&str) -> Option<(String, bool)>,
    indented: impl Fn(&str) -> bool,
) -> Commands {
    let mut commands = Commands::new();
    let mut current: Option<String> = None;
    for line in text.lines() {
        if let Some((name, takes_args)) = header(line) {
            commands
                .entry(name.clone())
                .or_insert((String::new(), takes_args));
            current = Some(name);
        } else if indented(line) && !line.trim().is_empty() {
            if let Some((body, _)) = current.as_ref().and_then(|name| commands.get_mut(name)) {
                body.push_str(line.trim());
                body.push('\n');
            }
        } else if !line.trim().is_empty() {
            current = None;
        }
    }
    commands
}

fn mise(view: &View) -> Commands {
    let Some(table) = ["mise.toml", ".mise.toml"]
        .iter()
        .find_map(|name| view.read(name))
        .and_then(|text| text.parse::<toml::Table>().ok())
    else {
        return Commands::new();
    };
    let run = |value: &toml::Value| -> Option<String> {
        match value {
            toml::Value::String(run) => Some(run.clone()),
            toml::Value::Array(runs) => Some(
                runs.iter()
                    .filter_map(|r| r.as_str())
                    .collect::<Vec<_>>()
                    .join("\n"),
            ),
            toml::Value::Table(task) => task.get("run").and_then(|run| match run {
                toml::Value::String(run) => Some(run.clone()),
                toml::Value::Array(runs) => Some(
                    runs.iter()
                        .filter_map(|r| r.as_str())
                        .collect::<Vec<_>>()
                        .join("\n"),
                ),
                _ => None,
            }),
            _ => None,
        }
    };
    (table
        .get("tasks")
        .and_then(|tasks| tasks.as_table())
        .into_iter()
        .flatten())
    .filter_map(|(name, task)| Some((name.clone(), (run(task)?, false))))
    .collect()
}
