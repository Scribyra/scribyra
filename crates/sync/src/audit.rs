//! The audit log (design section 5): every security-relevant action is one row of
//! `audit_events`, appended only through the SQL function `audit_append` (migration `0015`),
//! which numbers rows without gaps under a lock on the one `audit_head` row (so appends from every
//! replica form one line) and chains them: `hash = SHA-256(prev ‖ canonical row)`. The NOLOGIN
//! role `scribyra_audit_owner` owns the tables and the functions that write them (migration
//! `0031`, [`protect`]); the service's database user only reads the tables and calls the
//! functions, and triggers refuse every change that does not come from the owner.
//!
//! [`verify`] recomputes the chain outside the database (`scribyra-sync audit verify`), from the
//! first row or, after a retention purge, from the anchor its `audit.purge` event records; it
//! reports a changed row, a deleted row, a head that does not match, and a purge that deleted
//! events younger than the retention. Retention lives in the database (`audit_settings`, migration
//! `0030`): a purge cannot delete events younger than it, and the service cannot set it below 30
//! days.
//!
//! Never recorded: project content, ID tokens, session tokens, email bodies; emails appear only
//! as account details (resolved from `accounts` when the log is read), never in `detail`.
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use sqlx::{PgPool, Row};
use std::net::IpAddr;

/// The hash before the first event.
pub const GENESIS: &str = "0000000000000000000000000000000000000000000000000000000000000000";
/// The canonical text of a row as `audit_canonical` computes it (kept here too, so verifying does
/// not trust a function in the database it checks).
const CANONICAL: &str = "jsonb_build_array(seq, floor(extract(epoch FROM time) * 1000000)::bigint, actor, COALESCE(host(ip), ''), action, COALESCE(target_type, ''), COALESCE(target_id, ''), detail)::text";

/// Who did something: an account (with the client address it came from) or the service itself.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Actor {
    pub account: Option<String>,
    pub ip: Option<IpAddr>,
}
impl Actor {
    pub fn system() -> Self {
        Self { account: None, ip: None }
    }
    pub fn account(account: &str, ip: Option<IpAddr>) -> Self {
        Self { account: Some(account.to_owned()), ip }
    }
    fn id(&self) -> &str {
        self.account.as_deref().unwrap_or("system")
    }
}
/// The client address a request came from (its peer, or the address a trusted proxy names).
pub fn source(source: &Option<axum::Extension<crate::service::Source>>) -> Option<IpAddr> {
    source.as_ref().map(|axum::Extension(crate::service::Source(ip))| *ip)
}

/// Appends one event in the caller's transaction (call it after the rows the action changes) and
/// returns its sequence number. The event exists exactly when the transaction commits.
pub async fn record(conn: &mut sqlx::PgConnection, actor: &Actor, action: &str, target: Option<(&str, &str)>, detail: Value) -> Result<i64, sqlx::Error> {
    let (target_type, target_id) = target.map_or((None, None), |(t, i)| (Some(t), Some(i)));
    sqlx::query_scalar("SELECT audit_append($1, $2::inet, $3, $4, $5, $6::jsonb)")
        .bind(actor.id())
        .bind(actor.ip.map(|ip| ip.to_canonical().to_string()))
        .bind(action)
        .bind(target_type)
        .bind(target_id)
        .bind(detail.to_string())
        .fetch_one(conn)
        .await
}
/// [`record`] in a transaction of its own.
pub async fn record_now(pool: &PgPool, actor: &Actor, action: &str, target: Option<(&str, &str)>, detail: Value) -> Result<i64, sqlx::Error> {
    let mut tx = pool.begin().await?;
    let seq = record(&mut tx, actor, action, target, detail).await?;
    tx.commit().await?;
    Ok(seq)
}
/// Records and logs a failure to record (for actions that already happened and must not fail
/// because the log could not be written, such as a sign-out).
pub async fn record_or_log(pool: &PgPool, actor: &Actor, action: &str, target: Option<(&str, &str)>, detail: Value) {
    if record_now(pool, actor, action, target, detail).await.is_err() {
        println!("{}", json!({"event": "audit_append_failed", "action": action}));
    }
}

/// The chain's head: (sequence number, hash).
pub async fn head(pool: &PgPool) -> Result<(i64, String), sqlx::Error> {
    sqlx::query_as("SELECT seq, hash FROM audit_head").fetch_one(pool).await
}

