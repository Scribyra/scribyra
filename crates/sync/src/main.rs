use scribyra_sync::{config::Config, migrate_sqlite, service, store::Store};
use std::{path::PathBuf, process::ExitCode, str::FromStr};

const USAGE: &str = "usage: scribyra-sync [serve] | migrate | compile-worker | verify | audit verify [<seq>:<hash>] | migrate-sqlite <old-data-dir>";

enum Command {
    Serve,
    Migrate,
    CompileWorker,
    Verify,
    /// Checks the audit log's hash chain; optionally that an exported head is in it.
    AuditVerify(Option<(i64, String)>),
    MigrateSqlite(PathBuf),
}
fn parse(args: &[String]) -> Option<Command> {
    match args {
        [] => Some(Command::Serve),
        [cmd] if cmd == "serve" => Some(Command::Serve),
        [cmd] if cmd == scribyra_sync::deploy::COMMAND_MIGRATE => Some(Command::Migrate),
        [cmd] if cmd == scribyra_sync::deploy::COMMAND_COMPILE_WORKER => Some(Command::CompileWorker),
        [cmd] if cmd == "verify" => Some(Command::Verify),
        [cmd, sub] if cmd == "audit" && sub == "verify" => Some(Command::AuditVerify(None)),
        [cmd, sub, head] if cmd == "audit" && sub == "verify" => {
            let (seq, hash) = head.split_once(':')?;
            let valid = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
            Some(Command::AuditVerify(Some((seq.parse().ok()?, hash.to_owned())))).filter(|_| valid)
        }
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
        let (applied, protection) = scribyra_sync::store::migrate(&config).await?;
        let schema = scribyra_sync::store::MIGRATOR.iter().map(|m| m.version).max().unwrap_or(0);
        println!("{}", serde_json::json!({"event": "migrated", "applied": applied, "schema": schema, "auditProtection": protection}));
        return Ok(ExitCode::SUCCESS);
    }
    if let Command::AuditVerify(expect) = &command {
        // Reads only: no ownership, no migrations, so it runs beside serving replicas.
        let options = sqlx::postgres::PgConnectOptions::from_str(&config.database_url().map_err(|e| e.to_string())?)?.application_name("scribyra-sync-audit");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(1).connect_with(options).await?;
        let report = scribyra_sync::audit::verify(&pool, expect.as_ref().map(|(s, h)| (*s, h.as_str())), config.audit_retention()).await?;
        println!("{}", report.json());
        return Ok(if report.ok() { ExitCode::SUCCESS } else { ExitCode::FAILURE });
    }
    let store = Store::open(config).await?;
    match command {
        Command::Serve => service::serve(store).await.map(|()| ExitCode::SUCCESS),
        Command::CompileWorker => scribyra_sync::compiles::run_worker(store).await.map(|()| ExitCode::SUCCESS),
        Command::Migrate | Command::AuditVerify(_) => unreachable!(),
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
