use std::path::Path;
use tokio::process::Command;

pub async fn git(cwd: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .args(args)
        .current_dir(cwd)
        .output()
        .await
        .map_err(|e| format!("failed to spawn git: {e}"))?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
        let msg = if stderr.is_empty() {
            "unknown git error".to_string()
        } else {
            stderr
        };
        return Err(format!("git {} failed: {msg}", args.join(" ")));
    }

    Ok(String::from_utf8_lossy(&output.stdout)
        .trim_end()
        .to_string())
}

pub async fn try_git(cwd: &Path, args: &[&str]) -> Option<String> {
    git(cwd, args).await.ok()
}

pub async fn is_inside_repo(cwd: &Path) -> bool {
    try_git(cwd, &["rev-parse", "--is-inside-work-tree"])
        .await
        .as_deref()
        == Some("true")
}

pub async fn has_any_commit(cwd: &Path) -> bool {
    try_git(cwd, &["rev-list", "-n", "1", "--all"])
        .await
        .is_some()
}

pub async fn current_branch(cwd: &Path) -> Result<String, String> {
    let branch = git(cwd, &["rev-parse", "--abbrev-ref", "HEAD"]).await?;
    if branch == "HEAD" {
        return Err("cannot determine base branch from a detached HEAD".into());
    }
    Ok(branch)
}

pub async fn branch_tip(cwd: &Path, ref_name: &str) -> Result<String, String> {
    git(cwd, &["rev-parse", ref_name]).await
}

pub async fn branch_exists(cwd: &Path, branch: &str) -> bool {
    let ref_name = format!("refs/heads/{branch}");
    try_git(cwd, &["show-ref", "--verify", "--quiet", &ref_name])
        .await
        .is_some()
}

/// Whether `maybe_ancestor` is an ancestor of `ref_name` (v2 `isAncestor`):
/// `git merge-base --is-ancestor A B` exits 0 when it is, 1 when it is not.
///
/// A third outcome exists — any other non-zero exit (unknown ref, shallow
/// clone missing the object, unreadable repo) plus a failure to spawn git — and
/// it is NOT "not an ancestor". The completion gate picks its diff base from
/// this answer, so folding an error into `false` would silently re-base the
/// check onto the tower base. Errors propagate instead, and the caller refuses.
pub async fn is_ancestor(cwd: &Path, maybe_ancestor: &str, ref_name: &str) -> Result<bool, String> {
    let output = Command::new("git")
        .args(["merge-base", "--is-ancestor", maybe_ancestor, ref_name])
        .current_dir(cwd)
        .output()
        .await
        .map_err(|error| {
            format!("git merge-base --is-ancestor {maybe_ancestor} {ref_name} failed: {error}")
        })?;
    match output.status.code() {
        Some(0) => Ok(true),
        Some(1) => Ok(false),
        _ => {
            let detail = String::from_utf8_lossy(&output.stderr).trim().to_string();
            Err(format!(
                "git merge-base --is-ancestor {maybe_ancestor} {ref_name} could not decide (status {:?}): {detail}",
                output.status.code()
            ))
        }
    }
}

pub async fn worktree_add(cwd: &Path, path: &Path, branch: &str, base: &str) -> Result<(), String> {
    let path_str = path.to_str().ok_or("invalid path")?;
    if branch_exists(cwd, branch).await {
        git(cwd, &["worktree", "add", path_str, branch]).await?;
    } else {
        git(cwd, &["worktree", "add", path_str, "-b", branch, base]).await?;
    }
    Ok(())
}

pub async fn worktree_remove(cwd: &Path, path: &Path) -> Result<(), String> {
    let path_str = path.to_str().ok_or("invalid path")?;
    // Idempotent teardown (v2 #3648): a worktree git no longer knows about is
    // reported as already removed instead of failing the whole teardown.
    if !path.exists() {
        let prunable = try_git(cwd, &["worktree", "list", "--porcelain"]).await;
        let known = prunable.as_deref().is_some_and(|out| {
            out.split('\n').any(|line| {
                line.strip_prefix("worktree ")
                    .is_some_and(|wt| wt.trim() == path_str)
            })
        });
        if !known {
            return Ok(());
        }
    }
    git(cwd, &["worktree", "remove", "--force", path_str]).await?;
    Ok(())
}