/// Hands the audit tables to the role `scribyra_audit_owner` where the database user can
/// (`audit_protect`, migration `0031`; idempotent) and returns the outcome: `protected`,
/// `protected; reachable: …` (this user can still become the owner) or `unprotected: …`.
pub async fn protect(pool: &PgPool) -> Result<String, sqlx::Error> {
    sqlx::query_scalar("SELECT audit_protect()").fetch_one(pool).await
}
/// The shortest retention outside tests (`audit_settings.floor_seconds`; the service cannot lower
/// it). `audit verify` flags a purge whose cutoff was newer than its time minus this (or the
/// configured retention, if shorter).
pub const RETENTION_FLOOR_SECONDS: u64 = 30 * 24 * 3600;
/// Stores the configured retention in the database (raised to its floor) and returns the
/// retention in force, in seconds.
pub async fn set_retention(pool: &PgPool, seconds: u64) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT audit_set_retention($1)").bind(seconds.min(i64::MAX as u64) as i64).fetch_one(pool).await
}
/// Deletes the events older than the retention in force through `audit_purge_expired`, which
/// records the purge.
pub async fn purge(pool: &PgPool) -> Result<i64, sqlx::Error> {
    sqlx::query_scalar("SELECT audit_purge_expired()").fetch_one(pool).await
}
/// The retention task: purges at start and then every `every` seconds (any replica; the purge
/// takes the head's lock, so replicas never purge the same events twice).
pub async fn retain(pool: PgPool, every: u64) {
    loop {
        match purge(&pool).await {
            Ok(n) if n > 0 => println!("{}", json!({"event": "audit_purged", "count": n})),
            Ok(_) => {}
            Err(_) => println!("{}", json!({"event": "audit_purge_failed"})),
        }
        tokio::time::sleep(std::time::Duration::from_secs(every)).await;
    }
}

