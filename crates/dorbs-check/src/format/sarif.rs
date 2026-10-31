//! SARIF 2.1: each result of each run, at its first location.

use serde_json::Value;

use super::{Collector, Located, StreamContext};
use crate::protocol::Severity;

pub(super) fn parse(context: &StreamContext, text: &str, into: &mut Collector) {
    // Some tools print a line or two before the document.
    let start = text.find(['{', '[']).unwrap_or(text.len());
    let Ok(document) = serde_json::from_str::<Value>(&text[start..]) else {
        into.raw(text);
        return;
    };
    into.raw(&text[..start]);
    for run in document["runs"].as_array().into_iter().flatten() {
        let bases = &run["originalUriBaseIds"];
        for result in run["results"].as_array().into_iter().flatten() {
            let message = result["message"]["text"]
                .as_str()
                .unwrap_or_default()
                .to_owned();
            let code = result["ruleId"].as_str().map(str::to_owned);
            let location = &result["locations"][0]["physicalLocation"];
            let artifact = &location["artifactLocation"];
            let Some(uri) = artifact["uri"].as_str() else {
                into.raw(&format!(
                    "{}: {message}",
                    code.as_deref().unwrap_or("sarif")
                ));
                continue;
            };
            let base = artifact["uriBaseId"]
                .as_str()
                .and_then(|id| bases[id]["uri"].as_str());
            let region = &location["region"];
            let number = |value: &Value| value.as_u64().map(|n| n as u32);
            let found = context.diagnostic(Located {
                path: decode(&format!("{}{uri}", base.unwrap_or_default())),
                line: number(&region["startLine"]).unwrap_or(1),
                column: number(&region["startColumn"]).unwrap_or(1),
                end_line: number(&region["endLine"]),
                end_column: number(&region["endColumn"]),
                // A result without a level is a warning, as SARIF has it.
                severity: match result["level"].as_str() {
                    Some("error") => Severity::Error,
                    Some("note") => Severity::Information,
                    Some("none") => Severity::Hint,
                    _ => Severity::Warning,
                },
                code,
                message: message.clone(),
            });
            match found {
                Some(diagnostic) => into.diagnostic(diagnostic),
                None => into.raw(&format!("{uri}: {message}")),
            }
        }
    }
}

/// A file URI's path, its %XX escapes decoded.
fn decode(uri: &str) -> String {
    let path = uri.strip_prefix("file://").unwrap_or(uri);
    let bytes = path.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = |b: u8| (b as char).to_digit(16);
        if bytes[i] == b'%'
            && i + 2 < bytes.len()
            && let (Some(hi), Some(lo)) = (hex(bytes[i + 1]), hex(bytes[i + 2]))
        {
            out.push((hi * 16 + lo) as u8);
            i += 3;
            continue;
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}
