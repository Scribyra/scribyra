//! The admin area (design section 5): `/v1/admin/…`, for the deployment's administrators only
//! (anyone else `403`, no session `401`). Every action is recorded in the audit log in its own
//! transaction, and so is every read of content (opening a project, exporting).
//!
//! Members: list (name, email, provider, role, state, last seen, storage), change role
//! (administrator or member; guests stay guests; the configuration's own administrators stay
//! administrators), disable (sessions revoked at once), unblock, remove (sessions revoked, shares
//! removed, owned projects transferred to a chosen account or the acting administrator). The
//! configuration's `admins` cannot be disabled or removed here, at least one active administrator
//! always remains (decided under locks on every administrator's row), and `scribyra-sync account
//! unblock` lets an operator restore an account when nobody can (see [`unblock_cli`]).
//! Projects: list all; in server-readable mode open as administrator (read access without a share
//! for [`crate::server_projects::ADMIN_OPEN_HOURS`], `project.admin_open`), edit as administrator
//! (an explicit editor share), transfer, delete (crypto-erase) and export everything (a streamed
//! zip of every project's files materialised from the server's state, the members and the audit
//! log). Audit log: query and export (JSON lines or CSV, with the head hash). Settings: the
//! policy, never a secret.
//!
//! In end-to-end mode the routes that read content answer `409`; members, the projects' metadata,
//! deletion (of the ciphertext the server holds) and the audit log work. Removing a person from an
//! end-to-end organisation still needs an administrator's app to sign `person.remove`.
use crate::{
    audit::{self, Actor},
    config::Encryption,
    server_projects::{self, Access, Sr, error, internal, ok_json},
    sso::{Role, Sso},
    store::Store,
};
use axum::{
    Extension, Json, Router,
    body::Body,
    extract::{Path, Query, State},
    http::{HeaderMap, HeaderValue, StatusCode, header},
    response::{IntoResponse, Response},
    routing::{get, post, put},
};
use serde::Deserialize;
use serde_json::{Value, json};
use sqlx::Row;
use std::{net::IpAddr, sync::Arc};
use tokio::sync::Semaphore;

const MAX_AUDIT_PAGE: i64 = 500;

pub struct Admin {
    store: Arc<Store>,
    sso: Arc<Sso>,
    sr: Arc<Sr>,
    /// One export at a time per replica (each holds a project's files in memory while it is
    /// written).
    exports: Arc<Semaphore>,
}
type Shared = Arc<Admin>;
type SourceIp = Option<Extension<crate::service::Source>>;

/// The administrator calling a route.
struct Caller {
    account: String,
    ip: Option<IpAddr>,
}
impl Caller {
    fn actor(&self) -> Actor {
        Actor::account(&self.account, self.ip)
    }
}

impl Admin {
    pub fn new(store: Arc<Store>, sso: Arc<Sso>, sr: Arc<Sr>) -> Shared {
        Arc::new(Self { store, sso, sr, exports: Arc::new(Semaphore::new(1)) })
    }
    fn encryption(&self) -> Option<Encryption> {
        self.store.config.deployment.as_ref().map(|d| d.encryption)
    }
    /// The caller, if signed in as an administrator: `401` without a session, `403` otherwise.
    async fn admin(&self, headers: &HeaderMap, source: &SourceIp) -> Result<Caller, Response> {
        if self.store.config.deployment.is_none() {
            return Err(error(StatusCode::NOT_FOUND, "this service has no deployment"));
        }
        let Some(token) = crate::sso::bearer(headers) else { return Err(error(StatusCode::UNAUTHORIZED, "sign in required")) };
        let login = self.sso.login(token).await.map_err(internal)?.ok_or_else(|| error(StatusCode::UNAUTHORIZED, "sign in required"))?;
        let Some(account) = login.account else { return Err(error(StatusCode::UNAUTHORIZED, "sign in again")) };
        if login.role != Role::Admin {
            return Err(error(StatusCode::FORBIDDEN, "administrators only"));
        }
        let _ = sqlx::query("UPDATE accounts SET last_seen = now() WHERE account = $1 AND last_seen < now() - interval '1 minute'").bind(&account).execute(&self.store.pool).await;
        Ok(Caller { account, ip: audit::source(source) })
    }
    /// Server-readable mode only: content routes are refused in end-to-end mode.
    fn readable(&self) -> Result<&Arc<server_projects::Projects>, Response> {
        if self.encryption() != Some(Encryption::Server) {
            return Err(error(StatusCode::CONFLICT, "in an end-to-end deployment the server cannot read projects"));
        }
        self.sr.projects()
    }
    fn org(&self) -> Result<&str, Response> {
        self.store.org.as_deref().ok_or_else(|| error(StatusCode::NOT_FOUND, "this service has no deployment"))
    }
}
macro_rules! admin {
    ($a:expr, $headers:expr, $source:expr) => {
        match $a.admin(&$headers, &$source).await {
            Ok(caller) => caller,
            Err(response) => return response,
        }
    };
}
macro_rules! check {
    ($e:expr) => {
        match $e {
            Ok(v) => v,
            Err(response) => return response,
        }
    };
}
fn valid_id(text: &str) -> bool {
    scribyra_core::blob::valid_hash(text)
}

// --- Members

const MEMBER_COLUMNS: &str = "a.account, a.name, CASE WHEN a.email_verified THEN a.email END, a.provider, a.role, a.state, a.guest, a.admin_grant,
    (extract(epoch FROM a.created) * 1000)::bigint, (extract(epoch FROM a.last_seen) * 1000)::bigint,
    (SELECT COALESCE(sum(p.bytes), 0)::bigint FROM sr_projects p WHERE p.owner = a.account AND p.deleted IS NULL),
    (SELECT count(*) FROM sr_projects p WHERE p.owner = a.account AND p.deleted IS NULL)";
