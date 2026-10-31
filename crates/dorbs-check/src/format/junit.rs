//! JUnit XML: a testcase passed unless it holds a failure, an error or a skipped element.

use quick_xml::Reader;
use quick_xml::events::Event;

use super::Counts;

pub(super) fn counts(xml: &str) -> Option<Counts> {
    let start = xml.find('<')?;
    let mut reader = Reader::from_str(&xml[start..]);
    let mut counts = Counts::default();
    let mut found = false;
    // The verdict of the testcase being read: None while it has no failure or skip.
    let mut case: Option<Option<bool>> = None;
    loop {
        match reader.read_event().ok()? {
            Event::Start(element) if element.name().as_ref() == "testcase" => case = Some(None),
            Event::Empty(element) if element.name().as_ref() == "testcase" => {
                found = true;
                counts.passed += 1;
            }
            Event::Start(element) | Event::Empty(element) if case.is_some() => {
                match element.name().as_ref() {
                    "failure" | "error" => case = Some(Some(true)),
                    "skipped" if case != Some(Some(true)) => case = Some(Some(false)),
                    _ => {}
                }
            }
            Event::End(element) if element.name().as_ref() == "testcase" => {
                found = true;
                match case.take().flatten() {
                    Some(true) => counts.failed += 1,
                    Some(false) => counts.skipped += 1,
                    None => counts.passed += 1,
                }
            }
            Event::Eof => break,
            _ => {}
        }
    }
    found.then_some(counts)
}
