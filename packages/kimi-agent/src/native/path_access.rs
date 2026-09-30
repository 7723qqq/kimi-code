//! Path canonicalization, containment, and the lexical half of the
//! workspace-access policy gate — pure, no filesystem I/O.
//!
//! Ported from `packages/agent-core-v2/src/tool/path-access.ts`. Security
//! critical: the gate runs on every Read/Write/Edit/Grep/Glob call, before the
//! permission layer and before execution, so a refused path is never stat'ed.
//!
//! ## This half is lexical on purpose, and that is now confirmed correct
//!
//! An earlier revision of this comment claimed the opposite — that v2 ran the
//! containment check on a realpath and that being lexical here was a recorded
//! open item. That was read off the fork's v2 baseline (`ecad4136d9^`,
//! 2026-09-04), where `resolvePathAccess` did route non-search operations
//! through `resolveForContainment` + `realpathSync`. Upstream has since deleted
//! that: at the newer v2 (`52437299`, 2026-09-29) `resolveForContainment` is
//! gone, the policy compares the lexical canonical path, and
//! `realpathSync` is no longer imported at all. So the lexical decision here
//! matches v2, and `tools/mod.rs`'s note saying the same is right, not stale.
//!
//! ## What lexical cannot see, and where it lives
//!
//! A symlink whose *name* is innocuous and whose *target* is not:
//! `notes.txt -> .env` passes every test on this page. v2 covers that in a
//! separate module, `tool/realpath-access.ts`, wired into all six file tools —
//! and that module is what [`super::realpath_access`] ports. So the two halves
//! of v2's gate map one-to-one onto two modules here, and the fork had neither
//! before 2026-10-01.

/// Path class: POSIX or Windows (Win32).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathClass {
    Posix,
    Win32,
}

impl PathClass {
    pub fn from_str(s: &str) -> Option<Self> {
        match s {
            "posix" => Some(Self::Posix),
            "win32" => Some(Self::Win32),
            _ => None,
        }
    }
}

/// Win32/Cygwin user-path normalization.
///
/// - Bare root `/` stays as `/`.
/// - `//` paths are unchanged.
/// - `/cygdrive/X` or `/X` → `X:` (drive letter).
pub fn normalize_user_path(path: &str, path_class: PathClass) -> String {
    if path_class != PathClass::Win32 {
        return path.to_string();
    }
    if path == "/" {
        return "/".to_string();
    }
    if path.starts_with("//") {
        return path.to_string();
    }
    if let Some((drive, prefix_len)) = regex_cygdrive(path) {
        let rest = &path[prefix_len..];
        return format!("{}:{}", drive, if rest.is_empty() { "/" } else { rest });
    }
    if let Some((drive, prefix_len)) = regex_drive(path) {
        let rest = &path[prefix_len..];
        return format!("{}:{}", drive, if rest.is_empty() { "/" } else { rest });
    }
    path.to_string()
}

fn regex_cygdrive(path: &str) -> Option<(String, usize)> {
    if !path.starts_with("/cygdrive/") {
        return None;
    }
    let bytes = path.as_bytes();
    if bytes.len() < 11 {
        return None;
    }
    let drive = bytes[10];
    if drive.is_ascii_alphabetic() {
        Some(((drive as char).to_uppercase().to_string(), 11))
    } else {
        None
    }
}

fn regex_drive(path: &str) -> Option<(String, usize)> {
    let bytes = path.as_bytes();
    if bytes.len() >= 3 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() && bytes[2] == b'/' {
        return Some(((bytes[1] as char).to_uppercase().to_string(), 2));
    }
    if bytes.len() == 2 && bytes[0] == b'/' && bytes[1].is_ascii_alphabetic() {
        return Some(((bytes[1] as char).to_uppercase().to_string(), 2));
    }
    None
}

