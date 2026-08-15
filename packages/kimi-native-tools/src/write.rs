/// Write tool — overwrite or append to a file.
///
/// Creates parent directories automatically.
/// Mirrors `packages/agent-core/src/tools/builtin/file/write.ts`.
use napi_derive::napi;
use std::fs;
use std::io::Write;
use std::path::Path;

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
///   - Returns the number of UTF-8 bytes written.
///
/// The write is a plain truncating `write_all` (or `O_APPEND` for append),
/// matching the TS `writeText` / `appendText` semantics — not a
/// temp-file-and-rename atomic write. A crash mid-write can leave the target
/// truncated; preserving the target's inode (symlinks, hard links) is
/// deliberately preferred over rename-atomicity.
pub fn write_file(path: &str, content: &str, mode: WriteMode) -> WriteResult {
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
        let result = write_file(path.to_str().unwrap(), "hello world", WriteMode::Overwrite);
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

        write_file(path.to_str().unwrap(), "hello ", WriteMode::Overwrite);
        let result = write_file(path.to_str().unwrap(), "world", WriteMode::Append);
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
        let result = write_file(path.to_str().unwrap(), "nested", WriteMode::Overwrite);
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
        );
        let result = write_file(path.to_str().unwrap(), "short", WriteMode::Overwrite);
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
        let result = write_file(path.to_str().unwrap(), "你好", WriteMode::Overwrite);
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
        let result = write_file(target.to_str().unwrap(), "data", WriteMode::Overwrite);
        assert_eq!(result.error_kind.as_deref(), Some("parent_not_dir"));
        assert!(result.error.unwrap().contains("not a directory"));

        // Success carries no kind.
        let ok = dir.path().join("ok.txt");
        let result = write_file(ok.to_str().unwrap(), "data", WriteMode::Overwrite);
        assert!(result.error.is_none());
        assert_eq!(result.error_kind, None);
    }

    #[test]
    fn test_write_append_creates_new_file() {
        let dir = TempDir::new().unwrap();
        let path = dir.path().join("new.txt");

        // Append mode also creates the file when it does not exist.
        let result = write_file(path.to_str().unwrap(), "first", WriteMode::Append);
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

        let result = write_file(path.to_str().unwrap(), "", WriteMode::Overwrite);
        assert!(result.error.is_none());
        assert_eq!(result.bytes_written, 0);
        // File is created and empty.
        let meta = fs::metadata(&path).unwrap();
        assert_eq!(meta.len(), 0);
    }
}
