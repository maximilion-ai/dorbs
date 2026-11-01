//! Vim's errorformat: patterns that read a tool's lines as diagnostics, as `:help errorformat` and
//! reviewdog describe them. Each pattern matches a whole line. Supported codes:
//!
//! - `%f` file, `%l` line, `%c` column, `%e` end line, `%k` end column, `%t` type character
//!   (e error, w warning, i or n information, h hint), `%m` message, `%n` code. `%n` reads a code
//!   such as TS2322, no-unused-vars or E0308, not only a number as in vim.
//! - `%%`, `%.`, `%#`, `%^`, `%$`, `%[...]`, `%*{atom}` and `%\` as vim has them, and vim's
//!   backslash atoms: `\s \d \w \S \D \W`, `\(...\)`, `\|`, `\=`, `\?`, `\+`, `\{-}`, `\{n,m}`, `\,`.
//!   Every other character is literal.
//! - Prefixes: `%E %W %I %N %A` start a multi-line message, `%C` continues and `%Z` ends it (`%+C`
//!   adds the whole line, `%-C` nothing), `%P` sets the file of the lines that follow, `%Q` clears it,
//!   `%D` sets the directory relative paths in the lines that follow are under (none without `%f`),
//!   `%X` clears it.
//!
//! A line that ends up in no diagnostic is kept as output.

use regex::{Captures, Regex};

