//! `scribyra-sync`: optional opaque object store and live relay, and an organisation deployment's
//! service (sign-in, end-to-end organisation routes, server-readable projects).
//!
//! Metadata lives in PostgreSQL (migrations in `migrations/`, applied at startup); bytes live
//! behind [`blobs::BlobStore`] (filesystem or S3-compatible).
pub mod admin;
pub mod audit;
pub mod blobs;
pub mod claims;
pub mod compiles;
pub mod config;
pub mod deploy;
pub mod listener;
pub mod metrics;
pub mod migrate_sqlite;
pub mod org;
pub mod server_projects;
pub mod service;
pub mod sso;
pub mod store;
pub mod update_check;
