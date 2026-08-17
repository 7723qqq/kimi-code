/// In-memory file read-result cache keyed by the full read request
/// `(path, line_offset, n_lines)` plus the file's invalidation metadata
/// `(mtime, ctime, size)`.
///
/// Eliminates redundant disk reads in read-then-edit workflows:
///   Read(A) => cache miss => read disk + cache
///   Edit(A) => write => invalidate cache entry for A
///   Read(A) => cache hit => return cached content instantly
///
/// The key is the whole read request, so any read — full-file or a specific
/// range — can be cached, not just whole-file reads. Equivalent requests are
/// normalized to one key (see `CacheKey`), so the common full-file read
/// shares a single entry whether the caller passed `None` or explicit values.
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
use crate::read::{ReadResult, MAX_LINES};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::sync::LazyLock;
use std::time::SystemTime;

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
    use std::time::Duration;
    let secs = meta.ctime();
    let nsecs = meta.ctime_nsec();
    Some(
        SystemTime::UNIX_EPOCH
            + Duration::new(if secs < 0 { 0 } else { secs as u64 }, nsecs as u32),
    )
}

/// No change-time signal outside Unix; fall back to (mtime, size).
#[cfg(not(unix))]
fn ctime_of(_meta: &fs::Metadata) -> Option<SystemTime> {
    None
}

/// Normalized cache key for a read request.
///
/// Equivalent requests collapse to one key so the common full-file read
/// (offset 1, up to MAX_LINES) shares a single entry regardless of whether
/// the caller passed `None` or explicit values:
///
///   - `line_offset` 0 or 1 (or None) → 1 (start of file; offset 0 also
///     starts at line 1 in the reader)
///   - `n_lines` None or >= MAX_LINES → MAX_LINES (the reader caps at
///     MAX_LINES, so any such request returns the full default view)
///
/// Negative offsets (tail reads) and offsets > 1 (partial reads) are kept
/// exact — their results depend on the precise value.
#[derive(Clone, PartialEq, Eq, Hash, Debug)]
struct CacheKey {
    path: String,
    line_offset: i64,
    n_lines: u32,
}

impl CacheKey {
    fn new(path: &str, line_offset: Option<i64>, n_lines: Option<u32>) -> Self {
        let offset = match line_offset {
            Some(o) if o == 0 || o == 1 => 1,
            Some(o) => o,
            None => 1,
        };
        let lines = match n_lines {
            Some(n) if n < MAX_LINES as u32 => n,
            _ => MAX_LINES as u32,
        };
        Self {
            path: path.to_string(),
            line_offset: offset,
            n_lines: lines,
        }
    }
}

/// Cached read result with invalidation metadata.
#[derive(Clone)]
struct CacheEntry {
    result: ReadResult,
    snap: FileSnapshot,
}

/// Thread-safe file read cache using std::sync::Mutex and an LRU order.
pub struct FileReadCache {
    inner: std::sync::Mutex<CacheInner>,
}

struct CacheInner {
    entries: HashMap<CacheKey, CacheEntry>,
    /// Most-recently-used order: front = least recently used, back = most recently used.
    order: VecDeque<CacheKey>,
}