/// Expand `~` → home_dir.
pub fn expand_user_path(path: &str, home_dir: Option<&str>, path_class: PathClass) -> String {
    let Some(home) = home_dir else {
        return path.to_string();
    };
    if path == "~" {
        return home.to_string();
    }
    if path.starts_with("~/") {
        return format!("{}{}", home, &path[1..]);
    }
    if path_class == PathClass::Win32 && path.starts_with("~\\") {
        return format!("{}{}", home, &path[1..]);
    }
    path.to_string()
}

/// Lexical canonicalization: relative → absolute against `cwd`, then normalize.
/// No filesystem I/O.
pub fn canonicalize_path(path: &str, cwd: &str, path_class: PathClass) -> Result<String, String> {
    if path.is_empty() {
        return Err("PATH_INVALID: Path cannot be empty".to_string());
    }
    if path_class == PathClass::Win32 && is_win32_drive_relative(path) {
        return Err(format!(
            "PATH_INVALID: \"{path}\" is a drive-relative Windows path. \
             Use an absolute path like C:\\path or a path relative to the working directory."
        ));
    }
    let abs_path = if is_absolute(path, path_class) {
        path.to_string()
    } else {
        if !is_absolute(cwd, path_class) {
            return Err(format!(
                "PATH_INVALID: Cannot resolve \"{path}\" against non-absolute cwd \"{cwd}\"."
            ));
        }
        join_path(cwd, path, path_class)
    };
    Ok(normalize_path(&abs_path, path_class))
}

fn is_win32_drive_relative(path: &str) -> bool {
    let bytes = path.as_bytes();
    bytes.len() >= 2
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes.len() == 2 || (bytes[2] != b'\\' && bytes[2] != b'/'))
}

fn is_absolute(path: &str, path_class: PathClass) -> bool {
    if path_class == PathClass::Win32 {
        // C:\path, \\server\share, or /path (POSIX-style on Win32 host).
        // Byte-based check: `path[..2]` would panic on a multi-byte first
        // character (non-ASCII relative paths), so never slice mid-char.
        let bytes = path.as_bytes();
        (bytes.len() >= 2 && bytes[0].is_ascii_alphabetic() && bytes[1] == b':')
            || path.starts_with("\\\\")
            || path.starts_with('/')
    } else {
        path.starts_with('/')
    }
}

fn join_path(base: &str, rel: &str, path_class: PathClass) -> String {
    let sep = if path_class == PathClass::Win32 {
        '\\'
    } else {
        '/'
    };
    if base.ends_with('/') || base.ends_with('\\') {
        format!("{}{}", base, rel)
    } else {
        format!("{}{}{}", base, sep, rel)
    }
}

pub(crate) fn normalize_path(path: &str, path_class: PathClass) -> String {
    let sep = if path_class == PathClass::Win32 {
        '\\'
    } else {
        '/'
    };
    let slash_sep = if path_class == PathClass::Win32 {
        '/'
    } else {
        '\\'
    };
    let normalized = path.replace(slash_sep, &sep.to_string());
    // Win32 UNC (`\\server\share`) and verbatim (`\\?\`) roots carry TWO
    // leading separators — a distinct root from `\server` (drive-relative).
    // The split below skips empty segments, so both are re-added explicitly
    // or the path would be relocated to the current drive.
    let double_sep_prefix = normalized.starts_with(&format!("{sep}{sep}"));
    let parts: Vec<&str> = normalized.split(sep).collect();
    let mut result: Vec<&str> = Vec::new();
    let is_abs = normalized.starts_with(sep);
    for part in parts {
        match part {
            "" | "." => {}
            ".." => {
                if let Some(last) = result.last() {
                    if *last != ".." {
                        result.pop();
                    } else {
                        result.push("..");
                    }
                } else if !is_abs {
                    result.push("..");
                }
            }
            _ => result.push(part),
        }
    }
    let joined = result.join(&sep.to_string());
    if is_abs {
        if double_sep_prefix {
            format!("{sep}{sep}{joined}")
        } else {
            format!("{sep}{joined}")
        }
    } else if joined.is_empty() {
        ".".to_string()
    } else {
        joined
    }
}

