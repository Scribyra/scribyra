//! Experimental agent payloads; grants and revisions remain in the v2 dispatcher.
use crate::collaboration_commands::{Error, error};
use serde::Deserialize;
use serde_json::{Value, json};

pub const SOURCE_UNITS: usize = 8192;
pub const SOURCE_LINES: u32 = 200;
pub const PATCH_EDITS: usize = 20;

pub fn limits() -> Value {
    json!({"sourceUnits":SOURCE_UNITS,"sourceLines":SOURCE_LINES,"patchEdits":PATCH_EDITS,
        "patchBytes":131072,"treeDefault":50,"treeMax":100,"diagnosticsDefault":10,
        "diagnosticsMax":20,"summaryUnits":512,"detailUnits":1024,"retainedBuilds":8,
        "pollWaitMs":25000,"pendingPolls":32,"jobPendingPolls":16,"receiptBytes":65536,"treeBytes":16384,"replayReceipts":128})
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Cursor {
    revision: String,
    offset: usize,
}
#[derive(Deserialize)]
#[serde(untagged)]
enum Edit {
    Range(Range),
    Find(Find),
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Find {
    file_id: Option<String>,
    path: Option<String>,
    find: String,
    replace: String,
}
#[derive(Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Range {
    file_id: Option<String>,
    path: Option<String>,
    start: u32,
    end: u32,
    before: String,
    after: String,
}
#[derive(Deserialize)]
#[serde(tag = "op", deny_unknown_fields)]
enum Command {
    #[serde(rename = "agent.status")]
    Status {},
    #[serde(rename = "agent.tree")]
    Tree {
        path: Option<String>,
        cursor: Option<Cursor>,
        limit: Option<usize>,
    },
    #[serde(rename = "agent.readSource")]
    Read {
        #[serde(rename = "fileId")]
        file_id: Option<String>,
        path: Option<String>,
        #[serde(rename = "startLine")]
        start_line: Option<u32>,
        #[serde(rename = "endLine")]
        end_line: Option<u32>,
        offset: Option<usize>,
    },
    #[serde(rename = "agent.patchSource")]
    Patch { edits: Vec<Edit> },
    #[serde(rename = "agent.compile")]
    Compile {},
    #[serde(rename = "agent.poll")]
    Poll {
        #[serde(rename = "jobId")]
        job_id: String,
        #[serde(rename = "waitMs")]
        wait_ms: Option<u32>,
    },
    #[serde(rename = "agent.diagnostics")]
    Diagnostics {
        #[serde(rename = "jobId")]
        job_id: String,
        offset: Option<usize>,
        limit: Option<usize>,
        detail: Option<bool>,
    },
    #[serde(rename = "agent.cancel")]
    Cancel {
        #[serde(rename = "jobId")]
        job_id: String,
    },
    #[serde(rename = "agent.exportPdf")]
    Export {},
}
pub fn validate(value: &Value) -> Result<(), Error> {
    let invalid = || error("invalid_request", "Invalid or oversized agent payload.");
    let id = |s: &str| !s.is_empty() && s.len() <= 256 && !s.chars().any(char::is_control);
    let target = |file_id: &Option<String>, path: &Option<String>| match (file_id, path) {
        (Some(file_id), None) => id(file_id),
        (None, Some(path)) => crate::valid_path(path),
        _ => false,
    };
    let command: Command = serde_json::from_value(value.clone()).map_err(|_| invalid())?;
    let valid = match command {
        Command::Status {} | Command::Compile {} | Command::Export {} => true,
        Command::Tree {
            path,
            cursor,
            limit,
        } => {
            path.as_ref().is_none_or(|p| crate::valid_path(p))
                && (path.is_none() || cursor.is_none())
                && limit.is_none_or(|n| (1..=100).contains(&n))
                && cursor.is_none_or(|c| id(&c.revision) && c.offset <= 1024)
        }
        Command::Read {
            file_id,
            path,
            start_line,
            end_line,
            offset,
        } => {
            let start = start_line.unwrap_or(1);
            let end = end_line.unwrap_or(start.saturating_add(49));
            target(&file_id, &path)
                && start > 0
                && end >= start
                && end - start < SOURCE_LINES
                && offset.is_none_or(|n| n <= 64 * 1024 * 1024)
        }
        Command::Patch { edits } => {
            !edits.is_empty()
                && edits.len() <= PATCH_EDITS
                && serde_json::to_vec(value).is_ok_and(|v| v.len() <= 131072)
                && edits.iter().all(|e| match e {
                    Edit::Range(e) => {
                        let _ = (&e.start, &e.end, &e.before, &e.after);
                        target(&e.file_id, &e.path)
                    }
                    Edit::Find(e) => {
                        target(&e.file_id, &e.path)
                            && !e.find.is_empty()
                            && e.find.len() + e.replace.len() <= 131072
                    }
                })
        }
        Command::Poll { job_id, wait_ms } => id(&job_id) && wait_ms.is_none_or(|n| n <= 25000),
        Command::Cancel { job_id } => id(&job_id),
        Command::Diagnostics {
            job_id,
            offset,
            limit,
            detail,
        } => {
            let _ = detail;
            id(&job_id)
                && offset.is_none_or(|n| n <= 100)
                && limit.is_none_or(|n| (1..=20).contains(&n))
        }
    };
    if valid { Ok(()) } else { Err(invalid()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn closed_payloads_and_bounds() {
        for value in [
            json!({"op":"agent.status","grant":"edit"}),
            json!({"op":"agent.readSource","fileId":"a","startLine":0}),
            json!({"op":"agent.readSource","fileId":"a","endLine":201}),
            json!({"op":"agent.diagnostics","jobId":"a","limit":21}),
            json!({"op":"agent.patchSource","edits":[{"fileId":"a","find":"","replace":"x"}]}),
        ] {
            assert_eq!(validate(&value).unwrap_err().code, "invalid_request");
        }
        assert!(
            validate(&json!({"op":"agent.readSource","fileId":"a","startLine":400,"endLine":599}))
                .is_ok()
        );
        assert!(
            validate(
                &json!({"op":"agent.patchSource","edits":[{"fileId":"a","find":"x","replace":"y"}]})
            )
            .is_ok()
        );
    }
}
