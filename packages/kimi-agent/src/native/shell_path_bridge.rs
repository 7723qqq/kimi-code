//! Shell path bridge — translate the POSIX path dialect spoken by MSYS2 /
//! Git Bash into native win32 paths.
//!
//! Ported from `packages/kaos/src/shell-path-bridge.ts` (itself a port of
//! `agent-core-v2/src/_base/execEnv/shellPathBridge.ts`).
//!
//! The msys runtime gives the shell a POSIX path view native Windows cannot
//! resolve: `/c/Users/x` is `C:\Users\x`, and `/tmp/x` is the msys temp
//! directory, *not* `<drive-root>/tmp/x`. [`ShellPathBridge::from_shell_path`]
//! resolves a model-supplied path for filesystem access — drive-letter forms
//! lexically, other root-relative paths through `cygpath -w` next to the
//! probed bash. Anything unconvertible passes through unchanged, and the whole
//! bridge is the identity outside Windows.

use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use super::path_access::{PathClass, normalize_path};

/// cygpath semantics are undefined for the virtual filesystems.
const VIRTUAL_FS_PREFIXES: [&str; 3] = ["/dev/", "/proc/", "/sys/"];

/// Native win32 path → the POSIX dialect the shell speaks.
pub struct ShellPathBridge {
    /// `cygpath.exe` next to the probed bash, or `None` when it is not there
    /// (a non-msys shell, or a bash installed without the msys tools).
    cygpath: Option<PathBuf>,
    /// `first segment -> resolved root`, memoised. Only successes are cached:
    /// a missing `cygpath.exe` is a stable fact, but a transient spawn failure
    /// must not poison every later lookup.
    roots: Mutex<HashMap<String, String>>,
}

impl ShellPathBridge {
    /// Build a bridge for the shell at `shell_path`. Outside Windows the
    /// bridge is the identity and no `cygpath` is looked for.
    pub fn new(shell_path: &str) -> Self {
        Self {
            cygpath: if cfg!(windows) {
                locate_cygpath(shell_path)
            } else {
                None
            },
            roots: Mutex::new(HashMap::new()),
        }
    }

    /// Model/shell-supplied path → native win32 path. Identity when the path
    /// is not convertible.
    pub fn to_native_path(&self, path: &str) -> String {
        if !cfg!(windows) {
            return path.to_string();
        }
        if path.starts_with("//") {
            return path.to_string();
        }
        if !path.starts_with('/') {
            return path.to_string();
        }
        let normalized = normalize_path(path, PathClass::Posix);
        let lexical = translate_shell_drive_path(&normalized);
        if lexical != normalized {
            return lexical;
        }
        if normalized == "/" {
            return normalized;
        }
        if VIRTUAL_FS_PREFIXES
            .iter()
            .any(|prefix| normalized.starts_with(prefix))
        {
            return normalized;
        }
        let first_segment = normalized[1..].split('/').next().unwrap_or("");
        let Some(prefix) = self.resolve_root_segment(first_segment) else {
            return normalized;
        };
        let remainder = &normalized[first_segment.len() + 1..];
        let joined = format!("{prefix}{remainder}").replace('\\', "/");
        if is_bare_drive(&joined) {
            format!("{joined}/")
        } else {
            joined
        }
    }

    /// `cygpath -w /<segment>` → the native root that segment names.
    fn resolve_root_segment(&self, first_segment: &str) -> Option<String> {
        if let Some(cached) = self
            .roots
            .lock()
            .ok()
            .and_then(|cache| cache.get(first_segment).cloned())
        {
            return Some(cached);
        }
        let cygpath = self.cygpath.as_ref()?;
        let output = std::process::Command::new(cygpath)
            .args(["-w", "-C", "UTF8", "--"])
            .arg(format!("/{first_segment}"))
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let trimmed = String::from_utf8_lossy(&output.stdout)
            .trim_end_matches(['\r', '\n'])
            .to_string();
        if !is_win32_drive_absolute(&trimmed) && !trimmed.starts_with("\\\\") {
            return None;
        }
        let resolved = trimmed.trim_end_matches(['\\', '/']).to_string();
        if let Ok(mut cache) = self.roots.lock() {
            cache.insert(first_segment.to_string(), resolved.clone());
        }
        Some(resolved)
    }
}

/// Lexical translation of shell-dialect drive paths (`/c/x`, `/c:/x`,
/// `/cygdrive/c/x`) to native win32 form — pure string rewriting, no cygpath
/// involved. Anything else is returned unchanged.
fn translate_shell_drive_path(path: &str) -> String {
    if let Some((letter, rest)) = match_drive_colon(path) {
        return join_drive(letter, rest);
    }
    if let Some((letter, rest)) = match_cygdrive(path) {
        return join_drive(letter, rest);
    }
    if let Some((letter, rest)) = match_drive(path) {
        return join_drive(letter, rest);
    }
    path.to_string()
}

/// `/c:/x` — a drive letter spelled with a colon after the slash.
fn match_drive_colon(path: &str) -> Option<(char, &str)> {
    let bytes = path.as_bytes();
    if bytes.len() < 3 || bytes[0] != b'/' || !bytes[1].is_ascii_alphabetic() || bytes[2] != b':' {
        return None;
    }
    if bytes.len() > 3 && bytes[3] != b'/' && bytes[3] != b'\\' {
        return None;
    }
    Some((bytes[1] as char, &path[3..]))
}

