//! Blob storage backend — content-addressed binary blob persistence used by
//! the media offload pipeline (`blob::BlobService`).
//!
//! This module is the surviving fragment of the retired record/replay layer:
//! `AgentRecord` / `AgentRecords` / `FileSystemAgentRecordPersistence` /
//! `InMemoryAgentRecordPersistence` and their tests were deleted (2026-08-12)
//! as dead code — state tracking now lives in `replay/` and SQLite
//! persistence. `BlobStore` is kept here because `blob::BlobService` imports
//! it via `crate::records::BlobStore`.

use std::path::PathBuf;

/// BlobStore — stores large binary data referenced by media blobs.
pub struct BlobStore {
    blobs_dir: PathBuf,
}

impl BlobStore {
    /// Create a new BlobStore rooted at `blobs_dir`.
    pub fn new(blobs_dir: &str) -> Self {
        Self {
            blobs_dir: PathBuf::from(blobs_dir),
        }
    }

    /// Store a blob and return its reference key.
    pub fn store(&self, key: &str, data: &[u8]) -> Result<(), String> {
        std::fs::create_dir_all(&self.blobs_dir)
            .map_err(|e| format!("Failed to create blobs dir: {e}"))?;
        let path = self.blobs_dir.join(sanitize_blob_key(key));
        std::fs::write(&path, data).map_err(|e| format!("Failed to write blob: {e}"))?;
        Ok(())
    }

    /// Read a blob by key.
    pub fn read(&self, key: &str) -> Result<Vec<u8>, String> {
        let path = self.blobs_dir.join(sanitize_blob_key(key));
        std::fs::read(&path).map_err(|e| format!("Failed to read blob: {e}"))
    }

    /// Delete a blob by key.
    pub fn delete(&self, key: &str) -> Result<(), String> {
        let path = self.blobs_dir.join(sanitize_blob_key(key));
        if path.exists() {
            std::fs::remove_file(&path).map_err(|e| format!("Failed to delete blob: {e}"))?;
        }
        Ok(())
    }
}

fn sanitize_blob_key(key: &str) -> String {
    key.replace('/', "__").replace('\\', "_")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_blob_store() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_str().unwrap());

        store.store("test-key", b"hello world").unwrap();
        let data = store.read("test-key").unwrap();
        assert_eq!(data, b"hello world");

        store.delete("test-key").unwrap();
        assert!(store.read("test-key").is_err());
    }

    #[test]
    fn test_blob_store_sanitizes_key() {
        let dir = tempfile::tempdir().unwrap();
        let store = BlobStore::new(dir.path().to_str().unwrap());

        store.store("path/to/blob", b"data").unwrap();
        let data = store.read("path/to/blob").unwrap();
        assert_eq!(data, b"data");
    }
}
