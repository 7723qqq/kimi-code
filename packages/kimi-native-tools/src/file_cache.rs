/// In-memory file content cache keyed by (abs_path, mtime, size).
///
/// Eliminates redundant disk reads in read-then-edit workflows:
///   Read(A) => cache miss => read disk + cache
///   Edit(A) => write => invalidate cache entry for A
///   Read(A) => cache hit => return cached content instantly
use std::collections::HashMap;
use std::fs;
use std::sync::LazyLock;
use std::time::SystemTime;

/// Maximum number of cached file entries.
const MAX_CACHE_ENTRIES: usize = 32;

/// Cached file content with invalidation metadata.
#[derive(Clone)]
struct CacheEntry {
    content: String,
    line_count: i32,
    mtime: SystemTime,
    size: u64,
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
        let meta = fs::metadata(path).ok()?;
        let cache = self.cache.lock().ok()?;
        if let Some(entry) = cache.get(path) {
            if entry.mtime == meta.modified().ok()? && entry.size == meta.len() {
                return Some((entry.content.clone(), entry.line_count));
            }
        }
        None
    }

    /// Store a read result in the cache.
    pub fn put(&self, path: String, content: String, line_count: i32) {
        let meta = match fs::metadata(&path) {
            Ok(m) => m,
            Err(_) => return,
        };
        let mtime = match meta.modified() {
            Ok(t) => t,
            Err(_) => return,
        };
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
                mtime,
                size: meta.len(),
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
