//! Engine-local storage root resolution (M4 存储位置裁决).
//!
//! The engine's local stores (state, sessions) live under the user's home —
//! `~/.kimi-code/engine-state/<workspace-key>/` — keyed by the canonical
//! workspace path, NOT inside the workspace itself. Writing
//! `<workspace>/.kimi/` would leave untracked directories in arbitrary user
//! workspaces (P32), and the repo-local `.gitignore` mitigation does not
//! carry to the user's own repository.

use std::path::{Path, PathBuf};

/// The home-relative root the engine keeps its local stores under.
pub const ENGINE_STATE_ROOT: &str = ".kimi-code/engine-state";

/// Resolve the engine-local storage root for one workspace:
/// `~/.kimi-code/engine-state/<workspace-key>/`. Stores append their own
/// subdirectory (`state/` / `sessions/`).
///
/// The key is the 16-hex FNV-1a digest of the canonicalized workspace path —
/// deterministic across runs, filesystem-safe, and collision-free at the
/// scale a single machine actually sees.
pub fn engine_state_dir(workspace_root: &Path) -> std::io::Result<PathBuf> {
    let home = std::env::var_os("USERPROFILE")
        .or_else(|| std::env::var_os("HOME"))
        .map(PathBuf::from)
        .ok_or_else(|| {
            std::io::Error::new(
                std::io::ErrorKind::NotFound,
                "cannot resolve the home directory (USERPROFILE / HOME unset)",
            )
        })?;
    let canonical = workspace_root
        .canonicalize()
        .unwrap_or_else(|_| workspace_root.to_path_buf());
    Ok(home.join(ENGINE_STATE_ROOT).join(workspace_key(&canonical)))
}

/// 16-hex FNV-1a digest of the workspace path.
fn workspace_key(canonical: &Path) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in canonical.to_string_lossy().as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
    }
    format!("{hash:016x}")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn workspace_key_is_stable_and_hex() {
        let key = workspace_key(Path::new("/tmp/workspaces/a"));
        assert_eq!(key.len(), 16);
        assert!(key.chars().all(|c| c.is_ascii_hexdigit()));
        assert_eq!(key, workspace_key(Path::new("/tmp/workspaces/a")));
    }

    #[test]
    fn workspace_key_separates_workspaces() {
        let a = workspace_key(Path::new("/tmp/workspaces/a"));
        let b = workspace_key(Path::new("/tmp/workspaces/b"));
        assert_ne!(a, b);
    }
}
