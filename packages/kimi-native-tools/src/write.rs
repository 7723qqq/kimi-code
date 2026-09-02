/// Write tool — overwrite or append to a file.
///
/// Creates parent directories automatically.
/// Mirrors `packages/agent-core-v2/src/agent/tools/os/write/write.ts`.
use napi_derive::napi;
use std::fs;
use std::io::Write;
use std::path::Path;
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{SystemTime, UNIX_EPOCH};

/// POSIX stat mode bits.
#[cfg(unix)]
const S_IFMT: u32 = 0o170000;
#[cfg(unix)]
const S_IFDIR: u32 = 0o040000;

/// Result of a write operation.
#[derive(Debug, Clone)]
#[napi(object)]
pub struct WriteResult {
    pub bytes_written: i32,
    pub error: Option<String>,
    /// Machine-readable error class — `io` / `parent_not_dir` / `panic`.
    /// Every kind is the native writer's final verdict; the TS caller must
    /// not silently re-run its own write path.
    pub error_kind: Option<String>,
}

impl WriteResult {
    /// Build an error result carrying a machine-readable kind.
    fn err(kind: &str, message: String) -> Self {
        Self {
            bytes_written: 0,
            error: Some(message),
            error_kind: Some(kind.to_string()),
        }
    }
}

/// Write mode.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum WriteMode {
    Overwrite,
    Append,
}

/// Write content to a file.
///
/// Behavior:
///   - Creates the file if it does not exist.
///   - Creates missing parent directories automatically.
///   - `mode`: 'overwrite' (default) or 'append'.
///   - `atomic`: when `true` and `mode` is `overwrite`, writes via a temporary
///     file in the same directory followed by rename. This prevents a crash
///     from leaving a truncated destination. Symlink targets are still written
///     through in-place so the link itself is preserved.
///   - Returns the number of UTF-8 bytes written.
pub fn write_file(path: &str, content: &str, mode: WriteMode, atomic: bool) -> WriteResult {
    if mode == WriteMode::Overwrite && atomic {
        return write_file_atomic(path, content);
    }
    write_file_in_place(path, content, mode)
}

/// Non-atomic write: plain truncating `write_all` (or `O_APPEND` for append),
/// matching the TS `writeText` / `appendText` semantics.
fn write_file_in_place(path: &str, content: &str, mode: WriteMode) -> WriteResult {
    let file_path = Path::new(path);

    // Ensure parent directory exists.
    if let Some(parent) = file_path.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = ensure_parent_directory(parent) {
                let kind = if e.starts_with("Parent path is not a directory") {
                    "parent_not_dir"
                } else {
                    "io"
                };
                return WriteResult::err(kind, e);
            }
        }
    }

    // Open file with appropriate mode.
    let file = match mode {
        WriteMode::Overwrite => fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(true)
            .open(file_path),
        WriteMode::Append => fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(file_path),
    };

    let mut file = match file {
        Ok(f) => f,
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                return WriteResult::err(
                    "io",
                    format!("Failed to write {}: parent directory does not exist.", path),
                );
            }
            return WriteResult::err("io", e.to_string());
        }
    };

    match file.write_all(content.as_bytes()) {
        Ok(()) => WriteResult {
            bytes_written: content.len() as i32,
            error: None,
            error_kind: None,
        },
        Err(e) => WriteResult::err("io", e.to_string()),
    }
}

/// Atomic overwrite: write to a unique temporary file in the destination
/// directory, fsync it, preserve the existing file's permissions when present,
/// then rename over the destination.
fn write_file_atomic(path: &str, content: &str) -> WriteResult {
    let file_path = Path::new(path);

    // Ensure parent directory exists.
    if let Some(parent) = file_path.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = ensure_parent_directory(parent) {
                let kind = if e.starts_with("Parent path is not a directory") {
                    "parent_not_dir"
                } else {
                    "io"
                };
                return WriteResult::err(kind, e);
            }
        }
    }

    // Preserve symlink and special-file semantics: atomic rename is only safe
    // for regular files. Symlinks are written through in-place; FIFOs, devices,
    // sockets, etc. also keep the legacy path.
    if let Ok(meta) = fs::symlink_metadata(file_path) {
        let file_type = meta.file_type();
        if file_type.is_symlink() || !file_type.is_file() {
            return write_file_in_place(path, content, WriteMode::Overwrite);
        }
    }

    let file_name = file_path
        .file_name()
        .and_then(|s| s.to_str())
        .unwrap_or("file");
    let temp_name = format!(".{}.{}.tmp", file_name, unique_suffix());
    let temp_path = file_path.with_file_name(&temp_name);

    let result = (|| -> std::io::Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temp_path)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        drop(file);

        // Best-effort permission preservation; a platform that cannot set
        // permissions should still complete the write.
        if let Ok(meta) = fs::metadata(file_path) {
            let _ = fs::set_permissions(&temp_path, meta.permissions());
        }

        fs::rename(&temp_path, file_path)?;
        Ok(())
    })();

    match result {
        Ok(()) => WriteResult {
            bytes_written: content.len() as i32,
            error: None,
            error_kind: None,
        },
        Err(e) => {
            let _ = fs::remove_file(&temp_path);
            WriteResult::err("io", e.to_string())
        }
    }
}

fn unique_suffix() -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let count = COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{nanos:x}-{}-{count}", std::process::id())
}