impl FileReadCache {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(CacheInner {
                entries: HashMap::new(),
                order: VecDeque::new(),
            }),
        }
    }

    /// Look up a cached read result. Returns None on miss or staleness.
    pub fn get(
        &self,
        path: &str,
        line_offset: Option<i64>,
        n_lines: Option<u32>,
    ) -> Option<ReadResult> {
        let current = snapshot(path)?;
        let key = CacheKey::new(path, line_offset, n_lines);
        let mut inner = self.inner.lock().ok()?;
        match inner.entries.get(&key) {
            Some(entry) if entry.snap == current => {
                // Clone the hit into owned data first so the `entries` borrow
                // ends before `order` is mutated (LRU reordering).
                let result = entry.result.clone();
                if let Some(pos) = inner.order.iter().position(|k| *k == key) {
                    if let Some(k) = inner.order.remove(pos) {
                        inner.order.push_back(k);
                    }
                }
                Some(result)
            }
            Some(_) => {
                // Stale entry (file changed since it was cached): drop it so
                // it does not linger until the next put or LRU eviction.
                inner.entries.remove(&key);
                if let Some(pos) = inner.order.iter().position(|k| *k == key) {
                    inner.order.remove(pos);
                }
                None
            }
            None => None,
        }
    }

    /// Store a read result in the cache. `pre_read` is the metadata snapshot
    /// taken before the content was read; if the file changed in between, the
    /// read content may already be stale, so nothing is cached (and any old
    /// entry is dropped) — caching stale content under a fresh mtime would
    /// keep serving it until the next write.
    pub fn put(
        &self,
        path: String,
        line_offset: Option<i64>,
        n_lines: Option<u32>,
        result: ReadResult,
        pre_read: FileSnapshot,
    ) {
        let post = match snapshot(&path) {
            Some(s) => s,
            None => return,
        };
        if post != pre_read {
            self.invalidate(&path);
            return;
        }
        let key = CacheKey::new(&path, line_offset, n_lines);
        let mut inner = match self.inner.lock() {
            Ok(c) => c,
            Err(_) => return,
        };
        // Evict the least-recently-used entry when at capacity.
        if inner.entries.len() >= MAX_CACHE_ENTRIES && !inner.entries.contains_key(&key) {
            if let Some(oldest) = inner.order.pop_front() {
                inner.entries.remove(&oldest);
            }
        }
        // Remove any stale position before pushing this key to the back.
        if let Some(pos) = inner.order.iter().position(|k| *k == key) {
            let _ = inner.order.remove(pos);
        }
        inner.entries.insert(
            key.clone(),
            CacheEntry {
                result,
                snap: post,
            },
        );
        inner.order.push_back(key);
    }

    /// Invalidate every cache entry for a path (called after file write/edit).
    pub fn invalidate(&self, path: &str) {
        if let Ok(mut inner) = self.inner.lock() {
            inner.entries.retain(|k, _| k.path != path);
            inner.order.retain(|k| k.path != path);
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

    fn ok_result(content: &str, line_count: i32) -> ReadResult {
        ReadResult {
            content: content.to_string(),
            line_count,
            error: None,
            error_kind: None,
        }
    }

    #[test]
    fn hit_then_miss_on_change() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "a.txt", b"hello");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        assert!(cache.get(&ps, None, None).is_none());
        let pre = snapshot(&ps).unwrap();
        cache.put(ps.clone(), None, None, ok_result("hello", 1), pre);
        assert_eq!(
            cache.get(&ps, None, None).map(|r| r.content),
            Some("hello".to_string())
        );

        // Rewrite the file (different size + new mtime/ctime) and expect a miss.
        write_temp(&dir, "a.txt", b"world!");
        assert!(cache.get(&ps, None, None).is_none());
    }

    #[test]
    fn put_after_concurrent_change_is_dropped() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "b.txt", b"v1");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        let pre = snapshot(&ps).unwrap();
        // File changes between the snapshot and put(). Sleep past the
        // filesystem's mtime tick first: the contents are deliberately the
        // same byte length, so on Windows (ctime unavailable) detection
        // rides on mtime alone and two writes in one tick are identical.
        std::thread::sleep(std::time::Duration::from_millis(25));
        write_temp(&dir, "b.txt", b"v2");
        cache.put(ps.clone(), None, None, ok_result("v1", 1), pre);
        assert!(cache.get(&ps, None, None).is_none());
    }

    #[test]
    fn invalidate_removes_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "c.txt", b"data");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        let pre = snapshot(&ps).unwrap();
        cache.put(ps.clone(), None, None, ok_result("data", 1), pre);
        assert!(cache.get(&ps, None, None).is_some());
        cache.invalidate(&ps);
        assert!(cache.get(&ps, None, None).is_none());
    }

    #[test]
    fn evicts_least_recently_used_when_at_capacity() {
        let dir = tempfile::tempdir().unwrap();
        let cache = FileReadCache::new();

        // Fill past MAX_CACHE_ENTRIES; the insertion that overflows evicts
        // only the least-recently-used entry (the first one inserted).
        for i in 0..MAX_CACHE_ENTRIES + 1 {
            let path = write_temp(&dir, &format!("f{i:03}.txt"), b"x");
            let ps = path.to_string_lossy().to_string();
            let pre = snapshot(&ps).unwrap();
            cache.put(ps.clone(), None, None, ok_result(&format!("v{i}"), 1), pre);
        }

        // The oldest entry is evicted; all newer entries remain cached.
        let first = dir.path().join(format!("f{:03}.txt", 0));
        let first_ps = first.to_string_lossy().to_string();
        assert!(
            cache.get(&first_ps, None, None).is_none(),
            "oldest entry should be evicted"
        );
        for i in 1..MAX_CACHE_ENTRIES + 1 {
            let path = dir.path().join(format!("f{i:03}.txt"));
            let ps = path.to_string_lossy().to_string();
            assert_eq!(
                cache.get(&ps, None, None).map(|r| r.content),
                Some(format!("v{i}")),
                "entry {i} should remain cached"
            );
        }
    }

    #[test]
    fn get_missing_file_returns_none() {
        let dir = tempfile::tempdir().unwrap();
        let cache = FileReadCache::new();
        let ps = dir.path().join("nope.txt").to_string_lossy().to_string();
        // No file → no snapshot → miss, without panicking.
        assert!(cache.get(&ps, None, None).is_none());
    }

    #[test]
    fn put_missing_file_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let cache = FileReadCache::new();
        let ps = dir.path().join("nope.txt").to_string_lossy().to_string();
        // A pre-read snapshot that cannot be re-taken post-read → nothing
        // cached, and later reads still miss.
        let pre = FileSnapshot {
            mtime: std::time::SystemTime::now(),
            ctime: None,
            size: 0,
        };
        cache.put(ps.clone(), None, None, ok_result("ghost", 1), pre);
        assert!(cache.get(&ps, None, None).is_none());
    }

    #[test]
    fn invalidate_unknown_path_is_noop() {
        let dir = tempfile::tempdir().unwrap();
        let cache = FileReadCache::new();
        let ps = dir.path().join("ghost.txt").to_string_lossy().to_string();
        cache.invalidate(&ps);
        // Cache still usable afterwards.
        let path = write_temp(&dir, "ok.txt", b"data");
        let ps2 = path.to_string_lossy().to_string();
        let pre = snapshot(&ps2).unwrap();
        cache.put(ps2.clone(), None, None, ok_result("data", 1), pre);
        assert!(cache.get(&ps2, None, None).is_some());
    }

    #[test]
    fn equivalent_requests_share_one_entry() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "eq.txt", b"line1\nline2\n");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        // A full-file read via explicit (1, MAX_LINES) and via None/None
        // normalize to the same key, so the second hits the first's entry.
        let pre = snapshot(&ps).unwrap();
        cache.put(
            ps.clone(),
            Some(1),
            Some(MAX_LINES as u32),
            ok_result("full", 2),
            pre,
        );
        assert_eq!(
            cache.get(&ps, None, None).map(|r| r.content),
            Some("full".to_string())
        );
        // offset 0 and an n_lines above the cap also normalize to the same key.
        assert_eq!(
            cache
                .get(&ps, Some(0), Some(MAX_LINES as u32 + 5))
                .map(|r| r.content),
            Some("full".to_string())
        );
    }

    #[test]
    fn partial_reads_are_distinct_keys() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "part.txt", b"line1\nline2\nline3\n");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        let pre = snapshot(&ps).unwrap();
        cache.put(ps.clone(), Some(2), Some(1), ok_result("line2", 3), pre);
        // A different offset is a different key → miss.
        assert!(cache.get(&ps, Some(1), Some(1)).is_none());
        // The exact same request hits.
        assert_eq!(
            cache.get(&ps, Some(2), Some(1)).map(|r| r.content),
            Some("line2".to_string())
        );
    }

    #[test]
    fn tail_reads_normalize_n_lines_but_keep_offset() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "tail.txt", b"l1\nl2\nl3\nl4\nl5\n");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        // A tail read with n_lines=None and one with n_lines=MAX_LINES both
        // normalize to the same key (the reader caps at MAX_LINES), so the
        // second hits the first's entry.
        let pre = snapshot(&ps).unwrap();
        cache.put(ps.clone(), Some(-3), None, ok_result("tail3", 5), pre);
        assert_eq!(
            cache.get(&ps, Some(-3), Some(MAX_LINES as u32)).map(|r| r.content),
            Some("tail3".to_string())
        );
        // A different tail offset is a distinct key → miss.
        assert!(cache.get(&ps, Some(-2), None).is_none());
    }

    #[test]
    fn stale_entry_is_dropped_on_get() {
        let dir = tempfile::tempdir().unwrap();
        let path = write_temp(&dir, "stale.txt", b"v1");
        let ps = path.to_string_lossy().to_string();
        let cache = FileReadCache::new();

        let pre = snapshot(&ps).unwrap();
        cache.put(ps.clone(), None, None, ok_result("v1", 1), pre);
        // Rewrite the file with a different byte length so the snapshot
        // (mtime, size) — and on Windows (mtime, size) alone — is guaranteed
        // to differ even within the same mtime tick.
        write_temp(&dir, "stale.txt", b"v2-longer");
        assert!(cache.get(&ps, None, None).is_none());
        // The stale entry was dropped, so a fresh put is not evicted by it.
        let pre2 = snapshot(&ps).unwrap();
        cache.put(ps.clone(), None, None, ok_result("v2-longer", 1), pre2);
        assert_eq!(
            cache.get(&ps, None, None).map(|r| r.content),
            Some("v2-longer".to_string())
        );
    }
}
