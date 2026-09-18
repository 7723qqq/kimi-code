//! File-backed MCP OAuth credential store.

use std::path::PathBuf;

use serde::Serialize;
use serde::de::DeserializeOwned;

use super::crypto::{self, EncryptedBlob};

/// One encrypted JSON document per credential key under `root`.
///
/// v2 keeps the same records in the `credentials/mcp` document scope
/// (`app/mcpConfig/oauthStore.ts`); a directory of atomically-replaced files is
/// the Rust equivalent.
pub struct McpOAuthFileStore {
    root: PathBuf,
}

impl McpOAuthFileStore {
    pub fn new(root: impl Into<PathBuf>) -> Self {
        Self { root: root.into() }
    }

    fn path(&self, key: &str) -> PathBuf {
        self.root.join(format!("{key}.json"))
    }

    /// Read and decrypt one entry. Any failure — missing file, malformed
    /// envelope, failed authentication tag, unparseable plaintext — reads as
    /// "no credentials", exactly like v2's catch-and-return-undefined.
    pub fn read<T: DeserializeOwned>(&self, key: &str) -> Option<T> {
        let raw = std::fs::read_to_string(self.path(key)).ok()?;
        let blob: EncryptedBlob = serde_json::from_str(&raw).ok()?;
        let plaintext = crypto::decrypt(&blob).ok()?;
        serde_json::from_str(&plaintext).ok()
    }

    /// Encrypt and atomically replace one entry.
    pub fn write(&self, key: &str, value: &impl Serialize) -> Result<(), String> {
        std::fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
        let plaintext = serde_json::to_string(value).map_err(|e| e.to_string())?;
        let blob = crypto::encrypt(&plaintext)?;
        let body = serde_json::to_vec(&blob).map_err(|e| e.to_string())?;
        let path = self.path(key);
        // A per-write random temp name: a fixed `.json.tmp` lets two processes
        // writing the same key interleave and clobber each other's staging
        // file before either rename lands.
        let tmp = path.with_extension(format!("json.tmp.{}", fastrand::u64(..)));
        // Both legs clean the staging file up: a half-written envelope would
        // otherwise linger next to the live credentials.
        if let Err(e) = write_private(&tmp, &body) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        if let Err(e) = std::fs::rename(&tmp, &path) {
            let _ = std::fs::remove_file(&tmp);
            return Err(e.to_string());
        }
        Ok(())
    }

    /// Remove one entry; `false` when it was not there.
    pub fn remove(&self, key: &str) -> Result<bool, String> {
        match std::fs::remove_file(self.path(key)) {
            Ok(()) => Ok(true),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(false),
            Err(e) => Err(e.to_string()),
        }
    }

    /// Stored keys (without the `.json` suffix), optionally filtered by prefix.
    pub fn list(&self, prefix: Option<&str>) -> Vec<String> {
        let Ok(entries) = std::fs::read_dir(&self.root) else {
            return Vec::new();
        };
        let mut keys: Vec<String> = entries
            .filter_map(|entry| entry.ok())
            .filter_map(|entry| {
                let name = entry.file_name().to_string_lossy().into_owned();
                name.strip_suffix(".json").map(|key| key.to_string())
            })
            .filter(|key| prefix.is_none_or(|prefix| key.starts_with(prefix)))
            .collect();
        keys.sort();
        keys
    }
}

/// Write a credential file with owner-only permissions from the moment the
/// inode exists. Mirrors `server/auth.rs`'s `write_private`: the mode is set
/// before any byte lands, so a shared volume never sees a world-readable
/// secret, and the rename that follows carries the mode with the file.
fn write_private(path: &std::path::Path, bytes: &[u8]) -> Result<(), std::io::Error> {
    use std::io::Write;

    let mut file = std::fs::File::create(path)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
    }
    #[cfg(not(unix))]
    {
        // No POSIX mode bits to set: the file inherits the directory's ACL.
    }
    file.write_all(bytes)?;
    file.sync_all()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde::{Deserialize, Serialize};

    #[derive(Debug, PartialEq, Eq, Serialize, Deserialize)]
    struct Tokens {
        access_token: String,
        refresh_token: String,
    }

    fn tokens(access: &str) -> Tokens {
        Tokens {
            access_token: access.into(),
            refresh_token: "refresh".into(),
        }
    }

    #[test]
    fn test_store_round_trip_list_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        let store = McpOAuthFileStore::new(dir.path());
        store.write("srv-1", &tokens("a")).unwrap();
        store.write("srv-2", &tokens("b")).unwrap();

        assert_eq!(store.read::<Tokens>("srv-1"), Some(tokens("a")));
        assert_eq!(store.read::<Tokens>("srv-2"), Some(tokens("b")));
        assert_eq!(store.read::<Tokens>("missing"), None);
        assert_eq!(
            store.list(None),
            vec!["srv-1".to_string(), "srv-2".to_string()]
        );
        assert_eq!(store.list(Some("srv-1")), vec!["srv-1".to_string()]);

        assert!(store.remove("srv-1").unwrap());
        assert!(!store.remove("srv-1").unwrap());
        assert_eq!(store.read::<Tokens>("srv-1"), None);
    }

    /// The access token must never appear in plaintext on disk.
    #[test]
    fn test_store_encrypts_at_rest() {
        let dir = tempfile::tempdir().unwrap();
        let store = McpOAuthFileStore::new(dir.path());
        store.write("srv", &tokens("super-secret")).unwrap();

        let raw = std::fs::read_to_string(dir.path().join("srv.json")).unwrap();
        assert!(!raw.contains("super-secret"), "credential leaked: {raw}");
        let blob: EncryptedBlob = serde_json::from_str(&raw).unwrap();
        assert_eq!(blob.iv.len(), 24);
        assert_eq!(blob.tag.len(), 32);
    }

    /// A tampered or truncated envelope reads as "no credentials" instead of
    /// panicking (v2 catches and returns undefined).
    #[test]
    fn test_corrupt_entry_reads_as_missing() {
        let dir = tempfile::tempdir().unwrap();
        let store = McpOAuthFileStore::new(dir.path());
        store.write("srv", &tokens("a")).unwrap();
        std::fs::write(dir.path().join("srv.json"), b"not json").unwrap();
        assert_eq!(store.read::<Tokens>("srv"), None);
    }

    /// The credential file must not be readable by group or other.
    #[cfg(unix)]
    #[test]
    fn test_store_writes_owner_only_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let dir = tempfile::tempdir().unwrap();
        let store = McpOAuthFileStore::new(dir.path());
        store.write("srv", &tokens("a")).unwrap();

        let mode = std::fs::metadata(dir.path().join("srv.json"))
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(
            mode & 0o077,
            0,
            "credential file is group/other readable: {mode:#o}"
        );
    }
}
