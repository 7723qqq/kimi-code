//! Project-local configuration (`<project-root>/.kimi-code/local.toml`) read
//! surface — the Rust half of the port, for the hosts the TypeScript SDK does
//! not serve (the standalone HTTP server behind `kimi web` and the VS Code
//! extension).
//!
//! Ported from v2's `FileProjectLocalConfigService`
//! (`agent-core-v2/src/persistence/backends/node-fs/projectLocalConfigService.ts`),
//! which `WorkspaceDirsService` consumed through
//! `IProjectLocalConfigService.readAdditionalDirs`. The rules are the same ones
//! `packages/node-sdk/src/project-local-config.ts` applies for the TUI/CLI
//! host — one implementation per host, because the two runtimes cannot share
//! code — and the test tables mirror each other on purpose.
//!
//! `workspace.additional_dir` widens the roots a session may touch, so every
//! entry must exist and must be a directory. The engine does **not** gate the
//! read on workspace trust: upstream #4013 rolled back the `IWorkspaceTrust`
//! gate #3964 had wrapped around `WorkspaceDirsService.reloadFromDisk`
//! ("once a user trusts a repository, content inside it is the user's own
//! responsibility"), so the file applies whether or not the workspace is
//! marked trusted. The home-directory / filesystem-root rejection went the
//! same way — v2's `resolvePath` is a purely lexical resolve plus an
//! `isDirectory` check.
//!
//! Only the read face is ported. The write face (`/add-dir … remember`) belongs
//! to the host that owns the `/add-dir` command, which is the TypeScript one.
use std::path::{Path, PathBuf};

/// Where the project's config lives, whether or not the file exists.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProjectAdditionalDirsLocation {
    pub project_root: PathBuf,
    pub config_path: PathBuf,
}

const CONFIG_INVALID: &str = "config.invalid";
const NOT_A_DIRECTORY_ERROR: &str = "workspace.additional_dir must exist and be a directory";
const NOT_STRINGS_ERROR: &str = "workspace.additional_dir must be an array of strings";

/// Walk up from `work_dir` to the nearest directory holding `.git` (a directory
/// in a clone, a file in a worktree); fall back to `work_dir` itself.
pub fn locate_additional_dirs_config(work_dir: &Path) -> ProjectAdditionalDirsLocation {
    let initial = work_dir.to_path_buf();
    let mut current = initial.clone();
    loop {
        if current.join(".git").exists() {
            break;
        }
        match current.parent() {
            Some(parent) if parent != current => current = parent.to_path_buf(),
            _ => {
                current = initial.clone();
                break;
            }
        }
    }
    ProjectAdditionalDirsLocation {
        config_path: current.join(".kimi-code").join("local.toml"),
        project_root: current,
    }
}

/// The project's extra roots, resolved and validated. An absent file is not an
/// error — it simply contributes nothing.
pub fn read_additional_dirs(work_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let location = locate_additional_dirs_config(work_dir);
    let Some(dirs) = read_configured_dirs(&location.config_path)? else {
        return Ok(Vec::new());
    };
    resolve_additional_dirs(&location.project_root, &dirs)
}

/// Raw `workspace.additional_dir` entries, or `None` when the file or the table
/// is absent.
fn read_configured_dirs(config_path: &Path) -> Result<Option<Vec<String>>, String> {
    let text = match std::fs::read_to_string(config_path) {
        Ok(text) => text,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("failed to read {}: {error}", config_path.display())),
    };
    if text.trim().is_empty() {
        return Ok(None);
    }
    let raw: toml::Value = toml::from_str(&text).map_err(|error| {
        format!(
            "{CONFIG_INVALID}: Invalid TOML in {} ({error})",
            config_path.display()
        )
    })?;
    let Some(workspace) = raw.get("workspace") else {
        return Ok(None);
    };
    let Some(workspace) = workspace.as_table() else {
        return Err(format!("{CONFIG_INVALID}: workspace must be a table"));
    };
    let Some(additional_dir) = workspace.get("additional_dir") else {
        return Ok(None);
    };
    let Some(entries) = additional_dir.as_array() else {
        return Err(format!("{CONFIG_INVALID}: {NOT_STRINGS_ERROR}"));
    };
    let mut dirs = Vec::with_capacity(entries.len());
    for entry in entries {
        let Some(dir) = entry.as_str() else {
            return Err(format!("{CONFIG_INVALID}: {NOT_STRINGS_ERROR}"));
        };
        dirs.push(dir.to_string());
    }
    Ok(Some(dirs))
}

