//! TAP 14: each test point that is no subtest's parent, by its ok or not ok and its directive.

use regex::Regex;

use super::Counts;

pub(super) fn counts(text: &str) -> Option<Counts> {
    let point = Regex::new(r"^(\s*)(not )?ok\b[^#]*(?:#\s*(\w+))?").expect("a valid regex");
    let mut counts = Counts::default();
    let mut found = false;
    let mut last_indent: Option<usize> = None;
    for line in text.lines() {
        let Some(caps) = point.captures(line) else {
            continue;
        };
        let indent = caps[1].len();
        // A subtest's children come before it, further in.
        let parent = last_indent.is_some_and(|last| last > indent);
        last_indent = Some(indent);
        if parent {
            continue;
        }
        found = true;
        let directive = caps.get(3).map(|m| m.as_str().to_ascii_lowercase());
        match (caps.get(2).is_some(), directive.as_deref()) {
            (_, Some("skip" | "todo")) => counts.skipped += 1,
            (true, _) => counts.failed += 1,
            (false, _) => counts.passed += 1,
        }
    }
    found.then_some(counts)
}
