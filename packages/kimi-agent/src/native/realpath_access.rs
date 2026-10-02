//! Realpath-backed symlink containment, the second half of v2's path gate.
//!
//! v2 splits the gate in two. [`super::path_access`] decides the *policy*
//! lexically — normalize, expand `~`, compare against the workspace roots, and
//! refuse a sensitive file or a relative escape. That half is pure and touches
//! no filesystem, so a refused path is never even stat'ed.
//!
//! This half closes what a lexical decision structurally cannot see: a symlink
//! whose *name* is innocuous and whose *target* is not. `notes.txt -> .env`
//! passes every lexical test, and so does a link that points out of the
//! workspace entirely. Upstream has no `tool/realpath-access.ts`; the equivalent
//! is inline in `workspace/workspaceFs/fsService.ts:1116-1165` —
//! `realpathExistingPrefix` (`:1116`) plus the `symlink_outside` refusal inside
//! `resolveWithin` (`:1157-1163`).
//!
//! Three things are refused here that the lexical half cannot catch:
//!
//!   - a symlink whose target does not exist (a dangling link — the lexical pass
//!     has no target to look at). **Fork-original:** upstream's
//!     `realpathExistingPrefix` does *not* refuse a dangling link — it climbs to
//!     the nearest existing ancestor and, failing that, returns the input path
//!     unchanged; only the `symlink_outside` case throws. Refusing here is this
//!     fork's own fail-closed reading, not a ported rule;
//!   - a link that resolves to a sensitive file, even under an innocent name;
//!   - a link that resolves outside the real workspace roots.
//!
//! Writes add a fourth, also **fork-original**: a link that lands on the
//! project-local config, because the write must go through the approval that
//! guards that file rather than arriving by a side door.
//!
//! The resolution walk mirrors v2's `realpathExistingPrefix`: climb toward the
//! filesystem root until `realpath` succeeds, then re-join whatever tail did not
//! exist yet, so a not-yet-created write target still resolves. The climb is
//! bounded; a path that never resolves is refused rather than trusted.

use std::path::{Path, PathBuf};

use super::file_type::is_sensitive_file;
use super::path_access::{PathClass, PathSecurityError, is_within_directory, is_within_workspace};

/// How far up the tree the resolution walk will climb before giving up. v2
/// uses the same bound; a path this deep is not something to trust on faith.
const MAX_RESOLUTION_DEPTH: usize = 256;

/// A filesystem entry that exists but whose `realpath` failed is a symlink with
/// a missing target. Refusing is the fail-closed reading: the lexical half
/// cannot see where it points, and neither can we.
fn existing_but_unresolvable(path: &Path) -> bool {
    std::fs::symlink_metadata(path).is_ok()
}

/// Resolve `abs_path` to a real path, tolerating a tail that does not exist yet.
///
/// Climbs to the nearest existing ancestor, resolves that, then re-joins the
/// missing tail. Returns `Err` for a dangling symlink or a path too deep to
/// resolve — both are refusals, not fallbacks.
pub fn realpath_existing_prefix(abs_path: &Path) -> Result<PathBuf, PathSecurityError> {
    let mut tail: Vec<std::ffi::OsString> = Vec::new();
    let mut current = abs_path.to_path_buf();
    for _ in 0..MAX_RESOLUTION_DEPTH {
        match std::fs::canonicalize(&current) {
            Ok(real) => {
                let mut resolved = real;
                for part in tail.iter().rev() {
                    resolved.push(part);
                }
                return Ok(resolved);
            }
            Err(_) => {
                if existing_but_unresolvable(&current) {
                    return Err(PathSecurityError::symlink_escape(
                        &current.to_string_lossy(),
                        &current.to_string_lossy(),
                        format!(
                            "\"{}\" is a symbolic link whose target does not exist. Access is blocked.",
                            current.to_string_lossy()
                        ),
                    ));
                }
                let Some(parent) = current.parent().map(Path::to_path_buf) else {
                    break;
                };
                let Some(name) = current.file_name().map(std::ffi::OsString::from) else {
                    break;
                };
                if parent == current {
                    break;
                }
                tail.push(name);
                current = parent;
            }
        }
    }
    Err(PathSecurityError::symlink_escape(
        &abs_path.to_string_lossy(),
        &abs_path.to_string_lossy(),
        format!(
            "\"{}\" is too deep to resolve to a real path. Access is blocked.",
            abs_path.to_string_lossy()
        ),
    ))
}