fn member_json(r: &sqlx::postgres::PgRow) -> Value {
    json!({
        "account": r.get::<String, _>(0), "name": r.get::<Option<String>, _>(1), "email": r.get::<Option<String>, _>(2), "provider": r.get::<String, _>(3),
        "role": r.get::<String, _>(4), "state": r.get::<String, _>(5), "guest": r.get::<bool, _>(6), "granted": r.get::<bool, _>(7),
        "created": r.get::<i64, _>(8), "lastSeen": r.get::<i64, _>(9), "storage": r.get::<i64, _>(10), "projects": r.get::<i64, _>(11),
    })
}
async fn members_json(store: &Store, removed: bool) -> Result<Vec<Value>, sqlx::Error> {
    let rows = sqlx::query(&format!("SELECT {MEMBER_COLUMNS} FROM accounts a WHERE a.state <> 'removed' OR $1 ORDER BY a.created, a.account")).bind(removed).fetch_all(&store.pool).await?;
    Ok(rows.iter().map(member_json).collect())
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct MembersQuery {
    #[serde(default)]
    removed: bool,
}
async fn members(State(a): State<Shared>, source: SourceIp, Query(q): Query<MembersQuery>, headers: HeaderMap) -> Response {
    let caller = admin!(a, headers, source);
    match members_json(&a.store, q.removed).await {
        Ok(list) => ok_json(StatusCode::OK, json!({"account": caller.account, "members": list})),
        Err(e) => internal(e),
    }
}
/// The member as the admin routes show them, after a change.
async fn member(a: &Admin, account: &str) -> Response {
    match sqlx::query(&format!("SELECT {MEMBER_COLUMNS} FROM accounts a WHERE a.account = $1")).bind(account).fetch_optional(&a.store.pool).await {
        Ok(Some(row)) => ok_json(StatusCode::OK, member_json(&row)),
        Ok(None) => error(StatusCode::NOT_FOUND, "unknown account"),
        Err(e) => internal(e),
    }
}
/// Locks the account rows of every active administrator, always in account order (so concurrent
/// member actions queue rather than deadlock), before the action's target, and returns them:
/// whether at least one administrator remains is decided under these locks (review M3).
async fn lock_admins(tx: &mut sqlx::PgConnection) -> Result<Vec<String>, Response> {
    sqlx::query_scalar("SELECT account FROM accounts WHERE role = 'admin' AND state = 'active' ORDER BY account FOR UPDATE").fetch_all(&mut *tx).await.map_err(internal)
}
/// Refuses an action that would leave no active administrator: `target` stops being one.
fn keeps_an_admin(admins: &[String], target: &str) -> Result<(), Response> {
    if !admins.iter().any(|a| a == target) || admins.iter().any(|a| a != target) {
        Ok(())
    } else {
        Err(error(StatusCode::CONFLICT, "at least one active administrator must remain"))
    }
}
/// Refuses to disable or remove an administrator the configuration's `admins` list names: only
/// the configuration changes that (review M3).
async fn not_listed(a: &Admin, account: &str) -> Result<(), Response> {
    match a.sso.listed_admin(account).await {
        Ok(false) => Ok(()),
        Ok(true) => Err(error(StatusCode::CONFLICT, "this person is an administrator through the deployment's configuration (admins); change the configuration instead")),
        Err(e) => Err(internal(e)),
    }
}
/// The target of a member action: an existing account other than the caller's own (an
/// administrator does not demote, disable or remove themselves; another administrator can).
async fn target(caller: &Caller, account: &str, tx: &mut sqlx::PgConnection) -> Result<(String, String, bool, bool), Response> {
    if !valid_id(account) {
        return Err(error(StatusCode::NOT_FOUND, "unknown account"));
    }
    if account == caller.account {
        return Err(error(StatusCode::CONFLICT, "ask another administrator to change your own account"));
    }
    sqlx::query_as("SELECT role, state, guest, admin_grant FROM accounts WHERE account = $1 FOR UPDATE").bind(account).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(|| error(StatusCode::NOT_FOUND, "unknown account"))
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RoleChange {
    role: String,
}
/// Makes a member an administrator or an administrator a member. Guests stay guests, and the
/// configuration's administrators (`admins`, `admin_groups`) are its alone (`409`): they cannot be
/// demoted here, nor granted the role (a grant would outlast the provider taking it away, review
/// M2). Every change of the grant is recorded.
async fn set_role(State(a): State<Shared>, Path(account): Path<String>, source: SourceIp, headers: HeaderMap, Json(request): Json<RoleChange>) -> Response {
    let caller = admin!(a, headers, source);
    let grant = match request.role.as_str() {
        "admin" => true,
        "member" => false,
        _ => return error(StatusCode::BAD_REQUEST, "role must be admin or member"),
    };
    let configured = match a.sso.configured_role(&account).await {
        Ok(role) => role,
        Err(e) => return internal(e),
    };
    let done = async {
        let mut tx = a.store.pool.begin().await.map_err(internal)?;
        let admins = lock_admins(&mut tx).await?;
        let (role, state, guest, granted) = target(&caller, &account, &mut tx).await?;
        if guest || role == "guest" {
            return Err(error(StatusCode::CONFLICT, "guests stay guests"));
        }
        if state == "removed" {
            return Err(error(StatusCode::CONFLICT, "this account was removed"));
        }
        if configured == Some(Role::Admin) {
            return Err(error(StatusCode::CONFLICT, "this person is an administrator through the deployment's configuration (admins or admin_groups)"));
        }
        let to = if grant { "admin" } else { "member" };
        if to != "admin" {
            keeps_an_admin(&admins, &account)?;
        }
        sqlx::query("UPDATE accounts SET admin_grant = $2, role = $3 WHERE account = $1").bind(&account).bind(grant).bind(to).execute(&mut *tx).await.map_err(internal)?;
        if to != role {
            audit::record(&mut tx, &caller.actor(), "account.role_changed", Some(("account", &account)), json!({"from": role, "to": to, "by": "admin"})).await.map_err(internal)?;
            server_projects::notify_account(&mut tx, &account).await.map_err(internal)?;
        } else if granted != grant {
            audit::record(&mut tx, &caller.actor(), "account.admin_grant_changed", Some(("account", &account)), json!({"grant": grant})).await.map_err(internal)?;
        }
        tx.commit().await.map_err(internal)
    };
    match done.await {
        Ok(()) => member(&a, &account).await,
        Err(r) => r,
    }
}
/// Disables an account: its sessions end at once and it cannot sign in until unblocked.
async fn disable(State(a): State<Shared>, Path(account): Path<String>, source: SourceIp, headers: HeaderMap) -> Response {
    let caller = admin!(a, headers, source);
    check!(not_listed(&a, &account).await);
    let done = async {
        let mut tx = a.store.pool.begin().await.map_err(internal)?;
        let admins = lock_admins(&mut tx).await?;
        let (_, state, ..) = target(&caller, &account, &mut tx).await?;
        keeps_an_admin(&admins, &account)?;
        match state.as_str() {
            "disabled" => return Ok(Vec::new()),
            "removed" => return Err(error(StatusCode::CONFLICT, "this account was removed")),
            _ => {}
        }
        sqlx::query("UPDATE accounts SET state = 'disabled' WHERE account = $1").bind(&account).execute(&mut *tx).await.map_err(internal)?;
        let fired = Sso::revoke_account_in(&mut tx, &account).await.map_err(internal)?;
        audit::record(&mut tx, &caller.actor(), "account.disabled", Some(("account", &account)), json!({"from": state})).await.map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        Ok(fired)
    };
    match done.await {
        Ok(fired) => {
            a.sso.announce(fired);
            member(&a, &account).await
        }
        Err(r) => r,
    }
}
/// Lets a disabled, blocked (the provider refused it) or removed account sign in again.
async fn unblock(State(a): State<Shared>, Path(account): Path<String>, source: SourceIp, headers: HeaderMap) -> Response {
    let caller = admin!(a, headers, source);
    let done = async {
        let mut tx = a.store.pool.begin().await.map_err(internal)?;
        lock_admins(&mut tx).await?;
        let (_, state, ..) = target(&caller, &account, &mut tx).await?;
        if state == "active" {
            return Ok(());
        }
        sqlx::query("UPDATE accounts SET state = 'active' WHERE account = $1").bind(&account).execute(&mut *tx).await.map_err(internal)?;
        // End-to-end: the identity's link to its person was blocked with it.
        sqlx::query("UPDATE sso_links l SET state = 'active' FROM accounts a WHERE a.account = $1 AND l.issuer = a.issuer AND l.subject = a.subject AND l.state = 'blocked'").bind(&account).execute(&mut *tx).await.map_err(internal)?;
        audit::record(&mut tx, &caller.actor(), "account.unblocked", Some(("account", &account)), json!({"from": state})).await.map_err(internal)?;
        tx.commit().await.map_err(internal)
    };
    match done.await {
        Ok(()) => member(&a, &account).await,
        Err(r) => r,
    }
}
#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields)]
struct Removal {
    /// Who takes over the removed account's projects (default: the acting administrator).
    #[serde(default)]
    transfer: Option<String>,
}
/// Removes an account: its sessions end, its shares go, its projects pass to `transfer` (an
/// active member or administrator, the caller by default), and it cannot sign in until an
/// administrator restores it.
async fn remove(State(a): State<Shared>, Path(account): Path<String>, source: SourceIp, headers: HeaderMap, body: Option<Json<Removal>>) -> Response {
    let caller = admin!(a, headers, source);
    let to = body.and_then(|Json(r)| r.transfer).unwrap_or_else(|| caller.account.clone());
    check!(not_listed(&a, &account).await);
    let done = async {
        let mut tx = a.store.pool.begin().await.map_err(internal)?;
        let admins = lock_admins(&mut tx).await?;
        let (_, state, ..) = target(&caller, &account, &mut tx).await?;
        keeps_an_admin(&admins, &account)?;
        if state == "removed" {
            return Err(error(StatusCode::CONFLICT, "this account was removed already"));
        }
        let heir: Option<(String, String)> = sqlx::query_as("SELECT role, state FROM accounts WHERE account = $1").bind(&to).fetch_optional(&mut *tx).await.map_err(internal)?;
        match heir {
            _ if to == account => return Err(error(StatusCode::BAD_REQUEST, "projects cannot pass to the account being removed")),
            Some((role, state)) if role != "guest" && state == "active" => {}
            Some(_) => return Err(error(StatusCode::CONFLICT, "projects can pass only to an active member or administrator")),
            None => return Err(error(StatusCode::NOT_FOUND, "unknown account to transfer to")),
        }
        let owned: Vec<String> = sqlx::query_scalar("SELECT project FROM sr_projects WHERE owner = $1 AND deleted IS NULL ORDER BY project FOR UPDATE").bind(&account).fetch_all(&mut *tx).await.map_err(internal)?;
        for project in &owned {
            sqlx::query("DELETE FROM sr_shares WHERE project = $1 AND account = $2").bind(project).bind(&to).execute(&mut *tx).await.map_err(internal)?;
            sqlx::query("UPDATE sr_projects SET owner = $2, updated = now() WHERE project = $1").bind(project).bind(&to).execute(&mut *tx).await.map_err(internal)?;
            server_projects::notify(&mut tx, project).await.map_err(internal)?;
        }
        let shared: Vec<String> = sqlx::query_scalar("DELETE FROM sr_shares WHERE account = $1 RETURNING project").bind(&account).fetch_all(&mut *tx).await.map_err(internal)?;
        for project in &shared {
            server_projects::notify(&mut tx, project).await.map_err(internal)?;
        }
        sqlx::query("DELETE FROM sr_admin_opens WHERE account = $1").bind(&account).execute(&mut *tx).await.map_err(internal)?;
        sqlx::query("UPDATE accounts SET state = 'removed', admin_grant = false WHERE account = $1").bind(&account).execute(&mut *tx).await.map_err(internal)?;
        let fired = Sso::revoke_account_in(&mut tx, &account).await.map_err(internal)?;
        server_projects::notify_account(&mut tx, &to).await.map_err(internal)?;
        let actor = caller.actor();
        for project in &owned {
            audit::record(&mut tx, &actor, "project.transferred", Some(("project", project)), json!({"from": account, "to": to, "admin": true, "reason": "account_removed"})).await.map_err(internal)?;
        }
        audit::record(&mut tx, &actor, "account.removed", Some(("account", &account)), json!({"from": state, "transferredTo": to, "projects": owned.len(), "shares": shared.len()})).await.map_err(internal)?;
        tx.commit().await.map_err(internal)?;
        Ok((fired, owned.len()))
    };
    match done.await {
        Ok((fired, projects)) => {
            a.sso.announce(fired);
            ok_json(StatusCode::OK, json!({"account": account, "state": "removed", "transferredTo": to, "projects": projects}))
        }
        Err(r) => r,
    }
}

/// `scribyra-sync account unblock <email|provider:email|account>`: the operator's way back when no
/// administrator can act (every one disabled or removed). Makes the one account that matches
/// (an account ID, a provider's verified email, or a verified email at any provider) active again,
/// with its end-to-end link, and records `account.unblocked` as `system` (`"by": "cli"`). Returns
/// the event to print, or why nothing changed.
pub async fn unblock_cli(pool: &sqlx::PgPool, who: &str) -> Result<Value, String> {
    let who = who.trim();
    let mut tx = pool.begin().await.map_err(|_| "the database could not be reached")?;
    let query = if valid_id(who) {
        sqlx::query_as("SELECT account, state FROM accounts WHERE account = $1 FOR UPDATE").bind(who.to_owned())
    } else {
        let (provider, email) = match who.split_once(':') {
            Some((provider, email)) if !provider.contains('@') => (Some(provider.to_owned()), email),
            _ => (None, who),
        };
        sqlx::query_as("SELECT account, state FROM accounts WHERE email = $1 AND email_verified AND ($2::text IS NULL OR provider = $2) ORDER BY account FOR UPDATE").bind(crate::sso::normalise_email(email)).bind(provider)
    };
    let rows: Vec<(String, String)> = query.fetch_all(&mut *tx).await.map_err(|_| "the database could not be read")?;
    let (account, state) = match rows.as_slice() {
        [] => return Err("no account matches".into()),
        [one] => one.clone(),
        many => return Err(format!("{} accounts match; name one as provider:email or by its account ID", many.len())),
    };
    if state != "active" {
        let done = async {
            sqlx::query("UPDATE accounts SET state = 'active' WHERE account = $1").bind(&account).execute(&mut *tx).await?;
            sqlx::query("UPDATE sso_links l SET state = 'active' FROM accounts a WHERE a.account = $1 AND l.issuer = a.issuer AND l.subject = a.subject AND l.state = 'blocked'").bind(&account).execute(&mut *tx).await?;
            audit::record(&mut tx, &Actor::system(), "account.unblocked", Some(("account", &account)), json!({"from": state, "by": "cli"})).await?;
            Ok::<_, sqlx::Error>(())
        };
        done.await.map_err(|_| "the account could not be changed")?;
    }
    tx.commit().await.map_err(|_| "the account could not be changed")?;
    Ok(json!({"event": "account_unblocked", "account": account, "from": state, "changed": state != "active"}))
}

// --- Projects

async fn projects(State(a): State<Shared>, source: SourceIp, headers: HeaderMap) -> Response {
    let caller = admin!(a, headers, source);
    if a.encryption() == Some(Encryption::E2ee) {
        // Names are encrypted: IDs, sizes and heads only.
        let org = check!(a.org());
        let rows: Result<Vec<(String, i64, i64, i32)>, _> = sqlx::query_as("SELECT project, bytes, head_seq, epoch FROM projects WHERE org = $1 ORDER BY project").bind(org).fetch_all(&a.store.pool).await;
        return match rows {
            Ok(rows) => ok_json(StatusCode::OK, json!({"encryption": "e2ee", "projects": rows.iter().map(|(id, size, head, epoch)| json!({"id": id, "size": size, "head": head, "epoch": epoch})).collect::<Vec<_>>()})),
            Err(e) => internal(e),
        };
    }
    let rows = sqlx::query(
        "SELECT p.project, p.name, o.account, o.name, CASE WHEN o.email_verified THEN o.email END, p.bytes, p.head_seq,
                (extract(epoch FROM p.created) * 1000)::bigint, (extract(epoch FROM p.updated) * 1000)::bigint,
                COALESCE((SELECT json_agg(json_build_object('account', m.account, 'name', m.name, 'email', CASE WHEN m.email_verified THEN m.email END, 'role', s.role) ORDER BY s.created, m.account)
                          FROM sr_shares s JOIN accounts m ON m.account = s.account WHERE s.project = p.project), '[]')::text,
                CASE WHEN p.owner = $1 THEN 'owner' ELSE (SELECT role FROM sr_shares WHERE project = p.project AND account = $1) END,
                (SELECT (extract(epoch FROM until) * 1000)::bigint FROM sr_admin_opens WHERE project = p.project AND account = $1 AND until > now())
         FROM sr_projects p JOIN accounts o ON o.account = p.owner WHERE p.deleted IS NULL ORDER BY p.updated DESC, p.project",
    )
    .bind(&caller.account)
    .fetch_all(&a.store.pool)
    .await;
    let rows = match rows {
        Ok(rows) => rows,
        Err(e) => return internal(e),
    };
    let list: Vec<Value> = rows
        .iter()
        .map(|r| {
            json!({
                "id": r.get::<String, _>(0), "name": r.get::<String, _>(1),
                "owner": {"account": r.get::<String, _>(2), "name": r.get::<Option<String>, _>(3), "email": r.get::<Option<String>, _>(4)},
                "size": r.get::<i64, _>(5), "head": r.get::<i64, _>(6), "created": r.get::<i64, _>(7), "updated": r.get::<i64, _>(8),
                "members": serde_json::from_str::<Value>(&r.get::<String, _>(9)).unwrap_or(json!([])), "role": r.get::<Option<String>, _>(10), "openUntil": r.get::<Option<i64>, _>(11),
            })
        })
        .collect();
    ok_json(StatusCode::OK, json!({"encryption": "server", "projects": list}))
}
/// A live project's owner, its row locked for the caller's transaction.
async fn live(project: &str, tx: &mut sqlx::PgConnection) -> Result<String, Response> {
    if !valid_id(project) {
        return Err(server_projects::not_found());
    }
    sqlx::query_scalar("SELECT owner FROM sr_projects WHERE project = $1 AND deleted IS NULL FOR UPDATE").bind(project).fetch_optional(&mut *tx).await.map_err(internal)?.ok_or_else(server_projects::not_found)
}
/// "Open as administrator": read access (log, snapshot, objects; never writes) without a share,
/// for a limited time, recorded as `project.admin_open` (and shown to the project's members).
async fn open(State(a): State<Shared>, Path(p): Path<String>, source: SourceIp, headers: HeaderMap) -> Response {
    let caller = admin!(a, headers, source);
    let projects = check!(a.readable());
    let done = async {
        let mut tx = a.store.pool.begin().await.map_err(internal)?;
        live(&p, &mut tx).await?;
        sqlx::query("INSERT INTO sr_admin_opens (project, account, until) VALUES ($1, $2, now() + make_interval(hours => $3)) ON CONFLICT (project, account) DO UPDATE SET until = EXCLUDED.until")
            .bind(&p)
            .bind(&caller.account)
            .bind(server_projects::ADMIN_OPEN_HOURS)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        server_projects::notify(&mut tx, &p).await.map_err(internal)?;
        server_projects::notify_account(&mut tx, &caller.account).await.map_err(internal)?;
        audit::record(&mut tx, &caller.actor(), "project.admin_open", Some(("project", &p)), json!({"hours": server_projects::ADMIN_OPEN_HOURS})).await.map_err(internal)?;
        tx.commit().await.map_err(internal)
    };
    if let Err(r) = done.await {
        return r;
    }
    let sr_caller = server_projects::Caller { account: caller.account.clone(), role: Role::Admin };
    let access = check!(a.sr.access(projects, &sr_caller, &p).await);
    match a.sr.details(projects, &sr_caller, &p, access).await {
        Ok(details) => ok_json(StatusCode::OK, details),
        Err(r) => r,
    }
}
/// "Edit as administrator": an explicit editor share for the administrator (`project.admin_edit`).
async fn edit(State(a): State<Shared>, Path(p): Path<String>, source: SourceIp, headers: HeaderMap) -> Response {
    let caller = admin!(a, headers, source);
    let projects = check!(a.readable());
    let done = async {
        let mut tx = a.store.pool.begin().await.map_err(internal)?;
        let owner = live(&p, &mut tx).await?;
        if owner == caller.account {
            return Err(error(StatusCode::CONFLICT, "you own this project"));
        }
        let previous: Option<String> = sqlx::query_scalar("SELECT role FROM sr_shares WHERE project = $1 AND account = $2").bind(&p).bind(&caller.account).fetch_optional(&mut *tx).await.map_err(internal)?;
        sqlx::query("INSERT INTO sr_shares (project, account, role, created_by) VALUES ($1, $2, 'editor', $2) ON CONFLICT (project, account) DO UPDATE SET role = 'editor'")
            .bind(&p)
            .bind(&caller.account)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
        server_projects::notify(&mut tx, &p).await.map_err(internal)?;
        server_projects::notify_account(&mut tx, &caller.account).await.map_err(internal)?;
        audit::record(&mut tx, &caller.actor(), "project.admin_edit", Some(("project", &p)), json!({"role": "editor", "previous": previous})).await.map_err(internal)?;
        tx.commit().await.map_err(internal)
    };
    if let Err(r) = done.await {
        return r;
    }
    let sr_caller = server_projects::Caller { account: caller.account.clone(), role: Role::Admin };
    match a.sr.details(projects, &sr_caller, &p, Access::Editor).await {
        Ok(details) => ok_json(StatusCode::OK, details),
        Err(r) => r,
    }
}
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Transfer {
    account: String,
}
/// Transfers a project to an active member or administrator; the previous owner keeps editing.
async fn transfer(State(a): State<Shared>, Path(p): Path<String>, source: SourceIp, headers: HeaderMap, Json(request): Json<Transfer>) -> Response {
    let caller = admin!(a, headers, source);
    check!(a.readable());
    let done = async {
        let mut tx = a.store.pool.begin().await.map_err(internal)?;
        let owner = live(&p, &mut tx).await?;
        if owner == request.account {
            return Err(error(StatusCode::CONFLICT, "that account owns this project already"));
        }
        let heir: Option<(String, String)> = sqlx::query_as("SELECT role, state FROM accounts WHERE account = $1").bind(&request.account).fetch_optional(&mut *tx).await.map_err(internal)?;
        match heir {
            Some((role, state)) if role != "guest" && state == "active" => {}
            Some(_) => return Err(error(StatusCode::CONFLICT, "projects can pass only to an active member or administrator")),
            None => return Err(error(StatusCode::NOT_FOUND, "unknown account")),
        }
        sqlx::query("DELETE FROM sr_shares WHERE project = $1 AND account = $2").bind(&p).bind(&request.account).execute(&mut *tx).await.map_err(internal)?;
        sqlx::query("UPDATE sr_projects SET owner = $2, updated = now() WHERE project = $1").bind(&p).bind(&request.account).execute(&mut *tx).await.map_err(internal)?;
        let kept: Option<String> = sqlx::query_scalar("SELECT state FROM accounts WHERE account = $1 AND state = 'active'").bind(&owner).fetch_optional(&mut *tx).await.map_err(internal)?;
        if kept.is_some() {
            sqlx::query("INSERT INTO sr_shares (project, account, role, created_by) VALUES ($1, $2, 'editor', $3) ON CONFLICT (project, account) DO UPDATE SET role = 'editor'").bind(&p).bind(&owner).bind(&caller.account).execute(&mut *tx).await.map_err(internal)?;
        }
        server_projects::notify(&mut tx, &p).await.map_err(internal)?;
        for account in [&owner, &request.account] {
            server_projects::notify_account(&mut tx, account).await.map_err(internal)?;
        }
        audit::record(&mut tx, &caller.actor(), "project.transferred", Some(("project", &p)), json!({"from": owner, "to": request.account, "admin": true})).await.map_err(internal)?;
        tx.commit().await.map_err(internal)
    };
    match done.await {
        Ok(()) => ok_json(StatusCode::OK, json!({"id": p, "owner": request.account})),
        Err(r) => r,
    }
}
/// Deletes a project. Server-readable: crypto-erase, as an owner's delete. End-to-end: the
/// ciphertext the server holds (log, objects, key wraps) is removed.
async fn delete(State(a): State<Shared>, Path(p): Path<String>, source: SourceIp, headers: HeaderMap) -> Response {
    let caller = admin!(a, headers, source);
    if !valid_id(&p) {
        return server_projects::not_found();
    }
    if a.encryption() == Some(Encryption::E2ee) {
        return match delete_e2ee(&a, &caller, &p).await {
            Ok(true) => StatusCode::NO_CONTENT.into_response(),
            Ok(false) => server_projects::not_found(),
            Err(r) => r,
        };
    }
    let projects = check!(a.sr.projects());
    match projects.delete(&p, &caller.actor(), json!({"admin": true})).await {
        Ok(true) => StatusCode::NO_CONTENT.into_response(),
        Ok(false) => server_projects::not_found(),
        Err(e) => internal(e),
    }
}
async fn delete_e2ee(a: &Admin, caller: &Caller, p: &str) -> Result<bool, Response> {
    let org = a.org()?.to_owned();
    let namespace = crate::org::object_namespace(p);
    let mut tx = a.store.pool.begin().await.map_err(internal)?;
    let Some(bytes): Option<i64> = sqlx::query_scalar("SELECT bytes FROM projects WHERE project = $1 AND org = $2 FOR UPDATE").bind(p).bind(&org).fetch_optional(&mut *tx).await.map_err(internal)? else { return Ok(false) };
    let (entries, blobs): (i64, Vec<String>) = {
        let count: i64 = sqlx::query_scalar("SELECT count(*) FROM entries WHERE project = $1").bind(p).fetch_one(&mut *tx).await.map_err(internal)?;
        (count, sqlx::query_scalar("SELECT entry_hash FROM entries WHERE project = $1 AND inline IS NULL").bind(p).fetch_all(&mut *tx).await.map_err(internal)?)
    };
    let objects: Vec<(String, i64)> = sqlx::query_as("DELETE FROM objects WHERE namespace = $1 RETURNING hash, size").bind(&namespace).fetch_all(&mut *tx).await.map_err(internal)?;
    let object_bytes: i64 = objects.iter().map(|(_, s)| s).sum();
    // Usage rows in the order appends lock them: global, then the organisation's.
    for scope in [crate::store::GLOBAL_SCOPE.to_owned(), crate::org::org_scope(&org)] {
        sqlx::query("SELECT bytes FROM usage WHERE scope = $1 FOR UPDATE").bind(&scope).execute(&mut *tx).await.map_err(internal)?;
        sqlx::query("UPDATE usage SET bytes = greatest(bytes - $2, 0), objects = greatest(objects - $3, 0) WHERE scope = $1")
            .bind(&scope)
            .bind(bytes + object_bytes)
            .bind(entries + objects.len() as i64)
            .execute(&mut *tx)
            .await
            .map_err(internal)?;
    }
    sqlx::query("DELETE FROM usage WHERE scope = $1").bind(crate::store::namespace_scope(&namespace)).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("DELETE FROM wraps WHERE org = $1 AND project = $2").bind(&org).bind(p).execute(&mut *tx).await.map_err(internal)?;
    sqlx::query("DELETE FROM projects WHERE project = $1").bind(p).execute(&mut *tx).await.map_err(internal)?;
    audit::record(&mut tx, &caller.actor(), "project.deleted", Some(("project", p)), json!({"admin": true, "encryption": "e2ee"})).await.map_err(internal)?;
    tx.commit().await.map_err(internal)?;
    for hash in blobs {
        if let Ok(key) = crate::org::entry_key(p, &hash) {
            let _ = a.store.blobs.delete(&key).await;
        }
    }
    for (hash, _) in objects {
        if let Ok(key) = crate::store::object_key(&namespace, &hash) {
            let _ = a.store.blobs.delete(&key).await;
        }
    }
    Ok(true)
}

// --- Audit log

#[derive(Deserialize, Default)]
#[serde(deny_unknown_fields, rename_all = "camelCase")]
struct AuditQuery {
    #[serde(default)]
    actor: Option<String>,
    /// An action (`project.admin_open`) or its first part (`project` matches every `project.…`).
    #[serde(default)]
    action: Option<String>,
    #[serde(default)]
    target: Option<String>,
    #[serde(default)]
    target_type: Option<String>,
    /// Milliseconds since 1970, inclusive.
    #[serde(default)]
    from: Option<i64>,
    /// Milliseconds since 1970, exclusive.
    #[serde(default)]
    to: Option<i64>,
    /// Paging: events before this sequence number (newest first).
    #[serde(default)]
    before: Option<i64>,
    #[serde(default)]
    limit: Option<i64>,
    /// Export: `jsonl` (default) or `csv`.
    #[serde(default)]
    format: Option<String>,
}
impl AuditQuery {
    fn bounded(&self) -> bool {
        self.actor.as_ref().is_none_or(|a| a.len() <= 128) && self.action.as_ref().is_none_or(|a| a.len() <= 64) && self.target.as_ref().is_none_or(|t| t.len() <= 128) && self.target_type.as_ref().is_none_or(|t| t.len() <= 32)
    }
    fn filters(&self) -> Value {
        json!({"actor": self.actor, "action": self.action, "target": self.target, "targetType": self.target_type, "from": self.from, "to": self.to})
    }
}
const AUDIT_WHERE: &str = "($1::text IS NULL OR e.actor = $1) AND ($2::text IS NULL OR e.action = $2 OR e.action LIKE $2 || '.%') AND ($3::text IS NULL OR e.target_id = $3)
    AND ($4::text IS NULL OR e.target_type = $4) AND ($5::bigint IS NULL OR e.time >= to_timestamp($5 / 1000.0)) AND ($6::bigint IS NULL OR e.time < to_timestamp($6 / 1000.0))";
fn bind_filters<'q>(query: sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments>, q: &'q AuditQuery) -> sqlx::query::Query<'q, sqlx::Postgres, sqlx::postgres::PgArguments> {
    query.bind(&q.actor).bind(q.action.as_deref().map(|a| a.trim_end_matches('.'))).bind(&q.target).bind(&q.target_type).bind(q.from).bind(q.to)
}
/// Newest first, `limit` per page (at most 500), `before` a sequence number for the next page.
async fn audit_log(State(a): State<Shared>, source: SourceIp, Query(q): Query<AuditQuery>, headers: HeaderMap) -> Response {
    admin!(a, headers, source);
    if !q.bounded() || q.format.is_some() {
        return error(StatusCode::BAD_REQUEST, "invalid filter");
    }
    let limit = q.limit.unwrap_or(100).clamp(1, MAX_AUDIT_PAGE);
    let sql = format!("SELECT {} FROM audit_events e LEFT JOIN accounts a ON a.account = e.actor WHERE {AUDIT_WHERE} AND ($7::bigint IS NULL OR e.seq < $7) ORDER BY e.seq DESC LIMIT $8", audit::EVENT_COLUMNS);
    let rows = bind_filters(sqlx::query(&sql), &q).bind(q.before).bind(limit + 1).fetch_all(&a.store.pool).await;
    let (rows, head) = match (rows, audit::head(&a.store.pool).await) {
        (Ok(rows), Ok(head)) => (rows, head),
        (Err(e), _) | (_, Err(e)) => return internal(e),
    };
    let more = rows.len() as i64 > limit;
    let events: Vec<Value> = rows.iter().take(limit as usize).map(audit::event_json).collect();
    let next = if more { events.last().and_then(|e| e["seq"].as_i64()) } else { None };
    ok_json(StatusCode::OK, json!({"events": events, "head": {"seq": head.0, "hash": head.1}, "next": next}))
}
/// Streams the filtered events oldest first as JSON lines or CSV; the head (sequence number and
/// hash) is in `Scribyra-Audit-Head` and at the end, so a copy can be compared with the log later
/// (`scribyra-sync audit verify <seq>:<hash>`). The export itself is recorded first.
async fn audit_export(State(a): State<Shared>, source: SourceIp, Query(q): Query<AuditQuery>, headers: HeaderMap) -> Response {
    let caller = admin!(a, headers, source);
    let csv = match q.format.as_deref() {
        None | Some("jsonl") => false,
        Some("csv") => true,
        _ => return error(StatusCode::BAD_REQUEST, "format must be jsonl or csv"),
    };
    if !q.bounded() || q.before.is_some() || q.limit.is_some() {
        return error(StatusCode::BAD_REQUEST, "invalid filter");
    }
    let mut detail = q.filters();
    detail["format"] = json!(if csv { "csv" } else { "jsonl" });
    if let Err(e) = audit::record_now(&a.store.pool, &caller.actor(), "audit.export", Some(("audit", "log")), detail).await {
        return internal(e);
    }
    let head = match audit::head(&a.store.pool).await {
        Ok(head) => head,
        Err(e) => return internal(e),
    };
    let (tx, body) = channel();
    let pool = a.store.pool.clone();
    let head_text = format!("{}:{}", head.0, head.1);
    tokio::spawn(async move {
        let mut out = Writer(tx);
        if csv && !out.send(CSV_HEADER.as_bytes().to_vec()).await {
            return;
        }
        let sql = format!("SELECT {} FROM audit_events e LEFT JOIN accounts a ON a.account = e.actor WHERE {AUDIT_WHERE} AND e.seq > $7 AND e.seq <= $8 ORDER BY e.seq LIMIT 2000", audit::EVENT_COLUMNS);
        let mut after = 0i64;
        loop {
            let rows = match bind_filters(sqlx::query(&sql), &q).bind(after).bind(head.0).fetch_all(&pool).await {
                Ok(rows) => rows,
                Err(_) => return out.fail().await,
            };
            if rows.is_empty() {
                break;
            }
            let mut chunk = Vec::new();
            for row in &rows {
                let event = audit::event_json(row);
                after = event["seq"].as_i64().unwrap_or(after);
                if csv {
                    chunk.extend(csv_row(&event).as_bytes());
                } else {
                    chunk.extend(event.to_string().as_bytes());
                    chunk.push(b'\n');
                }
            }
            if !out.send(chunk).await {
                return;
            }
        }
        let trailer = if csv { format!("# head {}:{}\n", head.0, head.1) } else { format!("{}\n", json!({"head": {"seq": head.0, "hash": head.1}})) };
        out.send(trailer.into_bytes()).await;
    });
    let name = if csv { "scribyra-audit.csv" } else { "scribyra-audit.jsonl" };
    let mut response = (StatusCode::OK, Body::from_stream(body)).into_response();
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static(if csv { "text/csv; charset=utf-8" } else { "application/x-ndjson" }));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_str(&format!("attachment; filename=\"{name}\"")).expect("ASCII"));
    h.insert(header::HeaderName::from_static("scribyra-audit-head"), HeaderValue::from_str(&head_text).expect("ASCII"));
    response
}
const CSV_HEADER: &str = "seq,time,actor,actor_name,actor_email,ip,action,target_type,target,detail,prev,hash\n";
/// One CSV record; every field quoted, and a field a spreadsheet would take for a formula prefixed
/// with `'`.
fn csv_row(event: &Value) -> String {
    let time = event["time"].as_i64().and_then(|ms| chrono_like(ms)).unwrap_or_default();
    let fields = [
        event["seq"].to_string(),
        time,
        text(&event["actor"]),
        text(&event["actorName"]),
        text(&event["actorEmail"]),
        text(&event["ip"]),
        text(&event["action"]),
        text(&event["targetType"]),
        text(&event["target"]),
        event["detail"].to_string(),
        text(&event["prev"]),
        text(&event["hash"]),
    ];
    let quoted: Vec<String> = fields
        .iter()
        .map(|f| {
            let f = if f.starts_with(['=', '+', '-', '@', '\t', '\r']) { format!("'{f}") } else { f.clone() };
            format!("\"{}\"", f.replace('"', "\"\""))
        })
        .collect();
    quoted.join(",") + "\n"
}
fn text(v: &Value) -> String {
    v.as_str().map(str::to_owned).unwrap_or_default()
}
/// RFC 3339 UTC time (millisecond precision) of milliseconds since 1970.
fn chrono_like(ms: i64) -> Option<String> {
    let (secs, millis) = (ms.div_euclid(1000), ms.rem_euclid(1000));
    let (days, rest) = (secs.div_euclid(86400), secs.rem_euclid(86400));
    // Civil from days (Howard Hinnant's algorithm).
    let z = days + 719468;
    let era = z.div_euclid(146097);
    let doe = z - era * 146097;
    let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146096) / 365;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = doy - (153 * mp + 2) / 5 + 1;
    let m = if mp < 10 { mp + 3 } else { mp - 9 };
    let y = yoe + era * 400 + i64::from(m <= 2);
    Some(format!("{y:04}-{m:02}-{d:02}T{:02}:{:02}:{:02}.{millis:03}Z", rest / 3600, rest % 3600 / 60, rest % 60))
}

