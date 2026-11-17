use scribyra_sync::{config::Config, migrate_sqlite, service, store::Store};
use std::{path::PathBuf, process::ExitCode};

const USAGE: &str = "usage: scribyra-sync [serve] | verify | migrate-sqlite <old-data-dir> | org create --label <label>";

enum Command {
    Serve,
    Verify,
    MigrateSqlite(PathBuf),
    OrgCreate(String),
}
fn parse(args: &[String]) -> Option<Command> {
    match args {
        [] => Some(Command::Serve),
        [cmd] if cmd == "serve" => Some(Command::Serve),
        [cmd] if cmd == "verify" => Some(Command::Verify),
        [cmd, dir] if cmd == "migrate-sqlite" => Some(Command::MigrateSqlite(dir.into())),
        [cmd, sub, flag, label] if cmd == "org" && sub == "create" && flag == "--label" => Some(Command::OrgCreate(label.clone())),
        _ => None,
    }
}
async fn run(command: Command) -> Result<ExitCode, scribyra_sync::store::Error> {
    let config = Config::load().map_err(|e| e.to_string())?;
    if let Command::OrgCreate(label) = &command {
        // The setup code is printed once, to stdout only; the service keeps only its public key.
        let (org, setup) = scribyra_sync::org::create_org(&config, label).await?;
        println!("{}", serde_json::json!({"event": "org_created", "org": org, "setup": setup}));
        return Ok(ExitCode::SUCCESS);
    }
    let store = Store::open(config).await?;
    match command {
        Command::Serve => service::serve(store).await.map(|()| ExitCode::SUCCESS),
        Command::Verify => {
            let report = store.verify().await?;
            println!(
                "{{\"event\":\"verify\",\"objects\":{},\"missing\":{},\"corrupt\":{},\"usage_mismatch\":{}}}",
                report.objects, report.missing, report.corrupt, report.usage_mismatch
            );
            Ok(if report.ok() {
                ExitCode::SUCCESS
            } else {
                ExitCode::FAILURE
            })
        }
        Command::OrgCreate(_) => unreachable!(),
        Command::MigrateSqlite(dir) => {
            let report = migrate_sqlite::migrate_sqlite(&store, &dir).await?;
            println!(
                "{{\"event\":\"migrate_sqlite\",\"objects\":{},\"imported\":{},\"existing\":{}}}",
                report.objects, report.imported, report.existing
            );
            Ok(ExitCode::SUCCESS)
        }
    }
}
#[tokio::main]
async fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let Some(command) = parse(&args) else {
        eprintln!("{USAGE}");
        return ExitCode::from(2);
    };
    match run(command).await {
        Ok(code) => code,
        Err(_) => {
            // Configuration, database and storage errors can contain private paths or values.
            eprintln!("{{\"event\":\"startup_or_runtime_failure\"}}");
            ExitCode::FAILURE
        }
    }
}