/// Whether a path is the project-local config file, whose writes are gated by
/// the workspace-trust prompt. Mirrors v2 `isProjectLocalConfigPath`
/// (`path-access.ts:193` at the newer v2): a plain suffix test, compared in
/// lower case with both separators normalized, so the spelling does not depend
/// on which side of the fence it was written.
pub fn is_project_local_config_path(path: &str) -> bool {
    path.replace('\\', "/")
        .to_lowercase()
        .ends_with("/.kimi-code/local.toml")
}

/// The real workspace roots, each resolved when it can be. A root that does not
/// resolve is compared lexically, which is the weaker but non-failing reading.
fn real_roots(roots: &[String]) -> Vec<PathBuf> {
    roots
        .iter()
        .map(|root| std::fs::canonicalize(root).unwrap_or_else(|_| PathBuf::from(root)))
        .collect()
}

/// Resolve a path through symlinks and refuse it when the *target* is
/// sensitive or — only for a link that claims to be inside — when the target
/// lands outside the real workspace roots.
///
/// `check_sensitive: false` is the search policy, matching how
/// [`super::path_access::WorkspaceAccessPolicy::SEARCH`] turns the check off
/// for Grep and Glob: those tools filter sensitive hits out of their results
/// rather than refusing the call, and this half must not start refusing for
/// them either.
///
/// The two branches are v2's (`assertRealPathWithinWorkspace`,
/// `realpath-access.ts:97-137`) and the asymmetry is deliberate. A path that is
/// already lexically outside the workspace gets its sensitive pattern checked
/// and is then **handed back unchanged**: the caller named an absolute path
/// outside, said where it was going, and the permission layer still judges it.
/// Demanding the target also be inside would refuse ordinary absolute reads
/// and writes, which v2 allows. The escape check is for the other case — a path
/// that looks like it is inside and is not.
pub fn assert_real_path_within_workspace(
    abs_path: &Path,
    workspace_roots: &[String],
    path_class: PathClass,
    check_sensitive: bool,
) -> Result<PathBuf, PathSecurityError> {
    let raw = abs_path.to_string_lossy().into_owned();

    if !is_within_workspace(&raw, workspace_roots, path_class) {
        let resolved = realpath_existing_prefix(abs_path)?;
        if check_sensitive && is_sensitive_file(&resolved.to_string_lossy()) {
            return Err(PathSecurityError::symlink_sensitive(
                &raw,
                &resolved.to_string_lossy(),
            ));
        }
        return Ok(abs_path.to_path_buf());
    }

    let resolved = realpath_existing_prefix(abs_path)?;
    let resolved_str = resolved.to_string_lossy().into_owned();

    if check_sensitive && is_sensitive_file(&resolved_str) {
        return Err(PathSecurityError::symlink_sensitive(&raw, &resolved_str));
    }

    let real_roots = real_roots(workspace_roots);
    let contained = real_roots
        .iter()
        .any(|root| is_within_directory(&resolved_str, &root.to_string_lossy(), path_class));
    if contained {
        return Ok(resolved);
    }
    Err(PathSecurityError::symlink_escape(
        &raw,
        &resolved_str,
        format!(
            "\"{raw}\" resolves to \"{resolved_str}\" through a symbolic link that points \
             outside the working directory. Access is blocked; use the real path directly \
             or add the target directory to the workspace."
        ),
    ))
}