// --- Export everything

/// A streamed zip: per project its files (`projects/<name>-<id>/<path>`), materialised from the
/// server's state, `projects.json` (what each folder holds; `missing` lists the files left out:
/// assets not on the server, and files the tree marks as conflicts, whose paths are not
/// trustworthy), `members.json` and `audit.jsonl` (every event, ending with the head). Entry
/// names are unique (also ignoring case). Recorded (`export.everything`) before it starts.
async fn export(State(a): State<Shared>, source: SourceIp, headers: HeaderMap) -> Response {
    let caller = admin!(a, headers, source);
    let projects = check!(a.readable()).clone();
    let Ok(permit) = a.exports.clone().try_acquire_owned() else { return error(StatusCode::TOO_MANY_REQUESTS, "an export is running; try again when it has finished") };
    let ids: Vec<(String, String, String)> = match sqlx::query_as("SELECT project, name, owner FROM sr_projects WHERE deleted IS NULL ORDER BY created, project").fetch_all(&a.store.pool).await {
        Ok(ids) => ids,
        Err(e) => return internal(e),
    };
    if let Err(e) = audit::record_now(&a.store.pool, &caller.actor(), "export.everything", Some(("deployment", a.store.org.as_deref().unwrap_or(""))), json!({"projects": ids.len()})).await {
        return internal(e);
    }
    let (tx, body) = channel();
    let store = a.store.clone();
    tokio::spawn(async move {
        let _permit = permit;
        let mut zip = Zip { out: Writer(tx), entries: Vec::new(), offset: 0 };
        let mut manifest = Vec::new();
        let mut folders = std::collections::HashSet::new();
        for (id, name, owner) in &ids {
            let folder = folder_name(name, id, &mut folders);
            let mut entry = json!({"id": id, "name": name, "owner": owner, "folder": format!("projects/{folder}")});
            match projects.materialise(id).await {
                Ok(m) => {
                    let mut missing = Vec::new();
                    let mut names = std::collections::HashSet::new();
                    for file in &m.files {
                        if matches!(file.content, server_projects::Content::Folder) {
                            continue;
                        }
                        // A file the tree marks as a conflict (an invalid name, a cycle, a clash)
                        // has no trustworthy path: listed as missing, never written (review H1).
                        let name = format!("projects/{folder}/{}", file.path);
                        if file.conflict.is_some() || !entry_path(&file.path) || !names.insert(name.to_lowercase()) {
                            missing.push(file.path.clone());
                            continue;
                        }
                        let bytes = match &file.content {
                            server_projects::Content::Folder => continue,
                            server_projects::Content::Text(text) => text.as_bytes().to_vec(),
                            server_projects::Content::Asset { bytes: Some(bytes), .. } => bytes.clone(),
                            server_projects::Content::Asset { bytes: None, .. } => {
                                missing.push(file.path.clone());
                                continue;
                            }
                        };
                        if !zip.file(&name, &bytes).await {
                            return;
                        }
                    }
                    entry["seq"] = json!(m.seq);
                    entry["mainFile"] = json!(m.main_file);
                    entry["missing"] = json!(missing);
                }
                // A project erased meanwhile, or one that cannot be replayed, is listed with why.
                Err(e) => entry["error"] = json!(if e.to_string() == "unknown project" { "deleted during the export" } else { "could not be read" }),
            }
            manifest.push(entry);
        }
        let members = members_json(&store, true).await.unwrap_or_default();
        let mut log = Vec::new();
        let mut after = 0i64;
        loop {
            let rows = match sqlx::query(&format!("SELECT {} FROM audit_events e LEFT JOIN accounts a ON a.account = e.actor WHERE e.seq > $1 ORDER BY e.seq LIMIT 5000", audit::EVENT_COLUMNS)).bind(after).fetch_all(&store.pool).await {
                Ok(rows) => rows,
                Err(_) => return zip.out.fail().await,
            };
            if rows.is_empty() {
                break;
            }
            for row in &rows {
                let event = audit::event_json(row);
                after = event["seq"].as_i64().unwrap_or(after);
                log.extend(event.to_string().as_bytes());
                log.push(b'\n');
            }
        }
        if let Ok(head) = audit::head(&store.pool).await {
            log.extend(format!("{}\n", json!({"head": {"seq": head.0, "hash": head.1}})).as_bytes());
        }
        let _ = zip.file("projects.json", serde_json::to_string_pretty(&manifest).unwrap_or_default().as_bytes()).await
            && zip.file("members.json", serde_json::to_string_pretty(&members).unwrap_or_default().as_bytes()).await
            && zip.file("audit.jsonl", &log).await
            && zip.finish().await;
    });
    let mut response = (StatusCode::OK, Body::from_stream(body)).into_response();
    let h = response.headers_mut();
    h.insert(header::CONTENT_TYPE, HeaderValue::from_static("application/zip"));
    h.insert(header::CACHE_CONTROL, HeaderValue::from_static("no-store"));
    h.insert(header::CONTENT_DISPOSITION, HeaderValue::from_static("attachment; filename=\"scribyra-export.zip\""));
    response
}
/// Whether a file's path is safe inside a zip entry: relative, `/`-separated, without `.` or `..`
/// segments, backslashes, colons or control characters (what `valid_path` accepts).
fn entry_path(path: &str) -> bool {
    scribyra_core::valid_path(path)
}
/// A folder name for a project: its name without path separators or control characters, and
/// the start of its ID, unique within the export.
fn folder_name(name: &str, id: &str, used: &mut std::collections::HashSet<String>) -> String {
    let clean: String = name.chars().map(|c| if c.is_control() || matches!(c, '/' | '\\' | ':' | '*' | '?' | '"' | '<' | '>' | '|') { '_' } else { c }).collect();
    let clean = clean.trim().trim_start_matches('.').chars().take(80).collect::<String>();
    let mut folder = format!("{}-{}", if clean.is_empty() { "project" } else { &clean }, &id[..8]);
    if !used.insert(folder.clone()) {
        folder = format!("{folder}-{}", &id[8..16]);
        used.insert(folder.clone());
    }
    folder
}