/// What [`verify`] found.
#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct Report {
    /// Events checked.
    pub events: u64,
    pub first: Option<i64>,
    pub last: Option<i64>,
    /// The head row's (sequence number, hash).
    pub head: (i64, String),
    /// Whether the first event is anchored: the chain's start, or the last purged event an
    /// `audit.purge` event names.
    pub anchored: bool,
    /// Problems as (sequence number, what), in order.
    pub problems: Vec<(i64, String)>,
}
impl Report {
    pub fn ok(&self) -> bool {
        self.problems.is_empty() && self.anchored
    }
    pub fn json(&self) -> Value {
        json!({"event": "audit_verify", "ok": self.ok(), "events": self.events, "first": self.first, "last": self.last, "head": {"seq": self.head.0, "hash": self.head.1}, "anchored": self.anchored,
               "problems": self.problems.iter().take(100).map(|(seq, what)| json!({"seq": seq, "problem": what})).collect::<Vec<_>>()})
    }
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
fn chain(prev: &str, canonical: &str) -> Option<String> {
    let prev = (0..prev.len()).step_by(2).map(|i| u8::from_str_radix(prev.get(i..i + 2)?, 16).ok()).collect::<Option<Vec<u8>>>()?;
    let mut h = Sha256::new();
    h.update(&prev);
    h.update(canonical.as_bytes());
    Some(hex(&h.finalize()))
}
/// Recomputes every hash, checks that sequence numbers have no gap and each row's `prev` is the
/// previous row's hash, that the first row is the chain's start or a purge's anchor, and that the
/// head row names the last row. A purge anchors only as a `system` `audit.purge` event recorded
/// after the events it names; one whose cutoff was newer than its own time minus `retention`
/// seconds (pass the shorter of the configured retention and [`RETENTION_FLOOR_SECONDS`]) is a
/// problem. `expect` (sequence number, hash), from an export, must match its event; an event
/// purged since is accepted only as the anchor of the first kept event, and one past the last
/// event is a problem.
pub async fn verify(pool: &PgPool, expect: Option<(i64, &str)>, retention: u64) -> Result<Report, sqlx::Error> {
    let mut report = Report { head: head(pool).await?, ..Report::default() };
    let mut previous: Option<(i64, String)> = None;
    let mut after = 0i64;
    let mut first_prev = None;
    // Purges: (seq, actor, time and cutoff in ms, last purged seq, its hash), from every kept
    // `audit.purge` event.
    let purges: Vec<(i64, String, i64, Option<i64>, Option<i64>, Option<String>)> = sqlx::query_as(
        "SELECT seq, actor, (extract(epoch FROM time) * 1000)::bigint, (detail->>'before')::bigint, (detail->>'last_seq')::bigint, detail->>'last_hash' FROM audit_events WHERE action = 'audit.purge' ORDER BY seq",
    )
    .fetch_all(pool)
    .await?;
    let window = retention.min(RETENTION_FLOOR_SECONDS) as i64 * 1000;
    for (seq, _, time, before, ..) in &purges {
        if before.is_none_or(|b| b > time - window) {
            report.problems.push((*seq, "the purge deleted events newer than the retention allows".into()));
        }
    }
    let anchors: Vec<(i64, &str)> = purges
        .iter()
        .filter_map(|(seq, actor, _, _, last, hash)| match (last, hash) {
            (Some(last), Some(hash)) if actor == "system" && last < seq => Some((*last, hash.as_str())),
            _ => None,
        })
        .collect();
    loop {
        let rows = sqlx::query(&format!("SELECT seq, prev, hash, {CANONICAL} FROM audit_events WHERE seq > $1 ORDER BY seq LIMIT 5000")).bind(after).fetch_all(pool).await?;
        if rows.is_empty() {
            break;
        }
        for row in rows {
            let (seq, prev, hash, canonical): (i64, String, String, String) = (row.get(0), row.get(1), row.get(2), row.get(3));
            after = seq;
            report.events += 1;
            match &previous {
                None => {
                    report.first = Some(seq);
                    report.anchored = (seq == 1 && prev == GENESIS) || anchors.iter().any(|(s, h)| *s == seq - 1 && *h == prev);
                    if !report.anchored {
                        report.problems.push((seq, "the first event is neither the chain's start nor anchored by a purge".into()));
                    }
                    first_prev = Some(prev.clone());
                }
                Some((p_seq, p_hash)) => {
                    if seq != p_seq + 1 {
                        report.problems.push((seq, format!("events {}-{} are missing", p_seq + 1, seq - 1)));
                    }
                    if prev != *p_hash {
                        report.problems.push((seq, "prev is not the previous event's hash".into()));
                    }
                }
            }
            if chain(&prev, &canonical).as_deref() != Some(hash.as_str()) {
                report.problems.push((seq, "the hash does not match the event (changed)".into()));
            }
            if let Some((s, h)) = expect
                && s == seq
                && h != hash
            {
                report.problems.push((seq, "the hash differs from the one given".into()));
            }
            previous = Some((seq, hash));
        }
    }
    report.last = previous.as_ref().map(|(s, _)| *s);
    match &previous {
        Some((seq, hash)) if (*seq, hash.as_str()) != (report.head.0, report.head.1.as_str()) => report.problems.push((*seq, "the head does not name the last event (events after it were deleted)".into())),
        None if report.head.0 != 0 => report.problems.push((report.head.0, "the head names events that are gone".into())),
        None => report.anchored = true,
        _ => {}
    }
    if let Some((s, h)) = expect {
        if s > report.last.unwrap_or(0) {
            report.problems.push((s, "the given event is not in the log (events after it were deleted)".into()));
        } else if let Some(first) = report.first
            && s < first
            && !(report.anchored && s == first - 1 && first_prev.as_deref() == Some(h))
        {
            report.problems.push((s, "the given event was purged and is not the anchor the log starts from".into()));
        }
    }
    Ok(report)
}

/// One event as the admin routes show it, with the actor's account details.
pub fn event_json(row: &sqlx::postgres::PgRow) -> Value {
    json!({
        "seq": row.get::<i64, _>("seq"), "time": row.get::<i64, _>("ms"), "actor": row.get::<String, _>("actor"),
        "actorName": row.get::<Option<String>, _>("actor_name"), "actorEmail": row.get::<Option<String>, _>("actor_email"),
        "ip": row.get::<Option<String>, _>("ip"), "action": row.get::<String, _>("action"),
        "targetType": row.get::<Option<String>, _>("target_type"), "target": row.get::<Option<String>, _>("target_id"),
        "detail": serde_json::from_str::<Value>(&row.get::<String, _>("detail")).unwrap_or(Value::Null),
        "prev": row.get::<String, _>("prev"), "hash": row.get::<String, _>("hash"),
    })
}
/// The columns [`event_json`] reads, from `audit_events e LEFT JOIN accounts a ON a.account = e.actor`.
pub const EVENT_COLUMNS: &str = "e.seq, (extract(epoch FROM e.time) * 1000)::bigint AS ms, e.actor, a.name AS actor_name, CASE WHEN a.email_verified THEN a.email END AS actor_email,
    host(e.ip) AS ip, e.action, e.target_type, e.target_id, e.detail::text AS detail, e.prev, e.hash";

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn chain_is_sha256_of_prev_bytes_and_canonical_text() {
        let expected = hex(&Sha256::digest([vec![0u8; 32], b"[1]".to_vec()].concat()));
        assert_eq!(chain(GENESIS, "[1]").unwrap(), expected);
        assert!(chain("zz", "[1]").is_none());
    }
}