/// True iff `candidate` is `base` itself or a descendant, compared on
/// path-component boundaries. Both arguments must already be canonical.
pub fn is_within_directory(candidate: &str, base: &str, path_class: PathClass) -> bool {
    let nc = normalize_path(candidate, path_class);
    let nb = normalize_path(base, path_class);
    let (comp_c, comp_b) = if path_class == PathClass::Win32 {
        (nc.to_lowercase(), nb.to_lowercase())
    } else {
        (nc, nb)
    };
    if comp_c == comp_b {
        return true;
    }
    let sep = if path_class == PathClass::Win32 {
        '\\'
    } else {
        '/'
    };
    let prefix = if comp_b.ends_with('/') || comp_b.ends_with('\\') {
        comp_b.clone()
    } else {
        format!("{}{}", comp_b, sep)
    };
    comp_c.starts_with(&prefix)
}

/// True iff `candidate` sits inside any of the workspace roots.
pub fn is_within_workspace(candidate: &str, roots: &[String], path_class: PathClass) -> bool {
    for root in roots {
        if is_within_directory(candidate, root, path_class) {
            return true;
        }
    }
    false
}

// ── Workspace-access policy gate ────────────────────────────────────────────
// The port was missing this entire layer: the canonicalization helpers above
// were wired into the OS tools, but the policy v2 applies on top of them was
// not, so `Read`/`Write`/`Edit` resolved a `.env` path and read it.

/// How a path outside every workspace root is treated. Mirrors v2
/// `WorkspaceGuardMode`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GuardMode {
    /// A path outside the workspace is allowed when it is absolute, and
    /// rejected when it is relative.
    AbsoluteOutsideAllowed,
    /// The workspace check is skipped entirely.
    ///
    /// v2 `WorkspaceGuardMode`'s `disabled` arm. Nothing selects it — v2's
    /// Grep/Glob pass `absolute-outside-allowed` with `checkSensitive: false`
    /// rather than disabling the check — so it is carried for parity with the
    /// reference source and covered by the gate tests.
    #[allow(dead_code)]
    Disabled,
}

/// Mirrors v2 `WorkspaceAccessPolicy`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct WorkspaceAccessPolicy {
    pub guard_mode: GuardMode,
    pub check_sensitive: bool,
}

impl Default for WorkspaceAccessPolicy {
    /// v2 `DEFAULT_WORKSPACE_ACCESS_POLICY` (`path-access.ts:110-113`).
    fn default() -> Self {
        Self {
            guard_mode: GuardMode::AbsoluteOutsideAllowed,
            check_sensitive: true,
        }
    }
}

impl WorkspaceAccessPolicy {
    /// v2's explicit search policy: `grepTool.ts:98` and `globTool.ts:98` both
    /// pass `{ guardMode: 'absolute-outside-allowed', checkSensitive: false }`
    /// and filter sensitive hits out of their *results* instead of refusing
    /// the call. Used by the native Grep and Glob, which drop sensitive hits
    /// into `filtered_sensitive` rather than refusing the search.
    pub const SEARCH: Self = Self {
        guard_mode: GuardMode::AbsoluteOutsideAllowed,
        check_sensitive: false,
    };
}

/// Which tool is asking. Mirrors v2 `PathAccessOperation`; it only selects the
/// verb in the out-of-workspace message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathAccessOperation {
    Read,
    Write,
    /// v2's `search` operation, reached by Grep and Glob.
    Search,
}

impl PathAccessOperation {
    /// v2 `relativeOutsideMessage` (`path-access.ts:291-302`) picks the verb
    /// from the operation; `write` covers Edit as well.
    fn verb(self) -> &'static str {
        match self {
            Self::Read => "read a file",
            Self::Write => "write or edit a file",
            Self::Search => "search",
        }
    }
}