fn ensure_parent_directory(parent: &Path) -> Result<(), String> {
    match fs::metadata(parent) {
        Ok(meta) => {
            // Check if it's a directory.
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                let mode = meta.permissions().mode();
                if (mode & S_IFMT) != S_IFDIR {
                    return Err(format!(
                        "Parent path is not a directory: {}",
                        parent.display()
                    ));
                }
            }
            #[cfg(windows)]
            {
                if !meta.is_dir() {
                    return Err(format!(
                        "Parent path is not a directory: {}",
                        parent.display()
                    ));
                }
            }
            Ok(())
        }
        Err(e) => {
            if e.kind() == std::io::ErrorKind::NotFound {
                // Create parent directories recursively.
                fs::create_dir_all(parent).map_err(|e| e.to_string())
            } else {
                // Other errors — skip the check and let the write surface the error.
                Ok(())
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Read;
    use tempfile::TempDir;

    #[test]
    fn test_write_new_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");
        let result = write_file(
            path.to_str().unwrap(),
            "hello world",
            WriteMode::Overwrite,
            true,
        );
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 11);

        let mut content = String::new();
        fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_write_append() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");

        write_file(path.to_str().unwrap(), "hello ", WriteMode::Overwrite, true);
        let result = write_file(path.to_str().unwrap(), "world", WriteMode::Append, false);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 5);

        let mut content = String::new();
        fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "hello world");
    }

    #[test]
    fn test_write_creates_parent_dirs() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("a").join("b").join("c").join("test.txt");
        let result = write_file(path.to_str().unwrap(), "nested", WriteMode::Overwrite, true);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 6);

        let mut content = String::new();
        fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "nested");
    }

    #[test]
    fn test_write_overwrite_truncates() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");

        write_file(
            path.to_str().unwrap(),
            "long content here",
            WriteMode::Overwrite,
            true,
        );
        let result = write_file(path.to_str().unwrap(), "short", WriteMode::Overwrite, true);
        assert!(result.error.is_none());

        let mut content = String::new();
        fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "short");
    }

    #[test]
    fn test_write_utf8_bytes() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("test.txt");
        // "你好" is 6 bytes in UTF-8.
        let result = write_file(path.to_str().unwrap(), "你好", WriteMode::Overwrite, true);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 6);
    }

    #[test]
    fn test_write_error_kinds() {
        let dir = TempDir::new().unwrap();

        // Parent path is an existing FILE, not a directory.
        let blocker = dir.path().join("blocker");
        fs::write(&blocker, b"x").unwrap();
        let target = blocker.join("child.txt");
        let result = write_file(target.to_str().unwrap(), "data", WriteMode::Overwrite, true);
        assert_eq!(result.error_kind.as_deref(), Some("parent_not_dir"));
        assert!(result.error.unwrap().contains("not a directory"));

        // Success carries no kind.
        let ok = dir.path().join("ok.txt");
        let result = write_file(ok.to_str().unwrap(), "data", WriteMode::Overwrite, true);
        assert!(result.error.is_none());
        assert_eq!(result.error_kind, None);
    }

    #[test]
    fn test_write_append_creates_new_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("new.txt");

        // Append mode also creates the file when it does not exist.
        let result = write_file(path.to_str().unwrap(), "first", WriteMode::Append, false);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 5);

        let mut content = String::new();
        fs::File::open(&path)
            .unwrap()
            .read_to_string(&mut content)
            .unwrap();
        assert_eq!(content, "first");
    }

    #[test]
    fn test_write_empty_content() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("empty.txt");

        let result = write_file(path.to_str().unwrap(), "", WriteMode::Overwrite, true);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 0);
        // File is created and empty.
        let meta = fs::metadata(&path).unwrap();
        assert_eq!(meta.len(), 0);
    }

    #[test]
    fn test_write_atomic_overwrite_replaces_content_and_leaves_no_temp() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("atomic.txt");
        fs::write(&path, b"old").unwrap();

        let result = write_file(
            path.to_str().unwrap(),
            "new content",
            WriteMode::Overwrite,
            true,
        );
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 11);

        let content = fs::read_to_string(&path).unwrap();
        assert_eq!(content, "new content");

        // No temporary files should remain next to the target.
        let leftovers: Vec<_> = fs::read_dir(dir.path())
            .unwrap()
            .filter_map(|e| e.ok())
            .filter(|e| e.file_name().to_string_lossy().contains(".tmp"))
            .collect();
        assert!(leftovers.is_empty(), "atomic write left temp files behind");
    }

    #[cfg(unix)]
    #[test]
    fn test_write_atomic_preserves_symlink_target() {
        use std::os::unix::fs::symlink;

        let dir = TempDir::new().unwrap();
        let target = dir.path().join("real.txt");
        let link = dir.path().join("link.txt");
        fs::write(&target, b"original").unwrap();
        symlink(&target, &link).unwrap();

        let result = write_file(
            link.to_str().unwrap(),
            "via link",
            WriteMode::Overwrite,
            true,
        );
        assert!(result.error.is_none());

        // The symlink itself must remain a symlink and the target must be updated.
        assert!(fs::symlink_metadata(&link)
            .unwrap()
            .file_type()
            .is_symlink());
        assert_eq!(fs::read_to_string(&target).unwrap(), "via link");
        assert_eq!(fs::read_to_string(&link).unwrap(), "via link");
    }
}
