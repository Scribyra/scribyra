use scribyra_sync::{config::Config, migrate_sqlite, service, store::Store};
use std::{path::PathBuf, process::ExitCode, str::FromStr};

const USAGE: &str = "usage: scribyra-sync [serve] | migrate | compile-worker | verify | audit verify [--org <org>] [<seq>:<hash>] | account unblock <email|provider:email|account> | migrate-sqlite <old-data-dir>";

enum Command {
    Serve,
    Migrate,
    CompileWorker,
    Verify,
    /// Checks the audit log's hash chains (every one, or one organisation's); optionally that an
    /// exported head is in that organisation's chain.
    AuditVerify(Option<String>, Option<(i64, String)>),
    /// Lets one account sign in again (when no administrator can), recorded as `system`.
    AccountUnblock(String),
    MigrateSqlite(PathBuf),
}
fn parse(args: &[String]) -> Option<Command> {
    match args {
        [] => Some(Command::Serve),
        [cmd] if cmd == "serve" => Some(Command::Serve),
        [cmd] if cmd == scribyra_sync::deploy::COMMAND_MIGRATE => Some(Command::Migrate),
        [cmd] if cmd == scribyra_sync::deploy::COMMAND_COMPILE_WORKER => Some(Command::CompileWorker),
        [cmd] if cmd == "verify" => Some(Command::Verify),
        [cmd, sub, rest @ ..] if cmd == "audit" && sub == "verify" => {
            let head = |head: &str| {
                let (seq, hash) = head.split_once(':')?;
                let valid = hash.len() == 64 && hash.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b));
                Some((seq.parse().ok()?, hash.to_owned())).filter(|_| valid)
            };
            let org = |org: &str| Some(org.to_owned()).filter(|o| o.len() == 64 && o.bytes().all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b)));
            match rest {
                [] => Some(Command::AuditVerify(None, None)),
                [flag, o] if flag == "--org" => Some(Command::AuditVerify(Some(org(o)?), None)),
                [flag, o, h] if flag == "--org" => Some(Command::AuditVerify(Some(org(o)?), Some(head(h)?))),
                // A head names one chain: without --org, the deployment's own.
                [h] => Some(Command::AuditVerify(Some(String::new()), Some(head(h)?))),
                _ => None,
            }
        }
        [cmd, sub, who] if cmd == "account" && sub == "unblock" => Some(Command::AccountUnblock(who.clone())),
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
    if let Command::AuditVerify(org, expect) = &command {
        // Reads only: no ownership, no migrations, so it runs beside serving replicas. One line
        // per chain checked (every chain without --org).
        let options = sqlx::postgres::PgConnectOptions::from_str(&config.database_url().map_err(|e| e.to_string())?)?.application_name("scribyra-sync-audit");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(1).connect_with(options).await?;
        let chains = match org {
            Some(org) => vec![org.clone()],
            None => scribyra_sync::audit::chains(&pool).await?,
        };
        let mut ok = true;
        for chain in chains {
            let report = scribyra_sync::audit::verify(&pool, &chain, expect.as_ref().map(|(s, h)| (*s, h.as_str())), config.audit_retention()).await?;
            println!("{}", report.json());
            ok &= report.ok();
        }
        return Ok(if ok { ExitCode::SUCCESS } else { ExitCode::FAILURE });
    }
    if let Command::AccountUnblock(who) = &command {
        // Like `audit verify`: no ownership, so it runs beside serving replicas.
        let options = sqlx::postgres::PgConnectOptions::from_str(&config.database_url().map_err(|e| e.to_string())?)?.application_name("scribyra-sync-account");
        let pool = sqlx::postgres::PgPoolOptions::new().max_connections(1).connect_with(options).await?;
        return Ok(match scribyra_sync::admin::unblock_cli(&pool, who).await {
            Ok(event) => {
                println!("{event}");
                ExitCode::SUCCESS
            }
            Err(reason) => {
                println!("{}", serde_json::json!({"event": "account_unblock_failed", "reason": reason}));
                ExitCode::FAILURE
            }
        });
    }
    let store = Store::open(config).await?;
    match command {
        Command::Serve => service::serve(store).await.map(|()| ExitCode::SUCCESS),
        Command::CompileWorker => scribyra_sync::compiles::run_worker(store).await.map(|()| ExitCode::SUCCESS),
        Command::Migrate | Command::AuditVerify(..) | Command::AccountUnblock(_) => unreachable!(),
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