pub async fn is_worktree_dirty(path: &Path) -> bool {
    let status = try_git(path, &["status", "--porcelain"]).await;
    status.is_some_and(|s| !s.trim().is_empty())
}

pub async fn merge_no_ff(cwd: &Path, branch: &str) -> Result<String, String> {
    git(cwd, &["merge", "--no-ff", branch]).await?;
    branch_tip(cwd, "HEAD").await
}

pub async fn diff_name_only(cwd: &Path, base: &str, ref_name: &str) -> Result<Vec<String>, String> {
    let range = format!("{base}...{ref_name}");
    let out = git(cwd, &["diff", "--name-only", &range]).await?;
    let files = out
        .lines()
        .map(|l| l.trim().to_string())
        .filter(|l| !l.is_empty())
        .collect();
    Ok(files)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The three outcomes of `merge-base --is-ancestor` are three different
    /// answers. Exit 1 is a real "no"; anything else is a git failure the
    /// completion gate must not read as "no" — it would silently judge the
    /// mission's diff against the tower base instead of its spawn base.
    #[tokio::test]
    async fn is_ancestor_separates_no_from_a_git_failure() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]).await.unwrap();
        let _ = git(root, &["config", "user.email", "t@e.test"]).await;
        let _ = git(root, &["config", "user.name", "t"]).await;
        std::fs::write(root.join("f.txt"), "base").unwrap();
        git(root, &["add", "."]).await.unwrap();
        git(root, &["commit", "-qm", "init"]).await.unwrap();
        let base = git(root, &["rev-parse", "HEAD"]).await.unwrap();
        git(root, &["branch", "feat/x"]).await.unwrap();
        // Advance the branch so the base is a strict ancestor.
        git(root, &["checkout", "-q", "feat/x"]).await.unwrap();
        std::fs::write(root.join("f.txt"), "work").unwrap();
        git(root, &["add", "."]).await.unwrap();
        git(root, &["commit", "-qm", "work"]).await.unwrap();

        assert_eq!(
            is_ancestor(root, &base, "feat/x").await,
            Ok(true),
            "a real ancestor is Ok(true)"
        );
        assert_eq!(
            is_ancestor(root, "feat/x", &base).await,
            Ok(false),
            "exit 1 is a real 'not an ancestor', not an error"
        );
        assert!(
            is_ancestor(root, "no-such-ref", "feat/x").await.is_err(),
            "an unknown ref must surface as an error, not Ok(false)"
        );
        assert!(
            is_ancestor(root, &base, "also-missing").await.is_err(),
            "an unknown target must surface as an error too"
        );
    }

    /// Idempotent teardown (v2 #3648): removing a worktree path git no longer
    /// knows about succeeds instead of failing the whole teardown.
    #[tokio::test]
    async fn worktree_remove_succeeds_when_the_path_is_already_gone() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]).await.unwrap();

        let missing = root.join("worktrees/never-created");
        // The path does not exist and git knows no such worktree: the remove
        // is a no-op success.
        assert!(!missing.exists());
        worktree_remove(root, &missing).await.unwrap();
    }

    #[tokio::test]
    async fn worktree_remove_still_fails_on_a_live_worktree_with_changes() {
        let dir = tempfile::tempdir().unwrap();
        let root = dir.path();
        git(root, &["init", "-q"]).await.unwrap();
        let _ = git(root, &["config", "user.email", "t@e.test"]).await;
        let _ = git(root, &["config", "user.name", "t"]).await;
        std::fs::write(root.join("f.txt"), "base").unwrap();
        git(root, &["add", "."]).await.unwrap();
        git(root, &["commit", "-qm", "init"]).await.unwrap();
        // The default branch may be master or main depending on git config;
        // resolve it instead of assuming.
        let head = git(root, &["rev-parse", "--abbrev-ref", "HEAD"])
            .await
            .unwrap();

        let wt = root.join("worktrees/wt-a");
        worktree_add(root, &wt, "wt-branch", &head).await.unwrap();
        // A live, clean worktree removes fine.
        worktree_remove(root, &wt).await.unwrap();
        assert!(!wt.exists());
    }
}