use super::{Collector, Located, StreamContext};
use crate::protocol::Severity;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Kind {
    Single,
    Start(Option<Severity>),
    Continue,
    End,
    PushFile,
    PopFile,
    EnterDir,
    LeaveDir,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Text {
    /// The message is `%m`.
    Message,
    /// The message gets the whole line.
    Line,
    /// The line adds nothing to the message.
    Nothing,
}

#[derive(Debug)]
struct Entry {
    kind: Kind,
    text: Text,
    regex: Regex,
}

/// Compiled patterns, tried in order on each line.
#[derive(Debug)]
pub struct Errorformat {
    entries: Vec<Entry>,
}

impl Errorformat {
    pub fn new(patterns: &[String]) -> Result<Self, String> {
        let entries = patterns
            .iter()
            .map(|pattern| compile(pattern).map_err(|e| format!("errorformat {pattern:?}: {e}")))
            .collect::<Result<_, _>>()?;
        Ok(Self { entries })
    }

    pub(super) fn parse(&self, context: &StreamContext, lines: &[Line], into: &mut Collector) {
        let mut state = State::default();
        for line in lines {
            if let Some(open) = state.open.as_mut() {
                let continued = self.entries.iter().find_map(|entry| {
                    matches!(entry.kind, Kind::Continue | Kind::End)
                        .then(|| entry.regex.captures(&line.body).map(|caps| (entry, caps)))
                        .flatten()
                });
                if let Some((entry, caps)) = continued {
                    open.extend(entry.text, &caps, &line.body);
                    open.raw.push(line.raw.clone());
                    if entry.kind == Kind::End {
                        state.close(context, into);
                    }
                    continue;
                }
                state.close(context, into);
            }
            let started = self.entries.iter().find_map(|entry| {
                (!matches!(entry.kind, Kind::Continue | Kind::End))
                    .then(|| entry.regex.captures(&line.body).map(|caps| (entry, caps)))
                    .flatten()
            });
            let Some((entry, caps)) = started else {
                into.raw(&line.raw);
                continue;
            };
            match entry.kind {
                Kind::Single => {
                    state.open = Some(Pending::new(None, &caps, line));
                    state.close(context, into);
                }
                Kind::Start(severity) => {
                    state.open = Some(Pending::new(severity, &caps, line));
                }
                Kind::PushFile => {
                    // Output until a diagnostic uses the file, so the line keeps its place.
                    let at = into.raw_line(&line.raw);
                    state.file = caps.name("f").map(|f| (f.as_str().to_owned(), at));
                }
                Kind::PopFile => {
                    state.file = None;
                    into.raw(&line.raw);
                }
                Kind::EnterDir => {
                    state.dir = caps.name("f").map(|f| f.as_str().to_owned());
                    into.raw(&line.raw);
                }
                Kind::LeaveDir => {
                    state.dir = None;
                    into.raw(&line.raw);
                }
                Kind::Continue | Kind::End => unreachable!("continuations are tried above"),
            }
        }
        state.close(context, into);
    }
}

/// A line of a tool's output: as printed, and without the package prefix it may carry.
#[derive(Debug, Clone)]
pub(super) struct Line {
    pub body: String,
    pub raw: String,
}

#[derive(Default)]
struct State {
    open: Option<Pending>,
    /// The file `%P` set, and where its line is in the output until a diagnostic uses it.
    file: Option<(String, Option<usize>)>,
    /// The directory `%D` set.
    dir: Option<String>,
}

impl State {
    fn close(&mut self, context: &StreamContext, into: &mut Collector) {
        let Some(pending) = self.open.take() else {
            return;
        };
        let path = pending
            .path
            .clone()
            .or_else(|| self.file.as_ref().map(|f| f.0.clone()))
            .map(|path| match &self.dir {
                Some(dir) if !path.starts_with('/') => format!("{dir}/{path}"),
                _ => path,
            });
        // A pattern without %m, such as prettier's [warn] %f, says it all in its line.
        let message = (pending.message.as_deref())
            .map(str::trim_end)
            .filter(|m| !m.is_empty())
            .unwrap_or(&pending.first)
            .to_owned();
        let found = match path {
            Some(path) => context.diagnostic(Located {
                path,
                line: pending.line.unwrap_or(1),
                column: pending.column.unwrap_or(1),
                end_line: pending.end_line,
                end_column: pending.end_column,
                severity: pending.severity.unwrap_or(Severity::Error),
                code: pending.code.clone(),
                message,
            }),
            _ => None,
        };
        match found {
            Some(diagnostic) => {
                if pending.path.is_none()
                    && let Some(at) = self.file.as_mut().and_then(|file| file.1.take())
                {
                    into.claim(at);
                }
                into.diagnostic(diagnostic);
            }
            None => pending.raw.iter().for_each(|raw| into.raw(raw)),
        }
    }
}

/// A diagnostic while its lines are read.
struct Pending {
    path: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    end_line: Option<u32>,
    end_column: Option<u32>,
    severity: Option<Severity>,
    code: Option<String>,
    message: Option<String>,
    /// The first line without its package prefix.
    first: String,
    raw: Vec<String>,
}

impl Pending {
    fn new(severity: Option<Severity>, caps: &Captures, line: &Line) -> Self {
        let mut pending = Self {
            path: None,
            line: None,
            column: None,
            end_line: None,
            end_column: None,
            severity,
            code: None,
            message: None,
            first: line.body.clone(),
            raw: vec![line.raw.clone()],
        };
        pending.take(caps);
        pending.message = caps.name("m").map(|m| m.as_str().to_owned());
        pending
    }

    /// Takes the fields a line names that the diagnostic does not have yet.
    fn take(&mut self, caps: &Captures) {
        let number = |name: &str| caps.name(name).and_then(|m| m.as_str().parse::<u32>().ok());
        if self.path.is_none() {
            self.path = caps.name("f").map(|m| m.as_str().to_owned());
        }
        self.line = self.line.or(number("l"));
        self.column = self.column.or(number("c"));
        self.end_line = self.end_line.or(number("e"));
        self.end_column = self.end_column.or(number("k"));
        if self.code.is_none() {
            self.code = caps.name("n").map(|m| m.as_str().to_owned());
        }
        if let Some(t) = caps.name("t").and_then(|m| severity_of(m.as_str())) {
            self.severity = Some(t);
        }
    }

    fn extend(&mut self, text: Text, caps: &Captures, line: &str) {
        self.take(caps);
        let added = match text {
            Text::Message => caps.name("m").map(|m| m.as_str()),
            Text::Line => Some(line),
            Text::Nothing => None,
        };
        if let Some(added) = added {
            self.message = Some(match self.message.take() {
                Some(message) if !message.is_empty() => format!("{message}\n{added}"),
                _ => added.to_owned(),
            });
        }
    }
}

fn severity_of(t: &str) -> Option<Severity> {
    match t.to_ascii_lowercase().as_str() {
        "e" => Some(Severity::Error),
        "w" => Some(Severity::Warning),
        "i" | "n" => Some(Severity::Information),
        "h" => Some(Severity::Hint),
        _ => None,
    }
}

fn compile(pattern: &str) -> Result<Entry, String> {
    let mut chars: Vec<char> = pattern.chars().collect();
    let (kind, text, skip) = prefix(&chars)?;
    chars.drain(..skip);
    let mut regex = String::from("^");
    let mut i = 0;
    while i < chars.len() {
        let c = chars[i];
        i += 1;
        match c {
            '%' => {
                let code = *chars.get(i).ok_or("ends in %")?;
                i += 1;
                match code {
                    'f' => regex.push_str(r"(?P<f>(?:\\ |[^ ])+?)"),
                    'l' | 'c' | 'e' | 'k' => regex.push_str(&format!(r"(?P<{code}>\d+)")),
                    // A rule such as eslint(no-debugger), as oxlint names it.
                    'n' => regex.push_str(r"(?P<n>[\w./@()-]+)"),
                    't' => regex.push_str(r"(?P<t>.)"),
                    'm' => regex.push_str(r"(?P<m>.+)"),
                    '%' => regex.push('%'),
                    '.' => regex.push('.'),
                    '#' => regex.push('*'),
                    '^' => regex.push('^'),
                    '$' => regex.push('$'),
                    '[' => i = class(&chars, i, &mut regex)?,
                    '\\' => i = backslash(&chars, i, &mut regex)?,
                    '*' => {
                        let mut atom = String::new();
                        i = match chars.get(i) {
                            Some('[') => class(&chars, i + 1, &mut atom)?,
                            Some('\\') => backslash(&chars, i + 1, &mut atom)?,
                            Some(c) => {
                                atom.push_str(&regex::escape(&c.to_string()));
                                i + 1
                            }
                            None => return Err("ends in %*".into()),
                        };
                        regex.push_str(&format!("(?:{atom})*"));
                    }
                    other => return Err(format!("%{other} is not supported")),
                }
            }
            '\\' => i = backslash(&chars, i, &mut regex)?,
            c => regex.push_str(&regex::escape(&c.to_string())),
        }
    }
    regex.push('$');
    let regex = Regex::new(&regex).map_err(|e| e.to_string())?;
    Ok(Entry { kind, text, regex })
}

/// The pattern's kind, how its line adds to the message, and how many characters the prefix takes.
fn prefix(chars: &[char]) -> Result<(Kind, Text, usize), String> {
    if chars.first() != Some(&'%') {
        return Ok((Kind::Single, Text::Message, 0));
    }
    let (text, at) = match chars.get(1) {
        Some('+') => (Some(Text::Line), 2),
        Some('-') => (Some(Text::Nothing), 2),
        _ => (None, 1),
    };
    let kind = match chars.get(at) {
        Some('E') => Kind::Start(Some(Severity::Error)),
        Some('W') => Kind::Start(Some(Severity::Warning)),
        Some('I') => Kind::Start(Some(Severity::Information)),
        Some('N') => Kind::Start(Some(Severity::Information)),
        Some('A') => Kind::Start(None),
        Some('C') => Kind::Continue,
        Some('Z') => Kind::End,
        Some('P') => Kind::PushFile,
        Some('Q') => Kind::PopFile,
        Some('D') => Kind::EnterDir,
        Some('X') => Kind::LeaveDir,
        Some(c @ ('G' | 'O' | '>' | 'r' | 's' | 'p' | 'v')) => {
            return Err(format!("%{c} is not supported"));
        }
        _ if text.is_some() => return Err("a + or - prefix names no kind".into()),
        _ => return Ok((Kind::Single, Text::Message, 0)),
    };
    Ok((kind, text.unwrap_or(Text::Message), at + 1))
}

/// Copies a `[...]` class whose `[` came before `at`; answers the index after its `]`.
fn class(chars: &[char], at: usize, out: &mut String) -> Result<usize, String> {
    out.push('[');
    let mut i = at;
    if chars.get(i) == Some(&'^') {
        out.push('^');
        i += 1;
    }
    let mut first = true;
    while let Some(&c) = chars.get(i) {
        i += 1;
        if c == ']' && !first {
            out.push(']');
            return Ok(i);
        }
        first = false;
        match c {
            '\\' => {
                let next = *chars.get(i).ok_or("ends in \\")?;
                i += 1;
                out.push('\\');
                out.push(next);
            }
            '[' | '&' | '~' => {
                out.push('\\');
                out.push(c);
            }
            c => out.push(c),
        }
    }
    Err("a [ class has no ]".into())
}

/// Translates the vim atom after a backslash at `at`; answers the index after it.
fn backslash(chars: &[char], at: usize, out: &mut String) -> Result<usize, String> {
    let c = *chars.get(at).ok_or("ends in \\")?;
    let mut i = at + 1;
    match c {
        's' | 'd' | 'w' | 'S' | 'D' | 'W' => {
            out.push('\\');
            out.push(c);
        }
        '(' => out.push_str("(?:"),
        ')' => out.push(')'),
        '|' => out.push('|'),
        '=' | '?' => out.push('?'),
        '+' => out.push('+'),
        '{' => {
            let close = chars[i..]
                .iter()
                .position(|&c| c == '}')
                .ok_or("a \\{ has no }")?;
            let inner: String = chars[i..i + close].iter().collect();
            i += close + 1;
            match inner.as_str() {
                "-" => out.push_str("*?"),
                _ if inner.chars().all(|c| c.is_ascii_digit() || c == ',') => {
                    out.push_str(&format!("{{{inner}}}"));
                }
                _ => return Err(format!("\\{{{inner}}} is not supported")),
            }
        }
        c => out.push_str(&regex::escape(&c.to_string())),
    }
    Ok(i)
}