/// Mirrors v2 `PathSecurityCode` (`PATH_OUTSIDE_WORKSPACE` /
/// `PATH_SENSITIVE` / `PATH_INVALID` / `PATH_SYMLINK_ESCAPE`). The prefix is
/// dropped to satisfy `clippy::enum_variant_names`; the v2 wire spelling stays
/// in each doc line.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PathSecurityCode {
    /// v2 `PATH_OUTSIDE_WORKSPACE`.
    OutsideWorkspace,
    /// v2 `PATH_SENSITIVE`.
    Sensitive,
    /// v2 `PATH_INVALID`.
    Invalid,
    /// v2 `PATH_SYMLINK_ESCAPE`, raised only by
    /// [`super::realpath_access`], never by the lexical gate.
    SymlinkEscape,
}

/// Mirrors v2 `PathSecurityError`. v2 surfaces only `.message` to the model
/// (`toolExecutorService.ts:392-396` renders it verbatim as the tool result and
/// swallows the code), so the code is kept for host-side diagnostics only.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathSecurityError {
    pub code: PathSecurityCode,
    pub raw_path: String,
    pub canonical_path: String,
    pub message: String,
}

impl PathSecurityError {
    fn new(code: PathSecurityCode, raw_path: &str, canonical_path: &str, message: String) -> Self {
        Self {
            code,
            raw_path: raw_path.to_string(),
            canonical_path: canonical_path.to_string(),
            message,
        }
    }

    /// A refusal from the realpath layer. v2 words every one of these the same
    /// way — `"<raw>" resolves …` — because the model has to be told that the
    /// path it named is not the path it would have reached.
    pub fn symlink_escape(raw_path: &str, canonical_path: &str, message: String) -> Self {
        Self::new(
            PathSecurityCode::SymlinkEscape,
            raw_path,
            canonical_path,
            message,
        )
    }

    /// A link that lands on a sensitive file. v2 keeps the `PATH_SENSITIVE`
    /// code here rather than `PATH_SYMLINK_ESCAPE`: the thing being protected
    /// is the secret, not the link.
    pub fn symlink_sensitive(raw_path: &str, resolved_path: &str) -> Self {
        Self::new(
            PathSecurityCode::Sensitive,
            raw_path,
            resolved_path,
            format!(
                "\"{raw_path}\" resolves to \"{resolved_path}\" through a symbolic link, \
                 which matches a sensitive-file pattern (env / credential / SSH key). \
                 Access is blocked to protect secrets."
            ),
        )
    }
}

/// Apply the workspace-access policy to an already-canonicalized path.
///
/// Mirrors the tail of v2 `resolvePathAccess` (`path-access.ts:324-354`):
/// compute containment, then refuse a sensitive path when the policy asks for
/// it, then refuse a *relative* path that landed outside the workspace.
///
/// `raw_is_absolute` must describe the user-supplied argument (after shell-path
/// bridging and `~` expansion), not the canonical path — v2 reads
/// `rawIsAbsolute` at `path-access.ts:314`, before canonicalization, because
/// the rule is "you may not *spell* a relative path to reach outside".
///
/// Returns `Ok(outside_workspace)` so the caller can carry v2's
/// `PathAccess.outsideWorkspace` flag onward.
pub fn enforce_path_access(
    raw_path: &str,
    canonical: &str,
    raw_is_absolute: bool,
    roots: &[String],
    path_class: PathClass,
    operation: PathAccessOperation,
    policy: &WorkspaceAccessPolicy,
) -> Result<bool, PathSecurityError> {
    let outside_workspace = !is_within_workspace(canonical, roots, path_class);

    if policy.check_sensitive && crate::native::file_type::is_sensitive_file(canonical) {
        return Err(PathSecurityError {
            code: PathSecurityCode::Sensitive,
            raw_path: raw_path.to_string(),
            canonical_path: canonical.to_string(),
            message: format!(
                "\"{raw_path}\" matches a sensitive-file pattern \
                 (env / credential / SSH key). Access is blocked to protect secrets."
            ),
        });
    }

    if outside_workspace
        && policy.guard_mode == GuardMode::AbsoluteOutsideAllowed
        && !raw_is_absolute
    {
        return Err(PathSecurityError {
            code: PathSecurityCode::OutsideWorkspace,
            raw_path: raw_path.to_string(),
            canonical_path: canonical.to_string(),
            message: format!(
                "\"{raw_path}\" is not an absolute path. \
                 You must provide an absolute path to {} outside the working directory.",
                operation.verb()
            ),
        });
    }

    Ok(outside_workspace)
}

