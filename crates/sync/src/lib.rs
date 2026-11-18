//! `scribyra-sync`: optional opaque object store and live relay.
//!
//! Metadata lives in PostgreSQL (migrations in `migrations/`, applied at startup); bytes live
//! behind [`blobs::BlobStore`] (filesystem or S3-compatible).
pub mod blobs;
pub mod config;
pub mod deploy;
pub mod listener;
pub mod migrate_sqlite;
pub mod org;
pub mod service;
pub mod sso;
pub mod store;
