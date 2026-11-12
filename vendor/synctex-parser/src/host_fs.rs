//! A memory-only caller must never inspect paths supplied by compiler metadata.
#[cfg(not(feature = "memory-only"))]
pub use std::fs::*;
#[cfg(feature = "memory-only")]
pub use std::fs::{File, Metadata};
#[cfg(feature = "memory-only")]
use std::{
    io,
    path::{Path, PathBuf},
};
#[cfg(feature = "memory-only")]
pub fn canonicalize(_path: impl AsRef<Path>) -> io::Result<PathBuf> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem access disabled",
    ))
}
#[cfg(feature = "memory-only")]
pub fn metadata(_path: impl AsRef<Path>) -> io::Result<Metadata> {
    Err(io::Error::new(
        io::ErrorKind::Unsupported,
        "filesystem access disabled",
    ))
}
#[cfg(feature = "memory-only")]
pub fn symlink_metadata(path: impl AsRef<Path>) -> io::Result<Metadata> {
    metadata(path)
}
