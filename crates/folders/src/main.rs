use scribyra_folders::transaction::{Owner, Preview, RecoveryVersion, Session};
use scribyra_folders::{MAX_BYTES, Root, parse_plan};
use scribyra_folders::{Resolution, Snapshot};
use serde::Deserialize;
use std::collections::BTreeMap;
use std::{
    io::{self, Read},
    process::ExitCode,
};
const CLI_LIMIT: usize = 8 * MAX_BYTES + 8 * 1024 * 1024;
fn input<T: serde::de::DeserializeOwned>() -> Result<T, Box<dyn std::error::Error>> {
    let mut bytes = Vec::new();
    io::stdin()
        .take(CLI_LIMIT as u64 + 1)
        .read_to_end(&mut bytes)?;
    if bytes.len() > CLI_LIMIT {
        return Err("Folder input exceeds its bound.".into());
    }
    Ok(serde_json::from_slice(&bytes)?)
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Local {
    local: Snapshot,
    #[serde(default)]
    resolutions: Vec<Resolution>,
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Prepare {
    request: scribyra_folders::Request,
    review: scribyra_folders::Plan,
    #[serde(default)]
    objects: BTreeMap<String, Vec<u8>>,
}
fn open(args: &[String], create: bool) -> Result<Session, Box<dyn std::error::Error>> {
    let owner = Owner {
        project_id: args[2].clone(),
        scope: "local-cli".into(),
    };
    let root = Root::open(&args[1])?;
    Ok(if create {
        Session::connect(root, owner)?
    } else {
        Session::open(root, owner)?
    })
}
fn run() -> Result<(), Box<dyn std::error::Error>> {
    let args = std::env::args().skip(1).collect::<Vec<_>>();
    match args.first().map(String::as_str) {
        Some("inspect") | Some("snapshot") if args.len() == 2 => {
            let scan = Root::open(&args[1])?.scan(None)?;
            if args[0] == "snapshot" {
                println!("{}", serde_json::to_string(&scan.snapshot)?);
            } else {
                let entries=scan.snapshot.entries.iter().map(|e|serde_json::json!({"path":e.path,"kind":match e.data{scribyra_folders::Data::Folder{}=>"folder",scribyra_folders::Data::Text{..}=>"text",_=>"binary"},"size":e.data.size(),"digest":e.data.digest()})).collect::<Vec<_>>();
                println!(
                    "{}",
                    serde_json::json!({"version":1,"revision":scan.revision(),"entries":entries})
                );
            }
        }
        Some("verify") if args.len() == 3 => {
            let scan = Root::open(&args[1])?.verify(&args[2], None)?;
            println!(
                "{}",
                serde_json::json!({"verified":true,"revision":scan.revision()})
            );
        }
        Some("plan") if args.len() == 1 => {
            let mut input = String::new();
            io::stdin()
                .take((3 * MAX_BYTES + 1024 * 1024 + 1) as u64)
                .read_to_string(&mut input)?;
            let plan = parse_plan(&input)?;
            println!("{}", serde_json::to_string(&plan)?);
        }
        Some("connect") | Some("status") if args.len() == 3 => {
            let session = open(&args, args[0] == "connect")?;
            let state = session.state()?;
            let pending = state.pending.as_ref().map(|p| serde_json::json!({
                "id": p.id, "phase": p.phase, "inputHash": p.review.input_hash,
                "resultHash": p.review.result.as_ref().map(|s| s.digest())
            }));
            println!("{}", serde_json::json!({
                "version": state.version, "owner": state.owner, "baseline": state.baseline,
                "lastConfirmed": state.last_confirmed, "pending": pending
            }));
        }
        Some("preview") if args.len() == 3 => {
            let local: Local = input()?;
            let preview = open(&args, false)?.preview(local.local, local.resolutions)?;
            println!("{}", serde_json::to_string(&preview)?);
        }
        Some("prepare") if args.len() == 3 => {
            let body: Prepare = input()?;
            let preview = Preview { request: body.request, review: body.review };
            let pending = open(&args, false)?.prepare(&preview, &body.objects)?;
            println!("{}", serde_json::json!({
                "id": pending.id, "phase": pending.phase,
                "resultHash": pending.review.result.as_ref().map(|s| s.digest())
            }));
        }
        Some("apply") if args.len() == 4 => {
            let receipt = open(&args, false)?.apply(&args[3])?;
            println!("{}", serde_json::to_string(&receipt)?);
        }
        Some("confirm") if args.len() == 5 => {
            let receipt = open(&args, false)?.confirm(&args[3], &args[4])?;
            println!("{}", serde_json::to_string(&receipt)?);
        }
        Some("abandon") if args.len() == 4 => {
            open(&args, false)?.abandon(&args[3])?;
            println!("{}", serde_json::json!({
                "abandoned": true, "id": args[3], "recoveryRetained": true
            }));
        }
        Some("recoveries") if args.len() == 3 => {
            println!("{}", serde_json::to_string(&open(&args, false)?.recoveries()?)?);
        }
        Some("recovery") if args.len() == 5 => {
            let version: RecoveryVersion = serde_json::from_value(serde_json::Value::String(args[4].clone()))?;
            let scan = open(&args, false)?.recovery(&args[3], version)?;
            println!("{}", serde_json::json!({ "snapshot": scan.snapshot, "objects": scan.objects }));
        }
        Some("object") if args.len() == 5 => {
            let bytes = open(&args, false)?.retained_object(&args[3], args[4].parse()?)?;
            use std::io::Write;
            io::stdout().write_all(&bytes)?;
        }
        Some("--help") => println!(
            "scribyra-folders inspect ROOT\nscribyra-folders snapshot ROOT\nscribyra-folders verify ROOT REVISION\nscribyra-folders plan < request.json\n\nExplicit folder session (local-cli scope):\nscribyra-folders connect ROOT PROJECT\nscribyra-folders status ROOT PROJECT\nscribyra-folders preview ROOT PROJECT < local.json\nscribyra-folders prepare ROOT PROJECT < reviewed.json\nscribyra-folders apply ROOT PROJECT TRANSACTION\nscribyra-folders confirm ROOT PROJECT TRANSACTION RESULT_HASH\nscribyra-folders abandon ROOT PROJECT TRANSACTION\nscribyra-folders recoveries ROOT PROJECT\nscribyra-folders recovery ROOT PROJECT TRANSACTION base|local|disk|result|claimed\nscribyra-folders object ROOT PROJECT SHA256 SIZE\n\nconnect/prepare/apply/confirm/abandon modify the explicitly selected folder. Other session commands require an existing binding. Outputs except inspect can contain private source or binary bytes. apply changes disk; confirm is a separate acknowledgement after saving the matching project. abandon keeps current disk contents, including any partial transaction, and all recovery records."
        ),
        _ => return Err("Use --help. Folder inspection/plan are read-only; session mutations require explicit commands.".into()),
    }
    Ok(())
}
fn main() -> ExitCode {
    let diagnostics =
        scribyra_core::telemetry::native::initialize(scribyra_core::telemetry::Runtime::Native);
    let mut observation =
        diagnostics.begin(scribyra_core::telemetry::Operation::NativeSession, None);
    let result = match run() {
        Ok(()) => {
            observation.success();
            ExitCode::SUCCESS
        }
        Err(error) => {
            if let Some(io) = error.downcast_ref::<io::Error>() {
                observation.io_error(io);
            } else {
                observation.error("invalid_request");
            }
            eprintln!("{error}");
            ExitCode::FAILURE
        }
    };
    if !diagnostics.flush(std::time::Duration::from_secs(1)) {
        eprintln!("Diagnostic export is incomplete.");
    }
    result
}