/// Resolve raw entries against `project_root` into absolute, deduplicated
/// roots, refusing anything that is not an existing directory.
pub fn resolve_additional_dirs(
    project_root: &Path,
    additional_dirs: &[String],
) -> Result<Vec<PathBuf>, String> {
    let mut resolved_dirs: Vec<PathBuf> = Vec::new();
    for entry in additional_dirs {
        let resolved = resolve_additional_dir(project_root, entry)?;
        if resolved_dirs.iter().any(|dir| same_dir(dir, &resolved)) {
            continue;
        }
        resolved_dirs.push(resolved);
    }
    Ok(resolved_dirs)
}

fn resolve_additional_dir(project_root: &Path, entry: &str) -> Result<PathBuf, String> {
    let trimmed = entry.trim();
    if trimmed.is_empty() {
        return Err(format!("{CONFIG_INVALID}: {NOT_A_DIRECTORY_ERROR}"));
    }
    let expanded = expand_home(trimmed);
    let expanded = Path::new(&expanded);
    let resolved = if expanded.is_absolute() {
        normalize(expanded)
    } else {
        normalize(&project_root.join(expanded))
    };
    if !resolved.is_dir() {
        return Err(format!("{CONFIG_INVALID}: {NOT_A_DIRECTORY_ERROR}"));
    }
    Ok(resolved)
}

/// Same-directory comparison in the platform's path class: Windows paths are
/// case-insensitive, and macOS reports `/tmp` as a symlink to `/private/tmp`
/// only through `canonicalize`, which the caller already did.
fn same_dir(left: &Path, right: &Path) -> bool {
    let class = if cfg!(windows) {
        crate::native::path_access::PathClass::Win32
    } else {
        crate::native::path_access::PathClass::Posix
    };
    crate::native::path_access::is_within_directory(
        &left.to_string_lossy(),
        &right.to_string_lossy(),
        class,
    ) && crate::native::path_access::is_within_directory(
        &right.to_string_lossy(),
        &left.to_string_lossy(),
        class,
    )
}

fn normalize(path: &Path) -> PathBuf {
    let normalized = lexical_normalize(path);
    match std::fs::canonicalize(&normalized) {
        // `canonicalize` returns a verbatim (`\\?\C:\…`) path on Windows; strip
        // the prefix so the root reads and compares like every other path the
        // engine reports.
        Ok(real) => crate::tools::strip_verbatim_prefix(real),
        // A not-yet-created path keeps its lexical shape; the caller decides
        // whether that is acceptable (here: it is not, and says so).
        Err(_) => normalized,
    }
}

fn lexical_normalize(path: &Path) -> PathBuf {
    // `Path::components` drops `.` and folds `..` without touching the disk.
    let mut out = PathBuf::new();
    for component in path.components() {
        match component {
            std::path::Component::CurDir => {}
            std::path::Component::ParentDir => {
                out.pop();
            }
            other => out.push(other.as_os_str()),
        }
    }
    out
}

