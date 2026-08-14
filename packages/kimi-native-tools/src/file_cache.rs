/// In-memory file content cache keyed by (abs_path, mtime, ctime, size).
///
/// Eliminates redundant disk reads in read-then-edit workflows:
///   Read(A) => cache miss => read disk + cache
///   Edit(A) => write => invalidate cache entry for A
///   Read(A) => cache hit => return cached content instantly
///
/// Caching is TOCTOU-safe: the caller snapshots the file's invalidation
/// metadata BEFORE reading (`snapshot`), and `put` re-checks after the read —
/// a file modified during the read is never cached, so stale content can never
/// be served under a fresh snapshot.
///
/// The snapshot is `(mtime, ctime, size)` rather than just `(mtime, size)`.
/// On filesystems with coarse mtime granularity (e.g. FAT with 2s ticks), two
/// writes that land in the same tick can share an mtime; if the content also
/// has the same byte length, a `(mtime, size)` key would falsely report a hit
/// and serve stale bytes. `ctime` (the inode change time) is bumped by every
/// write and carries sub-second precision on Unix, closing that window. On
/// Windows std cannot expose a change time, so `ctime` is `None` and the
/// `(mtime, size)` pair is used — acceptable because NTFS mtime already has
/// sub-second granularity (coarse granularity is the FAT case ctime covers).
use std::collections::HashMap;
use std::fs;
use std::sync::LazyLock;
use std::time::{Duration, SystemTime};

/// Maximum number of cached file entries.
const MAX_CACHE_ENTRIES: usize = 32;

/// A file's invalidation metadata: `(mtime, ctime, size)`.
///
/// `ctime` is the inode change time on Unix and `None` where the platform
/// cannot expose one (Windows). See the module docs for why it matters.
#[derive(Clone, PartialEq, Debug)]
pub struct FileSnapshot {
    mtime: SystemTime,
    ctime: Option<SystemTime>,
    size: u64,
}

/// Capture a file's invalidation metadata before reading it.
pub fn snapshot(path: &str) -> Option<FileSnapshot> {
    let meta = fs::metadata(path).ok()?;
    Some(FileSnapshot {
        mtime: meta.modified().ok()?,
        ctime: ctime_of(&meta),
        size: meta.len(),
    })
}

/// Inode change time on Unix (sub-second precision, bumped by every write).
#[cfg(unix)]
fn ctime_of(meta: &fs::Metadata) -> Option<SystemTime> {
    use std::os::unix::fs::MetadataExt;
    let secs = meta.ctime();
    let nsecs = meta.ctime_nsec();
    Some(SystemTime::UNIX_EPOCH + Duration::new(if secs < 0 { 0 } else { secs as u64 }, nsecs as u32))
}

/// No change-time signal outside Unix; fall back to (mtime, size).
#[cfg(not(unix))]
fn ctime_of(_meta: &fs::Metadata) -> Option<SystemTime> {
    None
}

/// Cached file content with invalidation metadata.
#[derive(Clone)]
struct CacheEntry {
    content: String,
    line_count: i32,
    snap: FileSnapshot,
}

/// Thread-safe file content cache using std::sync::Mutex.
pub struct FileReadCache {
    cache: std::sync::Mutex<HashMap<String, CacheEntry>>,
}

impl FileReadCache {
    pub fn new() -> Self {
        Self {
            cache: std::sync::Mutex::new(HashMap::new()),
        }
    }

    /// Look up a cached read result. Returns None on miss or staleness.
    pub fn get(&self, path: &str) -> Option<(String, i32)> {
        let current = snapshot(path)?;
        let cache = self.cache.lock().ok()?;
        if let Some(entry) = cache.get(path) {
            if entry.snap == current {
                return Some((entry.content.clone(), entry.line_count));
            }
        }
        None
    }

    /// Store a read result in the cache. `pre_read` is the metadata snapshot
    /// taken before the content was read; if the file changed in between, the
    /// read content may already be stale, so nothing is cached (and any old
    /// entry is dropped) — caching stale content under a fresh mtime would
    /// keep serving it until the next write.
    pub fn put(&self, path: String, content: String, line_count: i32, pre_read: FileSnapshot) {
        let post = match snapshot(&path) {
            Some(s) => s,
            None => return,
        };
        if post != pre_read {
            self.invalidate(&path);
            return;
        }
        let mut cache = match self.cache.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        // Evict oldest if at capacity.
        if cache.len() >= MAX_CACHE_ENTRIES && !cache.contains_key(&path) {
            cache.clear(); // Simple eviction: clear all when full
        }
        cache.insert(
            path,
            CacheEntry {
                content,
                line_count,
                snap: post,
            },
        );
    }

    /// Invalidate a cache entry (called after file write/edit).
    pub fn invalidate(&self, path: &str) {
        if let Ok(mut cache) = self.cache.lock() {
            cache.remove(path);
        }
    }
}

/// Global file read cache instance.
pub static FILE_CACHE: LazyLock<FileReadCache> = LazyLock::new(FileReadCache::new);

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Write;

    fn write_temp(dir: &tempfile::TempDir, name: &str, content: &[u8]) -> std::path::PathBuf {
        let p = dir.path().join(name);
        let mut f = std::fs::File::create(&p).unwrap();
        f.write_all(content).unwrap();
        f.flush().unwrap();
        p
    }

    #[test]
    fn hit_then_miss_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "a.txt", b"hello");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        assert!(cache.get(&ps).is_none());
        let pre = snapshot(&ps).unwrap();
        cache.put(ps.clone(), "hello".to_string(), 1, pre);
        assert_eq!(cache.get(&ps).map(|(c, _)| c), Some("hello".to_string()));

        // Rewrite the file (different size + new mtime/ctime) and expect a miss.
        write_temp(&dir, "a.txt", b"world!");
        assert!(cache.get(&ps).is_none());
    }

    #[test]
    fn put_after_concurrent_change_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "b.txt", b"v1");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        let pre = snapshot(&ps).unwrap();
        // File changes between the snapshot and put().
        write_temp(&dir, "b.txt", b"v2");
        cache.put(ps.clone(), "v1".to_string(), 1, pre);
        assert!(cache.get(&ps).is_none());
    }

    #[test]
    fn invalidate_removes_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "c.txt", b"data");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        let pre = snapshot(&ps).unwrap();
        cache.put(ps.clone(), "data".to_string(), 1, pre);
        assert!(cache.get(&ps).is_some());
        cache.invalidate(&ps);
        assert!(cache.get(&ps).is_none());
    }
}