/// The sending half of a streamed response body.
struct Writer(tokio::sync::mpsc::Sender<Result<bytes::Bytes, std::io::Error>>);
impl Writer {
    /// `false` once the client went away.
    async fn send(&mut self, bytes: Vec<u8>) -> bool {
        self.0.send(Ok(bytes::Bytes::from(bytes))).await.is_ok()
    }
    /// Ends the body with an error, so the client sees an incomplete download rather than a
    /// complete-looking one.
    async fn fail(&mut self) {
        let _ = self.0.send(Err(std::io::Error::other("export failed"))).await;
    }
}
fn channel() -> (tokio::sync::mpsc::Sender<Result<bytes::Bytes, std::io::Error>>, impl futures_util::Stream<Item = Result<bytes::Bytes, std::io::Error>>) {
    let (tx, rx) = tokio::sync::mpsc::channel(4);
    (tx, futures_util::stream::unfold(rx, |mut rx| async move { rx.recv().await.map(|item| (item, rx)) }))
}

/// A zip archive written front to back (stored, not compressed; UTF-8 names; ZIP64 once offsets
/// or the entry count pass the classic limits). Each file's bytes are in memory, so its CRC and
/// size are known before its header.
struct Zip {
    out: Writer,
    entries: Vec<(String, u32, u64, u64)>,
    offset: u64,
}
const ZIP_TIME: u16 = 0;
const ZIP_DATE: u16 = (1 << 5) | 1; // 1980-01-01
impl Zip {
    async fn file(&mut self, name: &str, bytes: &[u8]) -> bool {
        let crc = crc32fast::hash(bytes);
        let mut header = Vec::with_capacity(30 + name.len());
        header.extend(0x04034b50u32.to_le_bytes());
        header.extend(45u16.to_le_bytes());
        header.extend(0x0800u16.to_le_bytes());
        header.extend(0u16.to_le_bytes());
        header.extend(ZIP_TIME.to_le_bytes());
        header.extend(ZIP_DATE.to_le_bytes());
        header.extend(crc.to_le_bytes());
        header.extend((bytes.len() as u32).to_le_bytes());
        header.extend((bytes.len() as u32).to_le_bytes());
        header.extend((name.len() as u16).to_le_bytes());
        header.extend(0u16.to_le_bytes());
        header.extend(name.as_bytes());
        let at = self.offset;
        self.offset += header.len() as u64 + bytes.len() as u64;
        self.entries.push((name.to_owned(), crc, bytes.len() as u64, at));
        self.out.send(header).await && self.out.send(bytes.to_vec()).await
    }
    async fn finish(&mut self) -> bool {
        let start = self.offset;
        let mut cd = Vec::new();
        for (name, crc, size, at) in &self.entries {
            let far = *at >= u32::MAX as u64;
            let extra: Vec<u8> = if far { [1u16.to_le_bytes().to_vec(), 8u16.to_le_bytes().to_vec(), at.to_le_bytes().to_vec()].concat() } else { Vec::new() };
            cd.extend(0x02014b50u32.to_le_bytes());
            cd.extend(0x032du16.to_le_bytes());
            cd.extend(45u16.to_le_bytes());
            cd.extend(0x0800u16.to_le_bytes());
            cd.extend(0u16.to_le_bytes());
            cd.extend(ZIP_TIME.to_le_bytes());
            cd.extend(ZIP_DATE.to_le_bytes());
            cd.extend(crc.to_le_bytes());
            cd.extend((*size as u32).to_le_bytes());
            cd.extend((*size as u32).to_le_bytes());
            cd.extend((name.len() as u16).to_le_bytes());
            cd.extend((extra.len() as u16).to_le_bytes());
            // Comment length, disk number, internal attributes.
            cd.extend([0u8; 6]);
            cd.extend((0o100644u32 << 16).to_le_bytes());
            cd.extend((if far { u32::MAX } else { *at as u32 }).to_le_bytes());
            cd.extend(name.as_bytes());
            cd.extend(extra);
        }
        let (count, size) = (self.entries.len() as u64, cd.len() as u64);
        let zip64 = count >= 0xffff || start >= u32::MAX as u64 || size >= u32::MAX as u64;
        if zip64 {
            let end64 = start + size;
            cd.extend(0x06064b50u32.to_le_bytes());
            cd.extend(44u64.to_le_bytes());
            cd.extend(0x032du16.to_le_bytes());
            cd.extend(45u16.to_le_bytes());
            cd.extend([0u8; 8]);
            cd.extend(count.to_le_bytes());
            cd.extend(count.to_le_bytes());
            cd.extend(size.to_le_bytes());
            cd.extend(start.to_le_bytes());
            cd.extend(0x07064b50u32.to_le_bytes());
            cd.extend(0u32.to_le_bytes());
            cd.extend(end64.to_le_bytes());
            cd.extend(1u32.to_le_bytes());
        }
        cd.extend(0x06054b50u32.to_le_bytes());
        cd.extend([0u8; 4]);
        let short = |v: u64| if zip64 { 0xffffu16 } else { v as u16 };
        let long = |v: u64| if zip64 { u32::MAX } else { v as u32 };
        cd.extend(short(count).to_le_bytes());
        cd.extend(short(count).to_le_bytes());
        cd.extend(long(size).to_le_bytes());
        cd.extend(long(start).to_le_bytes());
        cd.extend(0u16.to_le_bytes());
        self.out.send(cd).await
    }
}