fn expand_home(value: &str) -> String {
    let Some(home) = crate::tools::user_home_dir() else {
        return value.to_string();
    };
    if value == "~" {
        return home.to_string_lossy().into_owned();
    }
    if let Some(rest) = value
        .strip_prefix("~/")
        .or_else(|| value.strip_prefix(r"~\"))
    {
        return home.join(rest).to_string_lossy().into_owned();
    }
    value.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A checkout: `<root>/.git` marks the project root, with a `packages/app`
    /// working directory below it.
    fn project() -> (tempfile::TempDir, PathBuf, PathBuf) {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path().join("project");
        let work_dir = root.join("packages").join("app");
        std::fs::create_dir_all(root.join(".git")).unwrap();
        std::fs::create_dir_all(&work_dir).unwrap();
        (dir, root, work_dir)
    }

    fn write_config(root: &Path, body: &str) {
        std::fs::create_dir_all(root.join(".kimi-code")).unwrap();
        std::fs::write(root.join(".kimi-code").join("local.toml"), body).unwrap();
    }

    #[test]
    fn finds_the_project_root_by_walking_up_to_dot_git() {
        let (_dir, root, work_dir) = project();
        let located = locate_additional_dirs_config(&work_dir);
        assert_eq!(located.project_root, root);
        assert_eq!(
            located.config_path,
            root.join(".kimi-code").join("local.toml")
        );
    }

    #[test]
    fn falls_back_to_the_working_directory_without_a_checkout() {
        let dir = tempfile::tempdir().unwrap();
        let located = locate_additional_dirs_config(dir.path());
        assert_eq!(located.project_root, dir.path());
    }

    #[test]
    fn resolves_relative_entries_against_the_project_root() {
        let (_dir, root, work_dir) = project();
        std::fs::create_dir_all(root.join("shared")).unwrap();
        write_config(
            &root,
            "[workspace]\nadditional_dir = [\"shared\", \"nested/../shared\"]\n",
        );
        let dirs = read_additional_dirs(&work_dir).unwrap();
        assert_eq!(dirs.len(), 1, "the two spellings name one directory");
        assert!(dirs[0].ends_with("shared"));
    }

    #[test]
    fn an_absent_file_or_table_contributes_nothing() {
        let (_dir, _root, work_dir) = project();
        assert!(read_additional_dirs(&work_dir).unwrap().is_empty());
        let (_dir, root, work_dir) = project();
        write_config(&root, "[tools]\nverbose = true\n");
        assert!(read_additional_dirs(&work_dir).unwrap().is_empty());
    }

    /// Post-revert v2 (`resolvePath`, upstream #4013) resolves entries
    /// lexically and only checks that they exist as directories: the
    /// home-directory / filesystem-root rejection that #3964 added is gone, so
    /// `~` is a legal `additional_dir` again.
    #[test]
    fn accepts_broad_scope_entries_and_refuses_non_directories() {
        let (_dir, root, _work_dir) = project();
        let home = crate::tools::user_home_dir().expect("a home directory");
        let resolved = resolve_additional_dirs(&root, &[home.to_string_lossy().into_owned()])
            .expect("the home directory is a legal extra root again");
        assert_eq!(resolved.len(), 1);

        let file = root.join("notes.txt");
        std::fs::write(&file, "x").unwrap();
        let err =
            resolve_additional_dirs(&root, &[file.to_string_lossy().into_owned()]).unwrap_err();
        assert!(err.contains(NOT_A_DIRECTORY_ERROR), "{err}");

        let broad = root.join("broad");
        std::fs::create_dir_all(&broad).unwrap();
        let err = resolve_additional_dirs(
            &root,
            &[broad.join("absent").to_string_lossy().into_owned()],
        )
        .unwrap_err();
        assert!(err.contains(NOT_A_DIRECTORY_ERROR), "{err}");
    }

    #[test]
    fn reports_malformed_documents_as_config_errors() {
        let (_dir, root, work_dir) = project();
        write_config(&root, "[workspace\n");
        let err = read_additional_dirs(&work_dir).unwrap_err();
        assert!(err.contains("Invalid TOML"), "{err}");

        write_config(&root, "[workspace]\nadditional_dir = 3\n");
        let err = read_additional_dirs(&work_dir).unwrap_err();
        assert!(err.contains(NOT_STRINGS_ERROR), "{err}");

        write_config(&root, "[workspace]\nadditional_dir = [1]\n");
        let err = read_additional_dirs(&work_dir).unwrap_err();
        assert!(err.contains(NOT_STRINGS_ERROR), "{err}");

        write_config(&root, "workspace = 3\n");
        let err = read_additional_dirs(&work_dir).unwrap_err();
        assert!(err.contains("workspace must be a table"), "{err}");
    }
}