/// `/cygdrive/c/x` — the Cygwin spelling.
fn match_cygdrive(path: &str) -> Option<(char, &str)> {
    const PREFIX: &str = "/cygdrive/";
    let rest = path.strip_prefix(PREFIX)?;
    let letter = rest.chars().next()?;
    if !letter.is_ascii_alphabetic() {
        return None;
    }
    let after = &rest[1..];
    if !after.is_empty() && !after.starts_with('/') && !after.starts_with('\\') {
        return None;
    }
    Some((letter, after))
}

/// `/c/x` — the Git Bash spelling.
fn match_drive(path: &str) -> Option<(char, &str)> {
    let bytes = path.as_bytes();
    if bytes.len() < 2 || bytes[0] != b'/' || !bytes[1].is_ascii_alphabetic() {
        return None;
    }
    if bytes.len() > 2 && bytes[2] != b'/' && bytes[2] != b'\\' {
        return None;
    }
    Some((bytes[1] as char, &path[2..]))
}

fn join_drive(letter: char, rest: &str) -> String {
    let normalized_rest = rest.replace('\\', "/");
    if normalized_rest.is_empty() {
        format!("{}:/", letter.to_ascii_uppercase())
    } else {
        format!("{}:{normalized_rest}", letter.to_ascii_uppercase())
    }
}

fn is_bare_drive(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() == 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':'
}

fn is_win32_drive_absolute(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'\\' || bytes[2] == b'/')
}

/// `cygpath.exe` lives beside the msys bash, or one level up under `usr/bin`
/// when the probed shell is the `bin/bash.exe` shim.
fn locate_cygpath(shell_path: &str) -> Option<PathBuf> {
    let shell_dir = Path::new(shell_path).parent()?;
    let mut candidates = vec![shell_dir.join("cygpath.exe")];
    if shell_dir
        .file_name()
        .is_some_and(|name| name.eq_ignore_ascii_case("bin"))
    {
        candidates.push(
            shell_dir
                .join("..")
                .join("usr")
                .join("bin")
                .join("cygpath.exe"),
        );
    }
    candidates.into_iter().find(|candidate| candidate.is_file())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn lexical(path: &str) -> String {
        translate_shell_drive_path(&normalize_path(path, PathClass::Posix))
    }

    #[test]
    fn drive_forms_translate_lexically() {
        assert_eq!(lexical("/c/Users/x"), "C:/Users/x");
        assert_eq!(lexical("/c:/Users/x"), "C:/Users/x");
        assert_eq!(lexical("/cygdrive/c/Users/x"), "C:/Users/x");
        assert_eq!(lexical("/g/kimi/kimi-code"), "G:/kimi/kimi-code");
        assert_eq!(lexical("/c"), "C:/");
        assert_eq!(lexical("/c/"), "C:/");
    }

    #[test]
    fn non_drive_paths_are_left_for_cygpath() {
        // `/tmp` is the msys temp directory, not `<drive-root>/tmp` — only
        // cygpath knows where it points, so the lexical pass must not touch it.
        assert_eq!(lexical("/tmp/x.txt"), "/tmp/x.txt");
        assert_eq!(lexical("/usr/bin/bash"), "/usr/bin/bash");
        assert_eq!(lexical("/home/user/a.txt"), "/home/user/a.txt");
        // A multi-letter first segment is not a drive letter.
        assert_eq!(lexical("/cygwin/c/x"), "/cygwin/c/x");
    }

    #[test]
    fn dot_segments_resolve_before_the_lexical_pass() {
        assert_eq!(lexical("/./c/x"), "C:/x");
        assert_eq!(lexical("/../c/x"), "C:/x");
        // `..` pops the first segment, so `/c/../d/x` is `/d/x` — a drive
        // letter in its own right, not `C:/d/x`.
        assert_eq!(lexical("/c/../d/x"), "D:/x");
    }

    #[test]
    fn unc_and_relative_paths_pass_through() {
        let bridge = ShellPathBridge {
            cygpath: None,
            roots: Mutex::new(HashMap::new()),
        };
        assert_eq!(bridge.to_native_path("//server/share"), "//server/share");
        assert_eq!(bridge.to_native_path("relative/x"), "relative/x");
        assert_eq!(bridge.to_native_path("C:/x"), "C:/x");
    }

    #[test]
    fn virtual_filesystems_and_root_pass_through() {
        let bridge = ShellPathBridge {
            cygpath: None,
            roots: Mutex::new(HashMap::new()),
        };
        assert_eq!(bridge.to_native_path("/"), "/");
        assert_eq!(bridge.to_native_path("/dev/null"), "/dev/null");
        assert_eq!(bridge.to_native_path("/proc/self"), "/proc/self");
        assert_eq!(bridge.to_native_path("/sys/x"), "/sys/x");
    }

    #[test]
    fn an_unresolvable_root_falls_back_to_the_normalized_path() {
        // No cygpath: `/tmp` cannot be placed, so it stays as written rather
        // than being guessed onto the current drive.
        let bridge = ShellPathBridge {
            cygpath: None,
            roots: Mutex::new(HashMap::new()),
        };
        assert_eq!(bridge.to_native_path("/tmp/x.txt"), "/tmp/x.txt");
    }

    #[test]
    fn drive_helpers_reject_near_misses() {
        assert_eq!(match_drive("/cygwin/c"), None);
        assert_eq!(match_drive("/1/x"), None);
        assert_eq!(match_cygdrive("/cygdrive/1/x"), None);
        assert_eq!(match_cygdrive("/cygdrive/cx"), None);
        assert_eq!(match_drive_colon("/c:x"), None);
        assert!(is_bare_drive("C:"));
        assert!(!is_bare_drive("C:/"));
        assert!(is_win32_drive_absolute("C:/x"));
        assert!(!is_win32_drive_absolute("C:x"));
    }
}