// --- Settings

/// The deployment's policy as configured, never a secret (no client secret files, no keys).
async fn settings(State(a): State<Shared>, source: SourceIp, headers: HeaderMap) -> Response {
    admin!(a, headers, source);
    let Some(d) = a.store.config.deployment.as_ref() else { return error(StatusCode::NOT_FOUND, "this service has no deployment") };
    let providers: Vec<Value> = d
        .providers
        .iter()
        .map(|p| {
            json!({"id": p.id, "label": p.label, "issuer": p.issuer, "emailDomains": p.email_domains, "groupsClaim": p.groups_claim, "adminGroups": p.admin_groups, "memberGroups": p.member_groups,
                   "guest": p.guest.as_ref().map(|g| json!({"claim": g.claim, "equals": g.equals})), "offlineAccess": p.offline_access, "sessionHours": p.session_hours, "recheckMinutes": p.recheck_minutes})
        })
        .collect();
    let policy = scribyra_core::blob::hash(serde_json::to_string(d).unwrap_or_default().as_bytes());
    ok_json(
        StatusCode::OK,
        json!({
            "name": d.name, "encryption": d.encryption.as_str(), "offline": d.offline, "compile": d.compile, "linkSharing": d.link_sharing, "guests": d.guests,
            "admins": d.admins, "providers": providers, "quotas": d.quotas, "auditRetentionDays": d.audit_retention_days, "compileLimits": d.compile_limits,
            "texlive": d.texlive.is_some(), "policy": policy,
        }),
    )
}