/// Mirrors v2 `PathAccess`.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PathAccess {
    /// The canonical path the tool should act on.
    pub path: String,
    pub outside_workspace: bool,
}

/// The full v2 `resolvePathAccess` (`path-access.ts:304-355`): normalize, expand
/// `~`, canonicalize lexically, then apply the policy — all without touching
/// the filesystem, exactly like v2, so a refused path is never even stat'ed.
///
/// `raw_path` must already be shell-path-bridged (v2 applies
/// `options.shellPathBridge.fromShellPath` at `:312` before this point).
/// `cwd` is the workspace root the tool resolves relative paths against, and
/// `roots` is that same root plus the host-authorized `additionalDirs`.
pub fn resolve_path_access(
    raw_path: &str,
    cwd: &str,
    roots: &[String],
    home_dir: Option<&str>,
    path_class: PathClass,
    operation: PathAccessOperation,
    policy: &WorkspaceAccessPolicy,
) -> Result<PathAccess, PathSecurityError> {
    let normalized = normalize_user_path(raw_path, path_class);
    let expanded = expand_user_path(&normalized, home_dir, path_class);
    // v2 reads `rawIsAbsolute` at `:314`, i.e. after `~` expansion but before
    // canonicalization: the rule rejects the *spelling*, not the target.
    let raw_is_absolute = is_absolute(&expanded, path_class);
    let canonical =
        canonicalize_path(&expanded, cwd, path_class).map_err(|message| PathSecurityError {
            code: PathSecurityCode::Invalid,
            raw_path: raw_path.to_string(),
            canonical_path: expanded.clone(),
            message,
        })?;
    let outside_workspace = enforce_path_access(
        raw_path,
        &canonical,
        raw_is_absolute,
        roots,
        path_class,
        operation,
        policy,
    )?;
    Ok(PathAccess {
        path: canonical,
        outside_workspace,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_normalize_user_path_posix() {
        assert_eq!(
            normalize_user_path("/foo/bar", PathClass::Posix),
            "/foo/bar"
        );
        assert_eq!(
            normalize_user_path("relative", PathClass::Posix),
            "relative"
        );
    }

    #[test]
    fn test_normalize_user_path_win32_cygdrive() {
        assert_eq!(
            normalize_user_path("/cygdrive/c/path", PathClass::Win32),
            "C:/path"
        );
        assert_eq!(normalize_user_path("/cygdrive/z", PathClass::Win32), "Z:/");
    }

    #[test]
    fn test_normalize_user_path_win32_drive() {
        assert_eq!(normalize_user_path("/c/path", PathClass::Win32), "C:/path");
        assert_eq!(normalize_user_path("/z", PathClass::Win32), "Z:/");
    }

    #[test]
    fn test_normalize_user_path_win32_bare_root() {
        assert_eq!(normalize_user_path("/", PathClass::Win32), "/");
        assert_eq!(
            normalize_user_path("//server", PathClass::Win32),
            "//server"
        );
    }

    #[test]
    fn test_expand_user_path_posix() {
        assert_eq!(
            expand_user_path("~/foo", Some("/home/user"), PathClass::Posix),
            "/home/user/foo"
        );
        assert_eq!(
            expand_user_path("~", Some("/home/user"), PathClass::Posix),
            "/home/user"
        );
        assert_eq!(
            expand_user_path("/abs", Some("/home/user"), PathClass::Posix),
            "/abs"
        );
    }

    #[test]
    fn test_expand_user_path_win32() {
        assert_eq!(
            expand_user_path("~\\foo", Some("C:\\User"), PathClass::Win32),
            "C:\\User\\foo"
        );
    }

    #[test]
    fn test_canonicalize_empty() {
        assert!(canonicalize_path("", "/cwd", PathClass::Posix).is_err());
    }

    #[test]
    fn test_canonicalize_drive_relative_win32() {
        assert!(canonicalize_path("C:path", "C:\\cwd", PathClass::Win32).is_err());
    }

    #[test]
    fn test_canonicalize_relative() {
        assert_eq!(
            canonicalize_path("foo/bar", "/cwd", PathClass::Posix).unwrap(),
            "/cwd/foo/bar"
        );
        assert_eq!(
            canonicalize_path("./foo", "/cwd", PathClass::Posix).unwrap(),
            "/cwd/foo"
        );
    }

    #[test]
    fn test_canonicalize_dotdot() {
        assert_eq!(
            canonicalize_path("foo/../bar", "/cwd", PathClass::Posix).unwrap(),
            "/cwd/bar"
        );
        assert_eq!(
            canonicalize_path("../bar", "/cwd/sub", PathClass::Posix).unwrap(),
            "/cwd/bar"
        );
    }

    #[test]
    fn test_canonicalize_already_absolute() {
        assert_eq!(
            canonicalize_path("/foo/bar", "/cwd", PathClass::Posix).unwrap(),
            "/foo/bar"
        );
    }

    #[test]
    fn test_is_absolute_non_ascii_win32() {
        // Regression: `path[..2]` used to panic on a multi-byte first char
        // (non-ASCII relative path) in the Win32 branch.
        assert!(!is_absolute("中文路径/文件", PathClass::Win32));
        assert!(!is_absolute("日本語", PathClass::Win32));
        assert!(is_absolute("C:/foo", PathClass::Win32));
        assert!(is_absolute("/foo", PathClass::Win32));
        assert!(!is_absolute("foo", PathClass::Win32));
    }

    #[test]
    fn test_is_within_directory_exact() {
        assert!(is_within_directory(
            "/workspace/file",
            "/workspace",
            PathClass::Posix
        ));
    }

    #[test]
    fn test_is_within_directory_descendant() {
        assert!(is_within_directory(
            "/workspace/sub/file",
            "/workspace",
            PathClass::Posix
        ));
    }

    #[test]
    fn test_is_within_directory_shared_prefix_escape() {
        assert!(!is_within_directory(
            "/workspace-evil",
            "/workspace",
            PathClass::Posix
        ));
        assert!(!is_within_directory(
            "/workspace/sub/../../../etc/passwd",
            "/workspace",
            PathClass::Posix
        ));
    }

    #[test]
    fn test_is_within_directory_win32_case() {
        assert!(is_within_directory(
            "C:/Workspace/File",
            "c:/workspace",
            PathClass::Win32
        ));
    }

    #[test]
    fn test_canonicalize_win32_unc_preserved() {
        // Regression: `\\server\share\file` used to be collapsed to the
        // single-separator form `\server\share\file` (drive-relative),
        // silently relocating UNC/NAS workspace paths to the current drive.
        assert_eq!(
            canonicalize_path("\\\\server\\share\\file", "/cwd", PathClass::Win32).unwrap(),
            "\\\\server\\share\\file"
        );
        assert_eq!(
            canonicalize_path("//server/share/file", "/cwd", PathClass::Win32).unwrap(),
            "\\\\server\\share\\file"
        );
        // Verbatim paths keep their double-separator root too.
        assert_eq!(
            canonicalize_path("\\\\?\\C:\\very\\long\\path", "/cwd", PathClass::Win32).unwrap(),
            "\\\\?\\C:\\very\\long\\path"
        );
        // Drive paths still collapse to a single separator.
        assert_eq!(
            canonicalize_path("C:/workspace/./a/../b", "/cwd", PathClass::Win32).unwrap(),
            "C:\\workspace\\b"
        );
    }

    #[test]
    fn test_is_within_directory_win32_unc() {
        let candidate = "\\\\server\\share\\work\\file";
        let base = "\\\\server\\share\\work";
        assert!(is_within_directory(candidate, base, PathClass::Win32));
        assert!(!is_within_directory(
            "\\\\server\\shared\\file",
            base,
            PathClass::Win32
        ));
    }

    #[test]
    fn test_canonicalize_untouched_pass() {
        assert_eq!(
            canonicalize_path("//server", "/cwd", PathClass::Win32).unwrap(),
            "\\\\server"
        );
        assert_eq!(
            canonicalize_path("/cwd", "/cwd", PathClass::Posix).unwrap(),
            "/cwd"
        );
    }

    #[test]
    fn test_canonicalize_for_glob_match() {
        // Plain canonicalize (no glob chars) — behaves same for both.
        assert_eq!(
            canonicalize_path("./src/**", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/**"
        );
        assert_eq!(
            canonicalize_path("/workspace/src/a.ts", "/workspace", PathClass::Posix).unwrap(),
            "/workspace/src/a.ts"
        );
    }

    #[test]
    fn test_is_within_workspace_multi_root() {
        let roots = vec!["/primary".to_string(), "/secondary".to_string()];
        assert!(is_within_workspace(
            "/primary/file",
            &roots,
            PathClass::Posix
        ));
        assert!(is_within_workspace(
            "/secondary/file",
            &roots,
            PathClass::Posix
        ));
        assert!(!is_within_workspace(
            "/other/file",
            &roots,
            PathClass::Posix
        ));
    }

    // ── enforce_path_access ────────────────────────────────────────────────

    fn ws() -> Vec<String> {
        vec!["/workspace".to_string()]
    }

    #[test]
    fn test_gate_refuses_sensitive_inside_workspace() {
        // v2 `path-access.ts:327-335`: the sensitive check runs before the
        // containment check, so a `.env` *inside* the workspace is still
        // refused. This is the regression the gate was added for — the model
        // was told sensitive files "are refused" while nothing refused them.
        let err = enforce_path_access(
            "/workspace/.env",
            "/workspace/.env",
            true,
            &ws(),
            PathClass::Posix,
            PathAccessOperation::Read,
            &WorkspaceAccessPolicy::default(),
        )
        .unwrap_err();
        assert_eq!(err.code, PathSecurityCode::Sensitive);
        assert_eq!(
            err.message,
            "\"/workspace/.env\" matches a sensitive-file pattern \
             (env / credential / SSH key). Access is blocked to protect secrets."
        );
    }

    #[test]
    fn test_gate_sensitive_matches_v2_shapes() {
        for path in [
            "/workspace/.env",
            "/workspace/.env.local",
            "/workspace/.ssh/id_rsa",
            "/workspace/.aws/credentials",
        ] {
            let err = enforce_path_access(
                path,
                path,
                true,
                &ws(),
                PathClass::Posix,
                PathAccessOperation::Read,
                &WorkspaceAccessPolicy::default(),
            )
            .unwrap_err();
            assert_eq!(err.code, PathSecurityCode::Sensitive, "{path}");
        }
    }

    #[test]
    fn test_gate_honours_sensitive_exemptions() {
        // v2 `ENV_EXEMPTIONS` + `PUBLIC_KEY_BASENAMES` stay readable.
        for path in [
            "/workspace/.env.example",
            "/workspace/.env.template",
            "/workspace/.ssh/id_rsa.pub",
        ] {
            let outside = enforce_path_access(
                path,
                path,
                true,
                &ws(),
                PathClass::Posix,
                PathAccessOperation::Read,
                &WorkspaceAccessPolicy::default(),
            )
            .unwrap_or_else(|e| panic!("{path} must not be refused: {}", e.message));
            assert!(!outside, "{path}");
        }
    }

    #[test]
    fn test_gate_refuses_relative_path_outside_workspace() {
        // v2 `path-access.ts:337-352`, `guardMode: absolute-outside-allowed`:
        // only the *relative* spelling is rejected. `../..` escapes the root,
        // and a relative path is the only way the model wrote it.
        let err = enforce_path_access(
            "../../etc/passwd",
            "/etc/passwd",
            false,
            &ws(),
            PathClass::Posix,
            PathAccessOperation::Read,
            &WorkspaceAccessPolicy::default(),
        )
        .unwrap_err();
        assert_eq!(err.code, PathSecurityCode::OutsideWorkspace);
        assert_eq!(
            err.message,
            "\"../../etc/passwd\" is not an absolute path. \
             You must provide an absolute path to read a file outside the working directory."
        );
    }

    #[test]
    fn test_gate_absolute_path_outside_workspace_is_allowed() {
        // The same target spelled absolutely is fine — v2 allows it and routes
        // it through the permission layer instead.
        let outside = enforce_path_access(
            "/etc/passwd",
            "/etc/passwd",
            true,
            &ws(),
            PathClass::Posix,
            PathAccessOperation::Read,
            &WorkspaceAccessPolicy::default(),
        )
        .expect("absolute outside path is allowed by the gate");
        assert!(outside);
    }

    #[test]
    fn test_gate_write_and_search_verbs() {
        let err = |op| {
            enforce_path_access(
                "../x",
                "/x",
                false,
                &ws(),
                PathClass::Posix,
                op,
                &WorkspaceAccessPolicy::default(),
            )
            .unwrap_err()
            .message
        };
        assert!(err(PathAccessOperation::Write).ends_with(
            "You must provide an absolute path to write or edit a file outside the working directory."
        ));
        assert!(err(PathAccessOperation::Search).ends_with(
            "You must provide an absolute path to search outside the working directory."
        ));
    }

    #[test]
    fn test_gate_additional_dirs_count_as_inside() {
        // `additionalDirs` are host-authorized roots, so a relative path that
        // resolves into one is not "outside" and is not refused.
        let roots = vec!["/workspace".to_string(), "/srv/data".to_string()];
        let outside = enforce_path_access(
            "../srv/data/file.txt",
            "/srv/data/file.txt",
            false,
            &roots,
            PathClass::Posix,
            PathAccessOperation::Read,
            &WorkspaceAccessPolicy::default(),
        )
        .expect("additionalDirs root is inside");
        assert!(!outside);
    }

    #[test]
    fn test_gate_search_policy_does_not_refuse_sensitive() {
        // v2 Grep/Glob pass `checkSensitive: false` and filter results
        // instead. The gate must not refuse the call for them.
        let outside = enforce_path_access(
            "/workspace/.env",
            "/workspace/.env",
            true,
            &ws(),
            PathClass::Posix,
            PathAccessOperation::Search,
            &WorkspaceAccessPolicy::SEARCH,
        )
        .expect("search policy leaves the sensitive check to result filtering");
        assert!(!outside);
    }

    #[test]
    fn test_gate_disabled_mode_skips_containment() {
        let policy = WorkspaceAccessPolicy {
            guard_mode: GuardMode::Disabled,
            check_sensitive: true,
        };
        let outside = enforce_path_access(
            "../x",
            "/x",
            false,
            &ws(),
            PathClass::Posix,
            PathAccessOperation::Read,
            &policy,
        )
        .expect("disabled guard mode refuses nothing");
        assert!(outside);
    }

    #[test]
    fn test_gate_sensitive_precedes_outside_workspace() {
        // Both rules match; v2 checks `checkSensitive` first, so the sensitive
        // code and message win. The model must not learn the workspace layout
        // from a path it was not allowed to read.
        let err = enforce_path_access(
            "../.env",
            "/other/.env",
            false,
            &ws(),
            PathClass::Posix,
            PathAccessOperation::Read,
            &WorkspaceAccessPolicy::default(),
        )
        .unwrap_err();
        assert_eq!(err.code, PathSecurityCode::Sensitive);
    }
}