/// The write-target form: everything the read form refuses, plus a link that
/// lands on the project-local config — that file's writes are gated by the
/// workspace-trust prompt, and arriving through a symlink would walk past it.
pub fn assert_real_path_write_target(
    abs_path: &Path,
    workspace_roots: &[String],
    path_class: PathClass,
) -> Result<PathBuf, PathSecurityError> {
    let resolved = assert_real_path_within_workspace(abs_path, workspace_roots, path_class, true)?;
    let resolved_str = resolved.to_string_lossy();
    if !is_project_local_config_path(&abs_path.to_string_lossy())
        && is_project_local_config_path(&resolved_str)
    {
        return Err(PathSecurityError::symlink_escape(
            &abs_path.to_string_lossy(),
            &resolved_str,
            format!(
                "\"{}\" resolves to the project-local config \"{resolved_str}\" through a \
                 symbolic link. Access is blocked; use the real path so the write goes \
                 through approval.",
                abs_path.to_string_lossy()
            ),
        ));
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::native::path_access::PathSecurityCode;

    /// Create a file symlink, or report that this platform will not allow one.
    /// Windows needs Developer Mode or elevation for `symlink_file`, and a test
    /// that cannot create its subject is not a test that failed — it is a test
    /// that did not run, and says so.
    fn symlink_file(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_file(target, link).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link).is_ok();
        made
    }

    fn symlink_dir(target: &Path, link: &Path) -> bool {
        #[cfg(windows)]
        let made = std::os::windows::fs::symlink_dir(target, link).is_ok();
        #[cfg(unix)]
        let made = std::os::unix::fs::symlink(target, link).is_ok();
        made
    }

    #[test]
    fn an_innocuous_name_over_a_sensitive_file_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let secret = root.path().join(".env");
        std::fs::write(&secret, "SECRET=1\n").unwrap();
        let link = root.path().join("notes.txt");
        if !symlink_file(&secret, &link) {
            eprintln!("skipping: this platform would not create the symlink");
            return;
        }

        // Lexically the link is an ordinary text file in the workspace, so the
        // first gate admits it — which is the whole reason this layer exists.
        assert!(!is_sensitive_file(&link.to_string_lossy()));
        let roots = vec![root.path().to_string_lossy().into_owned()];
        let err =
            assert_real_path_within_workspace(&link, &roots, PathClass::Posix, true).unwrap_err();
        assert_eq!(err.code, PathSecurityCode::Sensitive);
        assert!(
            err.message.contains("resolves to") && err.message.contains(".env"),
            "the message must name both ends: {}",
            err.message
        );
    }

    #[test]
    fn a_link_out_of_the_workspace_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let target = outside.path().join("elsewhere.txt");
        std::fs::write(&target, "x").unwrap();
        let link = root.path().join("shortcut.txt");
        if !symlink_file(&target, &link) {
            eprintln!("skipping: this platform would not create the symlink");
            return;
        }
        let roots = vec![root.path().to_string_lossy().into_owned()];
        let err =
            assert_real_path_within_workspace(&link, &roots, PathClass::Posix, true).unwrap_err();
        assert!(
            err.message.contains("points outside the working directory"),
            "{}",
            err.message
        );
    }

    #[test]
    fn a_link_that_stays_inside_is_followed_and_allowed() {
        let root = tempfile::tempdir().unwrap();
        let real = root.path().join("real.txt");
        std::fs::write(&real, "x").unwrap();
        let link = root.path().join("alias.txt");
        if !symlink_file(&real, &link) {
            eprintln!("skipping: this platform would not create the symlink");
            return;
        }
        let roots = vec![root.path().to_string_lossy().into_owned()];
        let resolved =
            assert_real_path_within_workspace(&link, &roots, PathClass::Posix, true).unwrap();
        assert!(resolved.ends_with("real.txt"), "{}", resolved.display());
    }

    #[test]
    fn a_dangling_link_is_refused_rather_than_followed() {
        let root = tempfile::tempdir().unwrap();
        let missing = root.path().join("gone.txt");
        let link = root.path().join("dangling.txt");
        if !symlink_file(&missing, &link) {
            eprintln!("skipping: this platform would not create the symlink");
            return;
        }
        let roots = vec![root.path().to_string_lossy().into_owned()];
        let err =
            assert_real_path_within_workspace(&link, &roots, PathClass::Posix, true).unwrap_err();
        assert!(
            err.message.contains("target does not exist"),
            "{}",
            err.message
        );
    }

    #[test]
    fn the_search_policy_does_not_refuse_a_sensitive_target() {
        // Grep and Glob turn the sensitive check off and filter results instead;
        // this layer has to honour the same switch or it would start refusing
        // searches the lexical half deliberately lets through.
        let root = tempfile::tempdir().unwrap();
        let secret = root.path().join(".env");
        std::fs::write(&secret, "SECRET=1\n").unwrap();
        let link = root.path().join("notes.txt");
        if !symlink_file(&secret, &link) {
            eprintln!("skipping: this platform would not create the symlink");
            return;
        }
        let roots = vec![root.path().to_string_lossy().into_owned()];
        assert!(
            assert_real_path_within_workspace(&link, &roots, PathClass::Posix, false).is_ok(),
            "the search policy must not refuse on a sensitive target"
        );
    }

    #[test]
    fn a_write_onto_the_project_local_config_through_a_link_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let dir = root.path().join(".kimi-code");
        std::fs::create_dir_all(&dir).unwrap();
        let config = dir.join("local.toml");
        std::fs::write(&config, "").unwrap();
        let link = root.path().join("innocent.toml");
        if !symlink_file(&config, &link) {
            eprintln!("skipping: this platform would not create the symlink");
            return;
        }
        let roots = vec![root.path().to_string_lossy().into_owned()];
        let err = assert_real_path_write_target(&link, &roots, PathClass::Posix).unwrap_err();
        assert!(
            err.message.contains("project-local config"),
            "{}",
            err.message
        );
    }

    #[test]
    fn project_local_config_detection_is_separator_and_case_insensitive() {
        for path in [
            "/ws/.kimi-code/local.toml",
            "/ws/.KIMI-CODE/LOCAL.TOML",
            r"C:\ws\.kimi-code\LOCAL.TOML",
        ] {
            assert!(is_project_local_config_path(path), "{path}");
        }
        for path in [
            "/ws/.kimi-code/other.toml",
            "/ws/local.toml",
            "/ws/x/local.toml.bak",
        ] {
            assert!(!is_project_local_config_path(path), "{path}");
        }
    }

    #[test]
    fn a_missing_write_target_resolves_through_its_existing_ancestor() {
        // Write targets do not exist yet. The walk has to resolve the parent and
        // re-join the new leaf, or every first Write would be refused.
        let root = tempfile::tempdir().unwrap();
        let new_file = root.path().join("brand-new.txt");
        let roots = vec![root.path().to_string_lossy().into_owned()];
        let resolved =
            assert_real_path_within_workspace(&new_file, &roots, PathClass::Posix, true).unwrap();
        assert!(
            resolved.ends_with("brand-new.txt"),
            "{}",
            resolved.display()
        );
    }

    #[test]
    fn a_directory_link_out_of_the_workspace_is_refused() {
        let root = tempfile::tempdir().unwrap();
        let outside = tempfile::tempdir().unwrap();
        let link = root.path().join("escape");
        if !symlink_dir(outside.path(), &link) {
            eprintln!("skipping: this platform would not create the symlink");
            return;
        }
        let roots = vec![root.path().to_string_lossy().into_owned()];
        let child = link.join("file.txt");
        assert!(
            assert_real_path_within_workspace(&child, &roots, PathClass::Posix, true).is_err(),
            "a link chain out of the workspace must be refused"
        );
    }
}