/// The admin routes; merged into [`crate::service::router`].
pub fn routes(a: Shared) -> Router {
    Router::new()
        .route("/v1/admin/members", get(members))
        .route("/v1/admin/members/{account}/role", put(set_role))
        .route("/v1/admin/members/{account}/disable", post(disable))
        .route("/v1/admin/members/{account}/unblock", post(unblock))
        .route("/v1/admin/members/{account}/remove", post(remove))
        .route("/v1/admin/projects", get(projects))
        .route("/v1/admin/projects/{project}", axum::routing::delete(delete))
        .route("/v1/admin/projects/{project}/open", post(open))
        .route("/v1/admin/projects/{project}/edit", post(edit))
        .route("/v1/admin/projects/{project}/owner", post(transfer))
        .route("/v1/admin/export", get(export))
        .route("/v1/admin/audit", get(audit_log))
        .route("/v1/admin/audit/export", get(audit_export))
        .route("/v1/admin/settings", get(settings))
        .with_state(a)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn csv_quotes_every_field_and_defuses_formulas() {
        let row = csv_row(&json!({"seq": 3, "time": 0, "actor": "system", "actorName": "=cmd|' /C calc'!A0", "action": "a.b", "detail": {"x": "y\"z"}}));
        assert!(row.starts_with("\"3\",\"1970-01-01T00:00:00.000Z\",\"system\",\"'=cmd|' /C calc'!A0\""), "{row}");
        assert!(row.contains("\"{\"\"x\"\":\"\"y\\\"\"z\"\"}\""), "{row}");
    }
    #[test]
    fn times_are_rfc3339() {
        assert_eq!(chrono_like(1_795_000_000_123).unwrap(), "2026-11-18T11:06:40.123Z");
        assert_eq!(chrono_like(951_782_400_000).unwrap(), "2000-02-29T00:00:00.000Z");
    }
    #[test]
    fn folder_names_are_safe_and_unique() {
        let mut used = Default::default();
        let id = "ab".repeat(32);
        assert_eq!(folder_name("../Paper: v2", &id, &mut used), "_Paper_ v2-abababab");
        assert_eq!(folder_name("../Paper: v2", &id, &mut used), "_Paper_ v2-abababab-abababab");
        assert_eq!(folder_name(" .. ", &id, &mut used), "project-abababab");
    }
}
