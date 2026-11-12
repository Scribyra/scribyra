use axum::{
    Router,
    body::Body,
    body::Bytes,
    extract::{
        DefaultBodyLimit, Path, State,
        ws::{Message, WebSocket, WebSocketUpgrade},
    },
    http::Request,
    http::{HeaderMap, HeaderValue, Method, StatusCode, header},
    middleware::{self, Next},
    response::IntoResponse,
    response::Response,
    routing::get,
};
use futures_util::{SinkExt, StreamExt};
use rusqlite::{Connection, OptionalExtension, params};
use std::{
    collections::HashMap,
    sync::{Arc, Mutex},
};
use tokio::sync::broadcast;
use tower_http::cors::CorsLayer;
use yrs::{Doc, ReadTxn, StateVector, Transact, Update, updates::decoder::Decode};

async fn observe_http(request: Request<Body>, next: Next) -> Response {
    if !request.uri().path().starts_with("/rooms/") {
        return next.run(request).await;
    }
    let mut observation = scribyra_core::telemetry::native::global()
        .begin(scribyra_core::telemetry::Operation::SyncHttp, None);
    let response = next.run(request).await;
    let status = response.status().as_u16();
    if status >= 400 {
        observation.error(match status {
            401 | 403 => "permission_denied",
            404 => "not_found",
            400 | 405 | 413 => "invalid_request",
            _ => "unknown",
        });
    } else {
        observation.success();
    }
    response
}
type Shared = Arc<Mutex<Store>>;
struct Store {
    db: Connection,
    rooms: HashMap<String, broadcast::Sender<Vec<u8>>>,
}
fn merge(previous: &[u8], incoming: &[u8]) -> Result<Vec<u8>, String> {
    let doc = Doc::new();
    {
        let mut txn = doc.transact_mut();
        if !previous.is_empty() {
            txn.apply_update(Update::decode_v1(previous).map_err(|e| e.to_string())?)
                .map_err(|e| e.to_string())?;
        }
        txn.apply_update(Update::decode_v1(incoming).map_err(|e| e.to_string())?)
            .map_err(|e| e.to_string())?;
    }
    let result = doc
        .transact()
        .encode_state_as_update_v1(&StateVector::default());
    if result.len() > 64 * 1024 * 1024 {
        return Err("Room exceeds 64 MiB".into());
    }
    Ok(result)
}
fn current(db: &Connection, room: &str) -> Result<Vec<u8>, rusqlite::Error> {
    Ok(db
        .query_row("SELECT state FROM rooms WHERE id=?1", [room], |row| {
            row.get(0)
        })
        .optional()?
        .unwrap_or_default())
}
const ORIGINS: [&str; 6] = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
    "http://localhost:4173",
    "http://127.0.0.1:4173",
    "http://127.0.0.1:8080",
    "http://localhost:8080",
];
fn valid_room(room: &str) -> bool {
    !room.is_empty()
        && room.len() <= 64
        && room
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}
fn origin_allowed(headers: &HeaderMap) -> bool {
    headers
        .get("origin")
        .is_none_or(|origin| origin.to_str().is_ok_and(|value| ORIGINS.contains(&value)))
}
fn validate_blob_request(room: &str, hash: &str, headers: &HeaderMap) -> Result<(), StatusCode> {
    if !origin_allowed(headers) {
        return Err(StatusCode::FORBIDDEN);
    }
    if !valid_room(room) || !scribyra_core::blob::valid_hash(hash) {
        return Err(StatusCode::BAD_REQUEST);
    }
    Ok(())
}
async fn get_blob(
    Path((room, hash)): Path<(String, String)>,
    State(store): State<Shared>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, StatusCode> {
    validate_blob_request(&room, &hash, &headers)?;
    let guard = store
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let bytes: Option<Vec<u8>> = guard
        .db
        .query_row(
            "SELECT content FROM blobs WHERE room=?1 AND hash=?2",
            params![room, hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok((
        [
            (header::CONTENT_TYPE, "application/octet-stream"),
            (header::X_CONTENT_TYPE_OPTIONS, "nosniff"),
        ],
        bytes.ok_or(StatusCode::NOT_FOUND)?,
    ))
}
async fn put_blob(
    Path((room, hash)): Path<(String, String)>,
    State(store): State<Shared>,
    headers: HeaderMap,
    bytes: Bytes,
) -> Result<StatusCode, StatusCode> {
    validate_blob_request(&room, &hash, &headers)?;
    if !scribyra_core::blob::verify(&hash, &bytes) {
        return Err(StatusCode::BAD_REQUEST);
    }
    let guard = store
        .lock()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    let exists: Option<i64> = guard
        .db
        .query_row(
            "SELECT 1 FROM blobs WHERE room=?1 AND hash=?2",
            params![room, hash],
            |row| row.get(0),
        )
        .optional()
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if exists.is_some() {
        return Ok(StatusCode::NO_CONTENT);
    }
    let size: i64 = guard
        .db
        .query_row(
            "SELECT COALESCE(SUM(length(content)),0) FROM blobs WHERE room=?1",
            [&room],
            |row| row.get(0),
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    if size + bytes.len() as i64 > 256 * 1024 * 1024 {
        return Err(StatusCode::PAYLOAD_TOO_LARGE);
    }
    guard
        .db
        .execute(
            "INSERT INTO blobs(room,hash,content) VALUES(?1,?2,?3)",
            params![room, hash, bytes.as_ref()],
        )
        .map_err(|_| StatusCode::INTERNAL_SERVER_ERROR)?;
    Ok(StatusCode::CREATED)
}
async fn upgrade(
    ws: WebSocketUpgrade,
    Path(room): Path<String>,
    State(store): State<Shared>,
    headers: HeaderMap,
) -> impl IntoResponse {
    if !valid_room(&room) {
        return StatusCode::BAD_REQUEST.into_response();
    }
    if !origin_allowed(&headers) {
        return StatusCode::FORBIDDEN.into_response();
    }
    ws.max_message_size(65 * 1024 * 1024)
        .on_upgrade(move |socket| session(socket, store, room))
        .into_response()
}
async fn session(socket: WebSocket, store: Shared, room: String) {
    let mut connection_observation = scribyra_core::telemetry::native::global()
        .begin(scribyra_core::telemetry::Operation::SyncConnect, None);
    let parent = connection_observation.context();
    let initialized = (|| {
        let mut s = store.lock().ok()?;
        let state = current(&s.db, &room).ok()?;
        let tx = s
            .rooms
            .entry(room.clone())
            .or_insert_with(|| broadcast::channel(256).0)
            .clone();
        let rx = tx.subscribe();
        Some((state, tx, rx))
    })();
    let Some((initial, tx, mut rx)) = initialized else {
        connection_observation.error("unknown");
        return;
    };
    let (mut output, mut input) = socket.split();
    if !initial.is_empty() {
        let mut frame = vec![0];
        frame.extend(initial);
        if output.send(Message::Binary(frame.into())).await.is_err() {
            return;
        }
    }
    loop {
        tokio::select! {
            incoming = input.next() => {
                let Some(Ok(message)) = incoming else { break; };
                match message {
                    Message::Binary(frame) if frame.len() > 1 => {
                        if frame[0] == 0 {
                            let mut observation=scribyra_core::telemetry::native::global().begin(scribyra_core::telemetry::Operation::Sync,parent.as_ref());
                            let result = (|| -> Result<(), String> {
                                let s = store.lock().map_err(|_| "Store lock failed")?;
                                let previous = current(&s.db, &room).map_err(|e| e.to_string())?;
                                let merged = merge(&previous, &frame[1..]).map_err(|error|{observation.error("invalid_request");error})?;
                                s.db.execute("INSERT INTO rooms(id,state) VALUES(?1,?2) ON CONFLICT(id) DO UPDATE SET state=excluded.state", params![room, merged]).map_err(|e| e.to_string())?;
                                // Publish while holding the persistence lock, preserving update order.
                                let _ = tx.send(frame.to_vec());
                                Ok(())
                            })();
                            if let Err(error) = result { observation.error("unknown");eprintln!("Rejected update: {error}"); break; }
                            if output.send(Message::Binary(vec![2].into())).await.is_err() { observation.error("browser_disconnected");break; }observation.success();
                        } else if frame[0] == 1 && frame.len() <= 64 * 1024 {
                            let _ = tx.send(frame.to_vec());
                        } else { break; }
                    }
                    Message::Ping(payload) => { if output.send(Message::Pong(payload)).await.is_err() { break; } }
                    Message::Close(_) => break,
                    _ => break,
                }
            }
            outgoing = rx.recv() => {
                // A lagged client reconnects and receives the complete durable state.
                let Ok(frame) = outgoing else { break; };
                if output.send(Message::Binary(frame.into())).await.is_err() { break; }
            }
        }
    }
}
#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    scribyra_core::telemetry::native::initialize(scribyra_core::telemetry::Runtime::SyncService);
    let db = Connection::open(
        std::env::var("SCRIBYRA_SYNC_DB").unwrap_or_else(|_| "scribyra-sync.sqlite".into()),
    )?;
    db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; CREATE TABLE IF NOT EXISTS rooms(id TEXT PRIMARY KEY, state BLOB NOT NULL); CREATE TABLE IF NOT EXISTS blobs(room TEXT NOT NULL, hash TEXT NOT NULL, content BLOB NOT NULL, PRIMARY KEY(room,hash));")?;
    let shared = Arc::new(Mutex::new(Store {
        db,
        rooms: HashMap::new(),
    }));
    let app = Router::new()
        .route("/health", get(|| async { "Scribyra loopback sync demo" }))
        .route("/rooms/{room}", get(upgrade))
        .route("/rooms/{room}/blobs/{hash}", get(get_blob).put(put_blob))
        .layer(DefaultBodyLimit::max(scribyra_core::blob::MAX_BLOB_BYTES))
        .layer(
            CorsLayer::new()
                .allow_origin(ORIGINS.map(|s| s.parse::<HeaderValue>().unwrap()))
                .allow_methods([Method::GET, Method::HEAD, Method::PUT, Method::OPTIONS])
                .allow_headers([header::CONTENT_TYPE]),
        )
        .layer(middleware::from_fn(observe_http))
        .with_state(shared);
    let port = std::env::var("SCRIBYRA_SYNC_PORT")
        .unwrap_or_else(|_| "8787".into())
        .parse::<u16>()?;
    let bind = format!("127.0.0.1:{port}");
    let listener = tokio::net::TcpListener::bind(bind).await?;
    let bind = listener.local_addr()?;
    println!("Scribyra sync demo listening on {bind}; no authentication. Keep this service local.");
    axum::serve(listener, app).await?;
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    use yrs::{GetString, Text};
    #[test]
    fn merges_concurrent_edits_and_restores_state() {
        let a = Doc::with_client_id(1);
        let b = Doc::with_client_id(2);
        a.get_or_insert_text("text")
            .insert(&mut a.transact_mut(), 0, "alpha");
        b.get_or_insert_text("text")
            .insert(&mut b.transact_mut(), 0, "beta");
        let ua = a
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        let ub = b
            .transact()
            .encode_state_as_update_v1(&StateVector::default());
        assert_eq!(merge(&ua, &ub).unwrap(), merge(&ub, &ua).unwrap());
        let merged = merge(&ua, &ub).unwrap();
        let restored = Doc::new();
        restored
            .transact_mut()
            .apply_update(Update::decode_v1(&merged).unwrap())
            .unwrap();
        let text = restored
            .get_or_insert_text("text")
            .get_string(&restored.transact());
        assert!(text.contains("alpha") && text.contains("beta"));
        assert_eq!(merge(&merged, &ua).unwrap(), merged);
    }
    #[test]
    fn rejects_invalid_updates() {
        assert!(merge(&[], &[255, 255, 255]).is_err());
    }
}
