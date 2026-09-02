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
