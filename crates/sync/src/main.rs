use scribyra_sync::{config::Config, migrate_sqlite, service, store::Store};
use std::{path::PathBuf, process::ExitCode};

const USAGE: &str = "usage: scribyra-sync [serve] | migrate | compile-worker | verify | migrate-sqlite <old-data-dir>";

enum Command {
    Serve,
    Migrate,
    CompileWorker,
    Verify,
    MigrateSqlite(PathBuf),
}
fn parse(args: &[String]) -> Option<Command> {
    match args {
        [] => Some(Command::Serve),
        [cmd] if cmd == "serve" => Some(Command::Serve),
        [cmd] if cmd == scribyra_sync::deploy::COMMAND_MIGRATE => Some(Command::Migrate),
        [cmd] if cmd == scribyra_sync::deploy::COMMAND_COMPILE_WORKER => Some(Command::CompileWorker),
        [cmd] if cmd == "verify" => Some(Command::Verify),
        [cmd, dir] if cmd == "migrate-sqlite" => Some(Command::MigrateSqlite(dir.into())),
        _ => None,
    }
}
async fn run(command: Command) -> Result<ExitCode, scribyra_sync::store::Error> {
    let config = match Config::load() {
        Ok(config) => config,
        Err(e) => {
            let text = e.to_string();
            // Only the service's own validation messages are printed: they name a field and
            // never contain a value. Parse errors can quote values (secrets), so they are not.
            if let Some(reason) = text.strip_prefix(scribyra_sync::config::INVALID) {
                eprintln!("{}", serde_json::json!({"event": "invalid_configuration", "reason": reason}));
            }
            return Err(text.into());
        }
    };
    if let Command::Migrate = command {
        // Applies migrations and exits: the operator runs it as a Job before replicas start.
        let applied = scribyra_sync::store::migrate(&config).await?;
        let schema = scribyra_sync::store::MIGRATOR.iter().map(|m| m.version).max().unwrap_or(0);
        println!("{}", serde_json::json!({"event": "migrated", "applied": applied, "schema": schema}));
        return Ok(ExitCode::SUCCESS);
    }
    let store = Store::open(config).await?;
    match command {
        Command::Serve => service::serve(store).await.map(|()| ExitCode::SUCCESS),
        Command::CompileWorker => scribyra_sync::compiles::run_worker(store).await.map(|()| ExitCode::SUCCESS),
        Command::Migrate => unreachable!(),
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
